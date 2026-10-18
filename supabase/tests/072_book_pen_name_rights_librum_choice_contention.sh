#!/usr/bin/env bash
# BOOK-PEN-NAME-RIGHTS-CHOICE-1: public.set_librum_choice and
# public.clear_librum_choice under genuinely concurrent transactions.
#
# 072_book_pen_name_rights_librum_choice.test.sql runs on ONE connection,
# so it cannot show two picks racing. The unique index
# books_one_librum_choice cannot be deferred, so without the functions'
# shared advisory lock two overlapping "clear old + set new" sequences
# could both clear, then one set would fail with 23505. Each scenario:
#
#   set_vs_set        Two picks of different books while a pick exists.
#                     Both return true, neither errors, and exactly ONE
#                     of the two books is picked afterwards.
#   set_vs_set_empty  The same with nothing picked at the start.
#   set_same          Two picks of the SAME book: both true, it is picked.
#   set_vs_clear      A pick and a clear: both succeed, and afterwards
#                     either the new book or nothing is picked.
#   unpublish_commit  The book being picked is unpublished by a
#                     transaction that holds its row when the pick
#                     arrives. The pick waits on the row lock, re-reads
#                     the committed row, returns false, and the existing
#                     pick stays.
#   unpublish_rollback The same, but the unpublish rolls back: the pick
#                     waits and then succeeds. Proves the refusal above
#                     comes from the re-check, not from waiting.
#
# Races are CONSTRUCTED, never hoped for (same machinery as
# 069_bundle_membership_contention.sh): a holder connection takes the
# conflicting lock first (the advisory lock, or the book's row) and
# blocks on a marker file; the writer sessions are started and a bounded
# poll of pg_stat_activity must see every one of them waiting on a lock
# before the holder is released. No assertion depends on timing.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/072_book_pen_name_rights_librum_choice_contention.sh
# (or pass the database name as $1). ROUNDS=n repeats every scenario.
# Requires a database carrying BOOK-PEN-NAME-RIGHTS-CHOICE-1 and no
# picked book outside this script's fixtures. Fixtures are committed
# (separate connections must see them) and removed on exit.

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
ROUNDS="${ROUNDS:-2}"
WORKDIR="$(mktemp -d)"

AUTHOR="e0723000-0000-4000-8000-00000000000a"
A="e0723010-0000-4000-8000-0000000000a1"
B="e0723010-0000-4000-8000-0000000000a2"
C="e0723010-0000-4000-8000-0000000000a3"

