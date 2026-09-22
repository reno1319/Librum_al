#!/usr/bin/env bash
# ALL-CHECKOUT-1 / K1: two genuinely concurrent calls to the authenticated
# create_book_checkout_intent RPC, for the SAME reader and the SAME book,
# must produce exactly ONE checkout intent.
#
# Why this file has to exist, and why no harness already in this directory
# substitutes for it:
#
#   032_advisory_lock_contention.sh   exercises the raw advisory-lock
#       NAMESPACE -- that two backends taking pg_advisory_xact_lock on the
#       same (reader, book) key serialize at all. It never calls
#       create_book_checkout_intent, so it says nothing about whether THIS
#       function takes that lock, or takes it early enough to matter.
#
#   059_retire_vs_finalize_contention.sh   mints ONE intent during setup on
#       a single connection and then races RETIREMENT against FINALIZATION
#       of that one intent. It never races two mint calls, so the mint
#       path's own serialization is untested there.
#
#   the .test.sql suites   cannot show this at all: a single psql connection
#       cannot hold two overlapping transactions, and the whole hazard here
#       is what a SECOND transaction observes while a first is mid-mint.
#
# The hazard PREDATES ALL-CHECKOUT-1, and so does its defence: the base
# function already took this advisory lock, in this place, for this
# reason. What is new is that this patch DROPS AND RECREATES the whole
# function, so the acquisition and its placement before candidate
# inspection have to be carried across by hand -- and until this file
# existed, nothing in the repository would have noticed if they were
# not. So this harness does not test a new guard; it preserves an old
# one and proves it directly for the first time.
#
# The function decides whether to mint by scanning the reader's open
# intents for this book. If two calls interleave between that scan and
# the INSERT,
# both scan an empty set and both mint -- the reader ends up with two live
# quotes for one book, at which point "the" price of their checkout is
# undefined and a POK order can be attached to the intent that the UI is
# not showing. The defence is a single line near the top of the function:
#
#     perform pg_catalog.pg_advisory_xact_lock(
#       pg_catalog.hashtext(v_reader_id::text),
#       pg_catalog.hashtext(book_id::text));
#
# taken BEFORE the candidate scan, so the second caller cannot even look
# until the first has committed. Two properties have to hold, and they are
# different properties caught by different assertions below:
#
#   1  the lock is acquired AT ALL, on exactly the (reader, book) key;
#   2  it is acquired BEFORE the candidate inspection, not after.
#
# Deleting the acquisition breaks 1. Moving it below the candidate scan
# leaves 1 intact and breaks 2 -- both callers then wait on the lock, both
# having already decided to mint, and the serialization buys nothing. A
# harness that only checked "did they serialize" would pass the second
# mutant, so the outcome invariants are asserted as well.
#
# The race is CONSTRUCTED, never hoped for. A third connection takes the
# exact (reader, book) advisory key by hand and holds it open; the two RPC
# sessions are then started and are required, by a bounded poll of pg_locks
# joined to pg_stat_activity, to BOTH be parked on that exact key before
# the holder is released. Sleeps appear only inside that bounded poll. No
# assertion depends on winning a sleep race, and that is deliberate:
# mutation-testing 059's first draft showed a sleep-timed lock-order probe
# catching its mutant on one run and passing on the next.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/062_all_checkout_intent_contention.sh
# (or pass the database name as $1). ROUNDS=n repeats the whole race.
# Requires psql on PATH and a database carrying the ALL-CHECKOUT-1
# four-argument create_book_checkout_intent. Exits non-zero on any
# deadlock, error, or assertion failure.

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
ROUNDS="${ROUNDS:-3}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

AUTHOR_ID="e0620000-0000-0000-0000-000000000001"
READER_ID="e0620000-0000-0000-0000-000000000002"
BOOK_ID="e0620000-0000-0000-0000-000000000003"

# 99 lek is the minimum permitted paid catalog price, so it is also the
# value that proves the conversion boundary: 99 * 100 = 9900 minor units,
# exactly the floor. price_cents is left at a DELIBERATELY different,
# meaningless number -- if anything in the mint path still reads the legacy
# USD column, the frozen amount will not be 9900 and this harness says so.
PRICE_ALL=99
EXPECT_MINOR=9900
MISLEADING_CENTS=4242

APP_HOLDER="p062_lock_holder"
APP_A="p062_rpc_a"
APP_B="p062_rpc_b"

psql_q() { psql -X -q -t -A -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup_rows_sql() {
  cat <<SQL
delete from public.pok_book_checkout_orders where intent_id in (
  select id from public.book_checkout_intents where book_id = '$BOOK_ID');
delete from public.purchases where book_id = '$BOOK_ID';
delete from public.book_checkout_intents where book_id = '$BOOK_ID';
SQL
}

# Fixtures must be COMMITTED, unlike this repo's .test.sql convention:
# three genuinely separate connections have to see them.
psql_q > /dev/null <<SQL
begin;
$(cleanup_rows_sql)
delete from public.books where id = '$BOOK_ID';
delete from auth.users where id in ('$AUTHOR_ID', '$READER_ID');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('$AUTHOR_ID', 'p062-contention-author@test', now(), '{"role":"author","display_name":"Contention Author"}'),
  ('$READER_ID', 'p062-contention-reader@test', now(), '{"role":"reader","display_name":"Contention Reader"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, price_all, status)
values ('$BOOK_ID', '$AUTHOR_ID', 'Concurrent Mint Book', '', '', '', $MISLEADING_CENTS, $PRICE_ALL, 'published');
commit;
SQL

# The holder blocks on a marker file rather than on a timer, so the race is
# released only once the poll below has PROVEN both RPC sessions are parked.
cat > "$WORKDIR/hold.sql" <<'SQLEOF'
\set ON_ERROR_STOP on
\o /dev/null
begin;
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext(:'reader'), pg_catalog.hashtext(:'book'));
\o
\! touch __READY__
\! __WAITER__
\o /dev/null
commit;
\o
select 'HOLDER_DONE';
SQLEOF

cat > "$WORKDIR/rpc.sql" <<'SQLEOF'
\set ON_ERROR_STOP on
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'reader', true);
select 'RESULT|' || coalesce(quote_status, '') ||
       '|' || coalesce(intent_id::text, '') ||
       '|' || coalesce(price_cents_at_checkout::text, '')
  from public.create_book_checkout_intent(:'book'::uuid, null);
reset role;
commit;
SQLEOF