psql_q() { psql -X -q -t -A -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

remove_fixtures() {
  psql_q > /dev/null <<SQL
begin;
delete from public.books where author_id = '$AUTHOR';
delete from auth.users where id = '$AUTHOR';
commit;
SQL
}

cleanup() {
  remove_fixtures > /dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Three published books; <pick> (a book id or 'none') is picked.
reset_fixtures() {
  local pick="$1"
  remove_fixtures
  local other
  other="$(psql_q -c "select count(*) from public.books where librum_choice_at is not null")"
  [ "$other" = "0" ] || fail "a book outside this script's fixtures is picked; run against a disposable database"
  psql_q > /dev/null <<SQL
begin;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('$AUTHOR', 'p072c-author@test', now(), '{"role":"author","display_name":"P072C Author"}');
update public.profiles set role = 'author' where id = '$AUTHOR';
insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('$A', '$AUTHOR', 'C1', 'published', 0, now()),
  ('$B', '$AUTHOR', 'C2', 'published', 0, now()),
  ('$C', '$AUTHOR', 'C3', 'published', 0, now());
update public.books set librum_choice_at = now() where id::text = '$pick';
commit;
SQL
}

picked() {
  psql_q -c "select coalesce(string_agg(id::text, ',' order by id), 'none') from public.books where librum_choice_at is not null"
}

# A writer session as service_role (the only role holding EXECUTE);
# prints RESULT|<value>, or the SQLSTATE it raised.
write_set() {
  cat > "$WORKDIR/$1.sql" <<SQL
\\set ON_ERROR_STOP on
\\set VERBOSITY verbose
begin;
set local role service_role;
select 'RESULT|' || public.set_librum_choice('$2'::uuid)::text;
commit;
SQL
  echo "$WORKDIR/$1.sql"
}

write_clear() {
  cat > "$WORKDIR/$1.sql" <<SQL
\\set ON_ERROR_STOP on
\\set VERBOSITY verbose
begin;
set local role service_role;
\\o /dev/null
select public.clear_librum_choice();
\\o
select 'RESULT|cleared';
commit;
SQL
  echo "$WORKDIR/$1.sql"
}

outcome() {
  local f="$1" line
  line="$(grep '^RESULT|' "$f" || true)"
  if [ -n "$line" ]; then
    printf '%s' "$line" | cut -d'|' -f2-
    return
  fi
  local st
  st="$(grep -o 'ERROR:  [0-9A-Z]\{5\}' "$f" | head -n 1 | cut -c9- || true)"
  printf 'ERR:%s' "${st:-unknown}"
}

# race <label> <holder statements> <commit|rollback> <writer sql file>...
# Starts the holder, proves it holds, starts every writer, proves every
# writer is waiting on a lock, then releases the holder and waits.
race() {
  local label="$1" holder_stmts="$2" finish="$3"
  shift 3
  local ready="$WORKDIR/${label}.ready" release="$WORKDIR/${label}.release"
  local waiter="$WORKDIR/${label}.wait.sh" holder_out="$WORKDIR/${label}.holder"
  rm -f "$ready" "$release"
  cat > "$waiter" <<WAITEOF
#!/usr/bin/env bash
for _ in \$(seq 1 1200); do [ -f "$release" ] && exit 0; sleep 0.05; done
exit 1
WAITEOF
  chmod +x "$waiter"
  cat > "$WORKDIR/${label}.hold.sql" <<SQL
\\set ON_ERROR_STOP on
\\o /dev/null
begin;
$holder_stmts
\\o
\\! touch $ready
\\! $waiter
\\o /dev/null
$finish;
\\o
select 'HOLDER_DONE';
SQL
  PGAPPNAME="p072c_holder" psql -X -q -t -A -d "$DB" -f "$WORKDIR/${label}.hold.sql" > "$holder_out" 2>&1 &
  local holder_pid=$!
  local waited=0
  until [ -f "$ready" ]; do
    sleep 0.05; waited=$((waited + 1))
    if [ "$waited" -ge 400 ] || ! kill -0 "$holder_pid" 2>/dev/null; then
      cat "$holder_out" >&2 || true
      touch "$release"; wait "$holder_pid" 2>/dev/null || true
      fail "$label: the holder never took its lock"
    fi
  done

  local pids=() apps=() i=0
  for sqlfile in "$@"; do
    i=$((i + 1))
    PGAPPNAME="p072c_w${i}" psql -X -q -t -A -d "$DB" -f "$sqlfile" > "$WORKDIR/${label}.w${i}" 2>&1 &
    pids+=("$!"); apps+=("'p072c_w${i}'")
  done
  local applist; applist="$(IFS=,; echo "${apps[*]}")"

  local parked=0; waited=0
  until [ "$parked" = "$i" ]; do
    parked="$(psql_q -c "select count(*) from pg_stat_activity
                          where datname = current_database() and application_name in ($applist)
                            and wait_event_type = 'Lock'")"
    [ "$parked" = "$i" ] && break
    sleep 0.05; waited=$((waited + 1))
    if [ "$waited" -ge 400 ]; then
      touch "$release"
      wait "$holder_pid" 2>/dev/null || true
      for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
      for n in $(seq 1 "$i"); do echo "--- writer $n ---" >&2; cat "$WORKDIR/${label}.w${n}" >&2 || true; done
      fail "$label: only $parked of $i writer(s) ever waited on the holder's lock"
    fi
  done

  touch "$release"
  set +e
  wait "$holder_pid"; local rc_h=$?
  for p in "${pids[@]}"; do wait "$p"; done
  set -e
  [ "$rc_h" = "0" ] || { cat "$holder_out" >&2; fail "$label: the holder errored"; }
  if grep -qi deadlock "$holder_out" "$WORKDIR/${label}".w*; then
    cat "$WORKDIR/${label}".w* >&2
    fail "$label: deadlock"
  fi
}

ADVISORY="select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.books.librum_choice'));"

scenario_set_vs_set() {
  local label="set_vs_set_$1"
  reset_fixtures "$A"
  race "$label" "$ADVISORY" commit "$(write_set "${label}_b" "$B")" "$(write_set "${label}_c" "$C")"
  local ob oc final
  ob="$(outcome "$WORKDIR/${label}.w1")"; oc="$(outcome "$WORKDIR/${label}.w2")"; final="$(picked)"
  [ "$ob" = "true" ] && [ "$oc" = "true" ] || fail "$label: writers returned '$ob' and '$oc'"
  [ "$final" = "$B" ] || [ "$final" = "$C" ] || fail "$label: picked afterwards '$final'"
  echo "  ok [$label]: both picks returned true, exactly one book is picked ($final)"
}

scenario_set_vs_set_empty() {
  local label="set_vs_set_empty_$1"
  reset_fixtures none
  race "$label" "$ADVISORY" commit "$(write_set "${label}_b" "$B")" "$(write_set "${label}_c" "$C")"
  local ob oc final
  ob="$(outcome "$WORKDIR/${label}.w1")"; oc="$(outcome "$WORKDIR/${label}.w2")"; final="$(picked)"
  [ "$ob" = "true" ] && [ "$oc" = "true" ] || fail "$label: writers returned '$ob' and '$oc'"
  [ "$final" = "$B" ] || [ "$final" = "$C" ] || fail "$label: picked afterwards '$final'"
  echo "  ok [$label]: both picks returned true from an empty pick, exactly one book is picked"
}

scenario_set_same() {
  local label="set_same_$1"
  reset_fixtures "$A"
  race "$label" "$ADVISORY" commit "$(write_set "${label}_1" "$B")" "$(write_set "${label}_2" "$B")"
  local o1 o2 final
  o1="$(outcome "$WORKDIR/${label}.w1")"; o2="$(outcome "$WORKDIR/${label}.w2")"; final="$(picked)"
  [ "$o1" = "true" ] && [ "$o2" = "true" ] && [ "$final" = "$B" ] || fail "$label: '$o1' '$o2' picked '$final'"
  echo "  ok [$label]: two picks of the same book both returned true, it is picked"
}

scenario_set_vs_clear() {
  local label="set_vs_clear_$1"
  reset_fixtures "$A"
  race "$label" "$ADVISORY" commit "$(write_set "${label}_b" "$B")" "$(write_clear "${label}_x")"
  local ob ox final
  ob="$(outcome "$WORKDIR/${label}.w1")"; ox="$(outcome "$WORKDIR/${label}.w2")"; final="$(picked)"
  [ "$ob" = "true" ] && [ "$ox" = "cleared" ] || fail "$label: writers returned '$ob' and '$ox'"
  [ "$final" = "$B" ] || [ "$final" = "none" ] || fail "$label: picked afterwards '$final'"
  echo "  ok [$label]: the pick and the clear both succeeded, afterwards '$final'"
}

scenario_unpublish_commit() {
  local label="unpublish_commit_$1"
  reset_fixtures "$A"
  race "$label" "update public.books set status = 'draft' where id = '$B';" commit "$(write_set "${label}_b" "$B")"
  local ob final
  ob="$(outcome "$WORKDIR/${label}.w1")"; final="$(picked)"
  [ "$ob" = "false" ] && [ "$final" = "$A" ] || fail "$label: returned '$ob', picked '$final'"
  echo "  ok [$label]: the pick waited, saw the book unpublished, returned false; the old pick stays"
}

scenario_unpublish_rollback() {
  local label="unpublish_rollback_$1"
  reset_fixtures "$A"
  race "$label" "update public.books set status = 'draft' where id = '$B';" rollback "$(write_set "${label}_b" "$B")"
  local ob final
  ob="$(outcome "$WORKDIR/${label}.w1")"; final="$(picked)"
  [ "$ob" = "true" ] && [ "$final" = "$B" ] || fail "$label: returned '$ob', picked '$final'"
  echo "  ok [$label]: the pick waited, the unpublish rolled back, the pick moved"
}

COUNT=0
for r in $(seq 1 "$ROUNDS"); do
  for s in set_vs_set set_vs_set_empty set_same set_vs_clear unpublish_commit unpublish_rollback; do
    "scenario_$s" "$r"
    COUNT=$((COUNT + 1))
  done
done

echo "PASS: 072_book_pen_name_rights_librum_choice_contention.sh -- $COUNT scenario runs"