run_round() {
  local round="$1"
  local ready="$WORKDIR/ready_$round"
  local release="$WORKDIR/release_$round"
  local waiter="$WORKDIR/wait_$round.sh"
  local holder_out="$WORKDIR/holder_$round.txt"
  local a_out="$WORKDIR/a_$round.txt"
  local b_out="$WORKDIR/b_$round.txt"
  local hold_sql="$WORKDIR/hold_$round.sql"

  psql_q > /dev/null <<SQL
begin;
$(cleanup_rows_sql)
commit;
SQL

  cat > "$waiter" <<WAITEOF
#!/usr/bin/env bash
# Bounded: 60s. If the poll below never releases us, the holder still lets
# go rather than wedging the cluster, and the poll's own failure is what
# reports the reason.
for _ in \$(seq 1 1200); do
  [ -f "$release" ] && exit 0
  sleep 0.05
done
exit 1
WAITEOF
  chmod +x "$waiter"

  sed -e "s#__READY__#$ready#" -e "s#__WAITER__#$waiter#" "$WORKDIR/hold.sql" > "$hold_sql"

  PGAPPNAME="$APP_HOLDER" psql -X -q -t -A -d "$DB" \
    -v reader="$READER_ID" -v book="$BOOK_ID" \
    -f "$hold_sql" > "$holder_out" 2>&1 &
  local holder_pid=$!

  local waited=0
  until [ -f "$ready" ]; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -ge 400 ]; then
      kill "$holder_pid" 2>/dev/null || true
      cat "$holder_out" >&2 || true
      fail "round $round: the advisory-lock holder never signalled (20s)"
    fi
  done

  # The holder's OWN granted lock row is the reference key. Comparing the
  # two RPC sessions against it, rather than against a recomputed number,
  # is what makes "the same advisory key" a measurement instead of an
  # assumption -- and the equality check that follows proves that key is
  # the (reader_id, book_id) pair and not some other advisory lock.
  local key
  key="$(psql_q -c "
    select l.classid::bigint || '|' || l.objid::bigint || '|' || l.objsubid || '|' || a.pid
    from pg_locks l
    join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and l.granted
      and a.application_name = '$APP_HOLDER'
      and a.datname = current_database()")"
  if [ "$(printf '%s\n' "$key" | grep -c .)" != "1" ]; then
    printf '%s\n' "$release" > /dev/null; touch "$release"
    wait "$holder_pid" 2>/dev/null || true
    fail "round $round: expected exactly one granted advisory lock held by $APP_HOLDER, got: $key"
  fi
  local classid objid objsubid holder_backend
  classid="$(printf '%s' "$key" | cut -d'|' -f1)"
  objid="$(printf '%s' "$key" | cut -d'|' -f2)"
  objsubid="$(printf '%s' "$key" | cut -d'|' -f3)"
  holder_backend="$(printf '%s' "$key" | cut -d'|' -f4)"

  local keymatch
  keymatch="$(psql_q -c "
    select (${classid}::bigint = pg_catalog.hashtext('$READER_ID')::oid::bigint
        and ${objid}::bigint   = pg_catalog.hashtext('$BOOK_ID')::oid::bigint
        and ${objsubid} = 2)")"
  if [ "$keymatch" != "t" ]; then
    touch "$release"; wait "$holder_pid" 2>/dev/null || true
    fail "round $round: the held advisory key is not (hashtext(reader), hashtext(book))"
  fi

  PGAPPNAME="$APP_A" psql -X -q -t -A -d "$DB" -v ON_ERROR_STOP=1 \
    -v reader="$READER_ID" -v book="$BOOK_ID" -f "$WORKDIR/rpc.sql" > "$a_out" 2>&1 &
  local a_pid=$!
  PGAPPNAME="$APP_B" psql -X -q -t -A -d "$DB" -v ON_ERROR_STOP=1 \
    -v reader="$READER_ID" -v book="$BOOK_ID" -f "$WORKDIR/rpc.sql" > "$b_out" 2>&1 &
  local b_pid=$!

  # THE gate. Both RPC backends must be parked on the holder's exact key
  # before anything is released. If the function does not take the lock,
  # or takes it on a different key, this never reaches 2 and the round
  # fails here rather than producing a misleading outcome.
  local parked=0
  waited=0
  until [ "$parked" = "2" ]; do
    parked="$(psql_q -c "
      select count(distinct a.pid)
      from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and not l.granted
        and l.classid::bigint = ${classid}::bigint
        and l.objid::bigint = ${objid}::bigint
        and l.objsubid = ${objsubid}
        and a.datname = current_database()
        and a.application_name in ('$APP_A', '$APP_B')")"
    [ "$parked" = "2" ] && break
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -ge 400 ]; then
      local diag
      diag="$(psql_q -c "
        select coalesce(string_agg(a.application_name || ':' || coalesce(a.wait_event_type,'-') ||
                                   '/' || coalesce(a.wait_event,'-') || ':' || left(a.state,16), ', '), '(none)')
        from pg_stat_activity a
        where a.datname = current_database()
          and a.application_name in ('$APP_A', '$APP_B')")"
      touch "$release"
      wait "$holder_pid" 2>/dev/null || true
      wait "$a_pid" 2>/dev/null || true
      wait "$b_pid" 2>/dev/null || true
      echo "--- session A ---" >&2; cat "$a_out" >&2 || true
      echo "--- session B ---" >&2; cat "$b_out" >&2 || true
      fail "round $round: only $parked of 2 RPC sessions ever waited on the (reader, book) advisory lock (20s). Backends: $diag. The mint path is not serialized on that key before it inspects the reader's open intents."
    fi
  done

  touch "$release"

  set +e
  wait "$holder_pid"; local rc_h=$?
  wait "$a_pid"; local rc_a=$?
  wait "$b_pid"; local rc_b=$?
  set -e

  if grep -qi "deadlock" "$holder_out" "$a_out" "$b_out"; then
    cat "$holder_out" "$a_out" "$b_out" >&2
    fail "round $round: DEADLOCK between two concurrent create_book_checkout_intent calls"
  fi
  if [ "$rc_h" != "0" ] || [ "$rc_a" != "0" ] || [ "$rc_b" != "0" ]; then
    cat "$holder_out" "$a_out" "$b_out" >&2
    fail "round $round: a backend errored (holder=$rc_h a=$rc_a b=$rc_b)"
  fi

  local line_a line_b
  line_a="$(grep '^RESULT|' "$a_out" || true)"
  line_b="$(grep '^RESULT|' "$b_out" || true)"
  if [ -z "$line_a" ] || [ -z "$line_b" ]; then
    cat "$a_out" "$b_out" >&2
    fail "round $round: one of the RPC sessions returned no row"
  fi

  local st_a st_b id_a id_b pr_a pr_b
  st_a="$(printf '%s' "$line_a" | cut -d'|' -f2)"; id_a="$(printf '%s' "$line_a" | cut -d'|' -f3)"; pr_a="$(printf '%s' "$line_a" | cut -d'|' -f4)"
  st_b="$(printf '%s' "$line_b" | cut -d'|' -f2)"; id_b="$(printf '%s' "$line_b" | cut -d'|' -f3)"; pr_b="$(printf '%s' "$line_b" | cut -d'|' -f4)"

  local minted reused
  minted=0; reused=0
  for s in "$st_a" "$st_b"; do
    case "$s" in
      minted) minted=$((minted + 1)) ;;
      reused) reused=$((reused + 1)) ;;
    esac
  done
  if [ "$minted" != "1" ] || [ "$reused" != "1" ]; then
    fail "round $round: expected exactly one 'minted' and one 'reused', got a='$st_a' b='$st_b'. Two mints mean the second caller inspected the reader's open intents before the first had committed -- the advisory lock was acquired too late to exclude it."
  fi
  if [ -z "$id_a" ] || [ "$id_a" != "$id_b" ]; then
    fail "round $round: the two callers were handed different intents (a='$id_a' b='$id_b')"
  fi
  if [ "$pr_a" != "$EXPECT_MINOR" ] || [ "$pr_b" != "$EXPECT_MINOR" ]; then
    fail "round $round: expected $EXPECT_MINOR minor units from both callers for a $PRICE_ALL ALL book, got a='$pr_a' b='$pr_b'"
  fi

  local persisted
  persisted="$(psql_q -c "
    select i.regime || '|' || i.currency || '|' || i.royalty_rate_bps || '|' || i.price_cents_at_checkout
    from public.book_checkout_intents i where i.id = '$id_a'")"
  if [ "$persisted" != "librum_ledger_v1|ALL|8000|$EXPECT_MINOR" ]; then
    fail "round $round: persisted intent is '$persisted', expected 'librum_ledger_v1|ALL|8000|$EXPECT_MINOR'"
  fi

  local counts
  counts="$(psql_q -c "
    select (select count(*) from public.book_checkout_intents i
             where i.reader_id = '$READER_ID' and i.book_id = '$BOOK_ID')
        || '|' || (select count(*) from public.book_checkout_intents i
             where i.reader_id = '$READER_ID' and i.book_id = '$BOOK_ID'
               and i.superseded_at is null and i.completed_at is null
               and i.fulfilled_at is null and i.expires_at > now())
        || '|' || (select count(*) from public.book_checkout_intents i
             where i.reader_id = '$READER_ID' and i.book_id = '$BOOK_ID'
               and i.superseded_at is not null)
        || '|' || (select count(*) from public.pok_book_checkout_orders m
             where m.intent_id in (select id from public.book_checkout_intents i2
                                    where i2.book_id = '$BOOK_ID'))")"
  local total open superseded mappings
  total="$(printf '%s' "$counts" | cut -d'|' -f1)"
  open="$(printf '%s' "$counts" | cut -d'|' -f2)"
  superseded="$(printf '%s' "$counts" | cut -d'|' -f3)"
  mappings="$(printf '%s' "$counts" | cut -d'|' -f4)"

  [ "$total" = "1" ] || fail "round $round: $total intents exist for this reader and book, expected exactly 1"
  [ "$open" = "1" ] || fail "round $round: $open OPEN intents exist for this reader and book, expected exactly 1"
  [ "$superseded" = "0" ] || fail "round $round: $superseded intent(s) were superseded; a reused quote must supersede nothing"
  [ "$mappings" = "0" ] || fail "round $round: $mappings POK mapping row(s) were created; minting an intent must create none"

  echo "  round $round: $st_a / $st_b on one intent $id_a at $EXPECT_MINOR minor units, both backends parked on the (reader, book) key first"
}

echo "062 concurrent-mint contention ($DB, $ROUNDS round(s))"
for r in $(seq 1 "$ROUNDS"); do
  run_round "$r"
done

psql_q > /dev/null <<SQL
begin;
$(cleanup_rows_sql)
delete from public.books where id = '$BOOK_ID';
delete from auth.users where id in ('$AUTHOR_ID', '$READER_ID');
commit;
SQL

echo "PASS 062_all_checkout_intent_contention"
