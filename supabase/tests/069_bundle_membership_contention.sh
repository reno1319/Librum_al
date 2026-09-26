#!/usr/bin/env bash
# BUNDLE-MEMBERSHIP-AUTH-1 (Patch 13): the trusted bundle writers
# public.replace_bundle_membership, public.create_bundle_with_membership and
# public.update_bundle_with_membership under genuinely concurrent
# transactions.
#
# Why this file has to exist: 069_bundle_membership_write_authorization.test.sql
# runs on ONE connection, so it cannot show what a second transaction
# observes while a first is mid-write. Every hazard below is exactly that.
#
# What the functions promise, and what each scenario proves:
#
#   concurrent_replace   Two replacements of the SAME bundle serialize on
#                        the bundle row (FOR UPDATE). Both succeed, each
#                        returns exactly its own set, and the bundle ends
#                        holding exactly ONE of the two sets -- never the
#                        union, never a mix, never empty.
#   unpublish_commit     A selected book is unpublished by a transaction
#                        that holds its row when the writer arrives. The
#                        writer WAITS (FOR SHARE conflicts with the
#                        unpublishing UPDATE), re-checks the committed row,
#                        and refuses with 42501. Membership is untouched.
#   unpublish_rollback   The same, but the unpublish rolls back: the writer
#                        waits, re-checks, and succeeds. Proves the refusal
#                        above comes from the re-check, not from waiting.
#   delete_commit        A selected book is deleted concurrently: the
#                        writer waits, finds it gone, refuses with 42501.
#   create_unpublish     create_bundle_with_membership against a concurrent
#                        unpublish: refused, and the bundle itself does not
#                        exist afterwards (bundle + membership are one
#                        transaction).
#   writer_holds_locks   The reverse direction. While a writer's
#                        transaction is open, its selected books cannot be
#                        unpublished or deleted and its bundle cannot be
#                        replaced by anyone else: each attempt times out on
#                        a lock (55P03). This is what FOR SHARE buys over
#                        the FOR KEY SHARE an FK check takes -- KEY SHARE
#                        does not conflict with a non-key UPDATE such as
#                        status = 'draft'.
#                        Run twice: with an open replacement, and with an
#                        open complete edit (which also blocks a second
#                        edit and a publish of the bundle).
#
# The complete edit (update_bundle_with_membership: details AND membership
# in ONE transaction):
#
#   concurrent_update    Two complete edits of the same bundle, different
#                        title, description, price_all AND books, no
#                        compare-and-set. Both succeed, each returns its
#                        own complete state, and the bundle ends in exactly
#                        ONE of the two submitted states. A hybrid (one
#                        edit's details with the other's books, or a union
#                        of books) fails the scenario.
#   concurrent_update_cas The same two edits, each carrying Patch 6's full
#                        compare-and-set (draft, price_all 0) and a paid
#                        price: exactly one succeeds, the other is refused
#                        LB409 on the re-read locked row, and the bundle is
#                        exactly the winner's state.
#   cas_publish          A publish holds the bundle row when an edit that
#                        expects 'draft' arrives: the edit waits and, on
#                        commit, is refused LB409 -- details and membership
#                        untouched. On rollback the same edit succeeds.
#   cas_reprice          The same for a concurrent price_all change against
#                        an edit expecting the old price.
#   update_unpublish     A complete edit whose book is unpublished
#                        concurrently: refused 42501 AFTER its details
#                        update ran, and the details are rolled back with
#                        the membership (the bundle is exactly as before).
#   split_flow_control   NEGATIVE CONTROL for the hybrid detector. The
#                        pre-correction flow (details in one transaction,
#                        membership in another) is replayed in the
#                        interleaving that breaks it; the detector must
#                        report the resulting hybrid. Proves the check in
#                        concurrent_update is not vacuous.
#
# Races are CONSTRUCTED, never hoped for: a holder connection takes the
# conflicting lock first and blocks on a marker file; the writer sessions
# are started and a bounded poll of pg_stat_activity must see every one of
# them waiting on a heavyweight lock before the holder is released. Sleeps
# appear only inside bounded polls; no assertion depends on timing.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/069_bundle_membership_contention.sh
# (or pass the database name as $1). ROUNDS=n repeats every scenario.
# SCENARIOS="concurrent_update cas" runs only the scenarios whose function
# name (scenario_<name>) is listed; the default is every scenario.
# Requires a database carrying BUNDLE-MEMBERSHIP-AUTH-1. Fixtures are
# committed (separate connections must see them) and removed on exit.

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
ROUNDS="${ROUNDS:-2}"
WORKDIR="$(mktemp -d)"

AUTHOR="e0693000-0000-4000-8000-00000000000a"
BUNDLE="e0693020-0000-4000-8000-0000000000a1"
NEW_BUNDLE="e0693020-0000-4000-8000-0000000000a9"
A1="e0693010-0000-4000-8000-0000000000a1"
A2="e0693010-0000-4000-8000-0000000000a2"
A3="e0693010-0000-4000-8000-0000000000a3"
A5="e0693010-0000-4000-8000-0000000000a5"
A6="e0693010-0000-4000-8000-0000000000a6"

psql_q() { psql -X -q -t -A -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

remove_fixtures() {
  psql_q > /dev/null <<SQL
begin;
delete from public.bundles where author_id = '$AUTHOR';
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

# The initial state for every scenario: five published books, one draft
# bundle holding {A1, A2}.
reset_fixtures() {
  remove_fixtures
  psql_q > /dev/null <<SQL
begin;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('$AUTHOR', 'p069c-author@test', now(), '{"role":"author","display_name":"P069C Author"}');
update public.profiles set role = 'author' where id = '$AUTHOR';
insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('$A1', '$AUTHOR', 'C1', 'published', 0, now()),
  ('$A2', '$AUTHOR', 'C2', 'published', 0, now()),
  ('$A3', '$AUTHOR', 'C3', 'published', 0, now()),
  ('$A5', '$AUTHOR', 'C5', 'published', 0, now()),
  ('$A6', '$AUTHOR', 'C6', 'published', 0, now());
insert into public.bundles (id, author_id, title, status, price_all) values
  ('$BUNDLE', '$AUTHOR', 'Contention bundle', 'draft', 0);
insert into public.bundle_books (bundle_id, book_id) values ('$BUNDLE', '$A1'), ('$BUNDLE', '$A2');
commit;
SQL
}

members() {
  psql_q -c "select coalesce(string_agg(book_id::text, ',' order by book_id), '<none>')
               from public.bundle_books where bundle_id = '${1:-$BUNDLE}'"
}

sorted_set() { printf '%s\n' "$@" | sort | paste -sd, -; }

# A writer session: calls one function as service_role (the only role
# holding EXECUTE) and prints RESULT|<sorted returned book ids>, or the
# SQLSTATE of the error it raised.
writer_sql() {
  local call="$1"
  cat <<SQL
\\set ON_ERROR_STOP on
\\set VERBOSITY verbose
begin;
set local role service_role;
select 'RESULT|' || coalesce(string_agg(r.member_book_id::text, ',' order by r.member_book_id), '<none>')
       || '|' || coalesce(string_agg(distinct r.member_bundle_id::text, ','), '<none>')
  from $call as r;
commit;
SQL
}

replace_call() { echo "public.replace_bundle_membership('$BUNDLE'::uuid, '$AUTHOR'::uuid, array[$(printf "'%s'," "$@" | sed 's/,$//')]::uuid[])"; }
create_call() { echo "public.create_bundle_with_membership('$NEW_BUNDLE'::uuid, '$AUTHOR'::uuid, 'Created', '', 0, array[$(printf "'%s'," "$@" | sed 's/,$//')]::uuid[])"; }

books_array() { echo "array[$(printf "'%s'," "$@" | sed 's/,$//')]::uuid[]"; }

# update_call <title> <description> <price_all> <expected_status|null> <check true|false> <expected_price_all|null> <book>...
update_call() {
  local title="$1" desc="$2" price="$3" est="$4" chk="$5" eprice="$6"
  shift 6
  [ "$est" = null ] || est="'$est'"
  echo "public.update_bundle_with_membership('$BUNDLE'::uuid, '$AUTHOR'::uuid, $est, $chk, $eprice::integer, '$title', '$desc', $price::integer, $(books_array "$@"))"
}

# A complete-edit writer: prints RESULT|<title>|<description>|<price_all>|<status>|<sorted members>
# from the function's returned proof, or the SQLSTATE it raised.
update_writer_sql() {
  cat <<SQL
\\set ON_ERROR_STOP on
\\set VERBOSITY verbose
begin;
set local role service_role;
select 'RESULT|' || min(r.bundle_title) || '|' || min(r.bundle_description) || '|'
       || coalesce(min(r.bundle_price_all)::text, 'null') || '|' || min(r.bundle_status) || '|'
       || string_agg(r.member_book_id::text, ',' order by r.member_book_id)
  from $1 as r
 having count(distinct r.bundle_title) = 1 and count(distinct r.bundle_description) = 1
    and count(distinct r.bundle_status) = 1 and count(distinct r.member_bundle_id) = 1;
commit;
SQL
}
write_update_writer() { update_writer_sql "$2" > "$WORKDIR/$1.sql"; echo "$WORKDIR/$1.sql"; }

# The bundle's complete persisted state, in the same shape.
state() {
  psql_q -c "select b.title || '|' || b.description || '|' || coalesce(b.price_all::text, 'null') || '|' || b.status || '|'
                    || coalesce((select string_agg(bb.book_id::text, ',' order by bb.book_id)
                                   from public.bundle_books bb where bb.bundle_id = b.id), '<none>')
               from public.bundles b where b.id = '$BUNDLE'"
}

# state_of <title> <description> <price_all> <status> <book>...
state_of() {
  local t="$1" d="$2" p="$3" st="$4"
  shift 4
  echo "$t|$d|$p|$st|$(sorted_set "$@")"
}

# The hybrid detector: the final state must be EXACTLY one of the given
# complete states.
is_one_of() {
  local final="$1"
  shift
  for want in "$@"; do [ "$final" = "$want" ] && return 0; done
  return 1
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
  PGAPPNAME="p069c_holder" psql -X -q -t -A -d "$DB" -f "$WORKDIR/${label}.hold.sql" > "$holder_out" 2>&1 &
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
    PGAPPNAME="p069c_w${i}" psql -X -q -t -A -d "$DB" -f "$sqlfile" > "$WORKDIR/${label}.w${i}" 2>&1 &
    pids+=("$!"); apps+=("'p069c_w${i}'")
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
      local diag
      diag="$(psql_q -c "select coalesce(string_agg(application_name || ':' || coalesce(wait_event_type, '-') || '/' || coalesce(wait_event, '-') || ':' || coalesce(state, '-'), ', '), '(none)')
                          from pg_stat_activity where datname = current_database() and application_name in ($applist)")"
      touch "$release"
      wait "$holder_pid" 2>/dev/null || true
      for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
      for n in $(seq 1 "$i"); do echo "--- writer $n ---" >&2; cat "$WORKDIR/${label}.w${n}" >&2 || true; done
      fail "$label: only $parked of $i writer(s) ever waited on the holder's lock. Backends: $diag. The writer does not lock what it must."
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

write_writer() { writer_sql "$2" > "$WORKDIR/$1.sql"; echo "$WORKDIR/$1.sql"; }

INITIAL="$(sorted_set "$A1" "$A2")"

scenario_concurrent_replace() {
  local r="$1" label="concurrent_replace_$1"
  reset_fixtures
  local set_a set_b wa wb
  set_a="$(sorted_set "$A3" "$A5")"; set_b="$(sorted_set "$A6" "$A1")"
  wa="$(write_writer "${label}_a" "$(replace_call "$A3" "$A5")")"
  wb="$(write_writer "${label}_b" "$(replace_call "$A6" "$A1")")"
  race "$label" "select 1 from public.bundles where id = '$BUNDLE' for update;" commit "$wa" "$wb"
  local oa ob final
  oa="$(outcome "$WORKDIR/${label}.w1")"; ob="$(outcome "$WORKDIR/${label}.w2")"
  final="$(members)"
  [ "$oa" = "$set_a|$BUNDLE" ] || fail "$label: writer A returned '$oa', expected '$set_a|$BUNDLE'"
  [ "$ob" = "$set_b|$BUNDLE" ] || fail "$label: writer B returned '$ob', expected '$set_b|$BUNDLE'"
  if [ "$final" != "$set_a" ] && [ "$final" != "$set_b" ]; then
    fail "$label: the bundle holds '$final' -- neither A's set nor B's (a union or a mix means the replacements interleaved)"
  fi
  echo "  ok [$label]: both parked on the bundle row, both succeeded with their own set, bundle holds exactly one set ($final)"
}

scenario_book_change() {
  local r="$1" kind="$2" finish="$3" expect="$4"
  local label="${kind}_${finish}_$r" stmt
  case "$kind" in
    unpublish) stmt="update public.books set status = 'draft', published_at = null where id = '$A3';" ;;
    delete) stmt="delete from public.books where id = '$A3';" ;;
  esac
  reset_fixtures
  local w; w="$(write_writer "${label}_w" "$(replace_call "$A1" "$A3")")"
  race "$label" "$stmt" "$finish" "$w"
  local o final
  o="$(outcome "$WORKDIR/${label}.w1")"; final="$(members)"
  if [ "$expect" = "refused" ]; then
    [ "$o" = "ERR:42501" ] || fail "$label: the writer returned '$o', expected ERR:42501 (the re-check must refuse a book that is no longer the author's published book)"
    [ "$final" = "$INITIAL" ] || fail "$label: membership is '$final' after a refused write, expected the untouched '$INITIAL'"
    echo "  ok [$label]: writer waited on the book row, re-checked, refused 42501; membership untouched ($final)"
  else
    local want; want="$(sorted_set "$A1" "$A3")"
    [ "$o" = "$want|$BUNDLE" ] || fail "$label: the writer returned '$o', expected '$want|$BUNDLE'"
    [ "$final" = "$want" ] || fail "$label: membership is '$final', expected '$want'"
    echo "  ok [$label]: writer waited on the book row, holder rolled back, writer succeeded ($final)"
  fi
}

scenario_create_unpublish() {
  local r="$1" label="create_unpublish_$1"
  reset_fixtures
  local w; w="$(write_writer "${label}_w" "$(create_call "$A1" "$A3")")"
  race "$label" "update public.books set status = 'draft', published_at = null where id = '$A3';" commit "$w"
  local o exists
  o="$(outcome "$WORKDIR/${label}.w1")"
  exists="$(psql_q -c "select count(*) from public.bundles where id = '$NEW_BUNDLE'")|$(members "$NEW_BUNDLE")"
  [ "$o" = "ERR:42501" ] || fail "$label: create returned '$o', expected ERR:42501"
  [ "$exists" = "0|<none>" ] || fail "$label: after a refused create the bundle/membership is '$exists', expected nothing"
  echo "  ok [$label]: create waited, re-checked, refused 42501; no bundle and no membership left behind"
}

INITIAL_STATE="Contention bundle||0|draft|$INITIAL"

scenario_concurrent_update() {
  local r="$1" label="concurrent_update_$1"
  reset_fixtures
  local st_a st_b wa wb
  st_a="$(state_of "Edit A" "desc A" 0 draft "$A3" "$A5")"
  st_b="$(state_of "Edit B" "desc B" 150 draft "$A6" "$A1")"
  wa="$(write_update_writer "${label}_a" "$(update_call "Edit A" "desc A" 0 null false null "$A3" "$A5")")"
  wb="$(write_update_writer "${label}_b" "$(update_call "Edit B" "desc B" 150 null false null "$A6" "$A1")")"
  race "$label" "select 1 from public.bundles where id = '$BUNDLE' for update;" commit "$wa" "$wb"
  local oa ob final
  oa="$(outcome "$WORKDIR/${label}.w1")"; ob="$(outcome "$WORKDIR/${label}.w2")"
  final="$(state)"
  is_one_of "$final" "$st_a" "$st_b" \
    || fail "$label: HYBRID -- the bundle is '$final', which is neither A's complete state '$st_a' nor B's '$st_b'"
  [ "$oa" = "$st_a" ] || fail "$label: edit A returned '$oa', expected its own complete state '$st_a'"
  [ "$ob" = "$st_b" ] || fail "$label: edit B returned '$ob', expected its own complete state '$st_b'"
  echo "  ok [$label]: both edits parked on the bundle row, both returned their own complete state, the bundle is exactly one of them ($final)"
}

scenario_concurrent_update_cas() {
  local r="$1" label="concurrent_update_cas_$1"
  reset_fixtures
  local st_a st_b wa wb
  st_a="$(state_of "Paid A" "desc A" 199 draft "$A3" "$A5")"
  st_b="$(state_of "Paid B" "desc B" 250 draft "$A6" "$A1")"
  wa="$(write_update_writer "${label}_a" "$(update_call "Paid A" "desc A" 199 draft true 0 "$A3" "$A5")")"
  wb="$(write_update_writer "${label}_b" "$(update_call "Paid B" "desc B" 250 draft true 0 "$A6" "$A1")")"
  race "$label" "select 1 from public.bundles where id = '$BUNDLE' for update;" commit "$wa" "$wb"
  local oa ob final
  oa="$(outcome "$WORKDIR/${label}.w1")"; ob="$(outcome "$WORKDIR/${label}.w2")"
  final="$(state)"
  if [ "$oa" = "$st_a" ] && [ "$ob" = "ERR:LB409" ]; then
    [ "$final" = "$st_a" ] || fail "$label: A won and B was refused, but the bundle is '$final', expected exactly '$st_a'"
  elif [ "$ob" = "$st_b" ] && [ "$oa" = "ERR:LB409" ]; then
    [ "$final" = "$st_b" ] || fail "$label: B won and A was refused, but the bundle is '$final', expected exactly '$st_b'"
  else
    fail "$label: expected exactly one edit to succeed and the other to be refused LB409; got A='$oa' B='$ob', bundle '$final'"
  fi
  echo "  ok [$label]: two compare-and-set edits of an unpriced-at-0 draft: one succeeded, the other was refused LB409 on the re-read row; bundle is exactly the winner ($final)"
}

# scenario_cas <round> <publish|reprice> <commit|rollback>
scenario_cas() {
  local r="$1" kind="$2" finish="$3" label="cas_${2}_${3}_$1" stmt
  case "$kind" in
    publish) stmt="update public.bundles set status = 'published' where id = '$BUNDLE';" ;;
    reprice) stmt="update public.bundles set price_all = 300 where id = '$BUNDLE';" ;;
  esac
  reset_fixtures
  local want w
  want="$(state_of "Guarded" "desc G" 199 draft "$A3" "$A5")"
  w="$(write_update_writer "${label}_w" "$(update_call "Guarded" "desc G" 199 draft true 0 "$A3" "$A5")")"
  race "$label" "$stmt" "$finish" "$w"
  local o final
  o="$(outcome "$WORKDIR/${label}.w1")"; final="$(state)"
  if [ "$finish" = commit ]; then
    local changed
    case "$kind" in
      publish) changed="Contention bundle||0|published|$INITIAL" ;;
      reprice) changed="Contention bundle||300|draft|$INITIAL" ;;
    esac
    [ "$o" = "ERR:LB409" ] || fail "$label: the edit returned '$o', expected ERR:LB409 (the compare-and-set must be evaluated on the locked, re-read row)"
    [ "$final" = "$changed" ] || fail "$label: after the refused edit the bundle is '$final', expected '$changed' (the concurrent change only)"
    echo "  ok [$label]: the edit waited on the bundle row, saw the committed $kind, refused LB409; details and membership untouched ($final)"
  else
    [ "$o" = "$want" ] || fail "$label: the edit returned '$o', expected '$want'"
    [ "$final" = "$want" ] || fail "$label: the bundle is '$final', expected '$want'"
    echo "  ok [$label]: the edit waited, the $kind rolled back, the edit succeeded ($final)"
  fi
}

scenario_update_unpublish() {
  local r="$1" label="update_unpublish_$1"
  reset_fixtures
  local w
  w="$(write_update_writer "${label}_w" "$(update_call "Doomed" "desc D" 199 draft true 0 "$A1" "$A3")")"
  race "$label" "update public.books set status = 'draft', published_at = null where id = '$A3';" commit "$w"
  local o final
  o="$(outcome "$WORKDIR/${label}.w1")"; final="$(state)"
  [ "$o" = "ERR:42501" ] || fail "$label: the edit returned '$o', expected ERR:42501"
  [ "$final" = "$INITIAL_STATE" ] || fail "$label: after the refused edit the bundle is '$final', expected the untouched '$INITIAL_STATE' (its details update must roll back with the membership)"
  echo "  ok [$label]: the edit updated the details, waited on the book row, re-checked, refused 42501; details AND membership rolled back ($final)"
}

scenario_split_flow_control() {
  local r="$1" label="split_flow_control_$1"
  reset_fixtures
  local st_a st_b final
  st_a="$(state_of "Edit A" "desc A" 0 draft "$A3" "$A5")"
  st_b="$(state_of "Edit B" "desc B" 150 draft "$A6" "$A1")"
  # The pre-correction updateBundle: details, commit; membership, commit.
  # A's details; B's details + membership; A's membership.
  psql_q > /dev/null <<SQL
begin; set local role service_role;
update public.bundles set title = 'Edit A', description = 'desc A', price_all = 0 where id = '$BUNDLE';
commit;
begin; set local role service_role;
update public.bundles set title = 'Edit B', description = 'desc B', price_all = 150 where id = '$BUNDLE';
select 1 from $(replace_call "$A6" "$A1");
commit;
begin; set local role service_role;
select 1 from $(replace_call "$A3" "$A5");
commit;
SQL
  final="$(state)"
  if is_one_of "$final" "$st_a" "$st_b"; then
    fail "$label: the split flow's hybrid was NOT detected ('$final') -- the detector used by concurrent_update is vacuous"
  fi
  echo "  ok [$label]: the two-transaction flow leaves the hybrid '$final' and the detector reports it"
}

# scenario_writer_holds_locks <round> <replace|update>
scenario_writer_holds_locks() {
  local r="$1" kind="$2" label="writer_holds_locks_${2}_$1" open_call
  case "$kind" in
    replace) open_call="$(replace_call "$A1" "$A3")" ;;
    update) open_call="$(update_call "Open" "desc O" 0 draft true 0 "$A1" "$A3")" ;;
  esac
  reset_fixtures
  local ready="$WORKDIR/${label}.ready" release="$WORKDIR/${label}.release" waiter="$WORKDIR/${label}.wait.sh"
  cat > "$waiter" <<WAITEOF
#!/usr/bin/env bash
for _ in \$(seq 1 1200); do [ -f "$release" ] && exit 0; sleep 0.05; done
exit 1
WAITEOF
  chmod +x "$waiter"
  cat > "$WORKDIR/${label}.writer.sql" <<SQL
\\set ON_ERROR_STOP on
begin;
set local role service_role;
select 'RESULT|' || string_agg(r.member_book_id::text, ',' order by r.member_book_id) from $open_call as r;
\\! touch $ready
\\! $waiter
commit;
select 'WRITER_DONE';
SQL
  PGAPPNAME="p069c_open_writer" psql -X -q -t -A -d "$DB" -f "$WORKDIR/${label}.writer.sql" > "$WORKDIR/${label}.writer" 2>&1 &
  local wpid=$!
  local waited=0
  until [ -f "$ready" ]; do
    sleep 0.05; waited=$((waited + 1))
    if [ "$waited" -ge 400 ] || ! kill -0 "$wpid" 2>/dev/null; then
      cat "$WORKDIR/${label}.writer" >&2 || true
      touch "$release"; wait "$wpid" 2>/dev/null || true
      fail "$label: the writer never completed its call"
    fi
  done
  probe() {
    # A refused probe makes psql exit 3; that is the measurement, not a
    # harness error, so the pipeline's status is deliberately ignored.
    { psql -X -q -t -A -d "$DB" 2>&1 || true; } <<SQL | grep -o 'ERROR:  [0-9A-Z]\{5\}\|^OK$' | head -n 1 | sed 's/ERROR:  /ERR:/' || true
\\set VERBOSITY verbose
\\set ON_ERROR_STOP on
begin;
set local lock_timeout = '300ms';
$1
select 'OK';
rollback;
SQL
  }
  local p_unpub p_del p_replace p_update p_publish p_other
  p_unpub="$(probe "update public.books set status = 'draft', published_at = null where id = '$A3';")"
  p_del="$(probe "delete from public.books where id = '$A1';")"
  p_replace="$(probe "set local role service_role; select 1 from $(replace_call "$A2" "$A5");")"
  p_update="$(probe "set local role service_role; select 1 from $(update_call "Other" "" 0 null false null "$A2" "$A5");")"
  p_publish="$(probe "update public.bundles set status = 'published' where id = '$BUNDLE';")"
  # Control: a book the open writer did NOT select is not locked by it.
  p_other="$(probe "update public.books set status = 'draft', published_at = null where id = '$A6';")"
  touch "$release"
  wait "$wpid" || { cat "$WORKDIR/${label}.writer" >&2; fail "$label: the open writer errored"; }
  local final want; final="$(members)"; want="$(sorted_set "$A1" "$A3")"
  [ "$p_update" = "ERR:55P03" ] || fail "$label: a complete edit during the write gave '$p_update', expected ERR:55P03 (it must wait on the bundle row)"
  [ "$p_publish" = "ERR:55P03" ] || fail "$label: publishing the bundle during the write gave '$p_publish', expected ERR:55P03"
  [ "$p_unpub" = "ERR:55P03" ] || fail "$label: unpublishing a selected book during the write gave '$p_unpub', expected ERR:55P03 (it must wait on the writer's FOR SHARE)"
  [ "$p_del" = "ERR:55P03" ] || fail "$label: deleting a selected book during the write gave '$p_del', expected ERR:55P03"
  [ "$p_replace" = "ERR:55P03" ] || fail "$label: a second replacement during the write gave '$p_replace', expected ERR:55P03 (it must wait on the bundle row)"
  [ "$p_other" = "OK" ] || fail "$label: an unselected book was blocked ('$p_other') -- the control shows the lock is not scoped to the selection"
  [ "$final" = "$want" ] || fail "$label: membership after commit is '$final', expected '$want'"
  if [ "$kind" = update ]; then
    local fs; fs="$(state)"
    [ "$fs" = "$(state_of "Open" "desc O" 0 draft "$A1" "$A3")" ] || fail "$label: the committed edit left '$fs'"
  fi
  echo "  ok [$label]: while a $kind is open its books cannot be unpublished/deleted and its bundle cannot be replaced, edited or published (55P03 each); an unselected book is free; commit leaves '$final'"
}

SCENARIOS="${SCENARIOS:-}"
RAN=0
run() {
  local name="$1"
  shift
  if [ -n "$SCENARIOS" ] && [[ " $SCENARIOS " != *" $name "* ]]; then return 0; fi
  "scenario_$name" "$@"
  RAN=$((RAN + 1))
}

echo "069 bundle membership contention ($DB, $ROUNDS round(s)${SCENARIOS:+, only: $SCENARIOS})"
for r in $(seq 1 "$ROUNDS"); do
  run concurrent_replace "$r"
  run book_change "$r" unpublish commit refused
  run book_change "$r" unpublish rollback succeeds
  run book_change "$r" delete commit refused
  run create_unpublish "$r"
  run writer_holds_locks "$r" replace
  run writer_holds_locks "$r" update
  run concurrent_update "$r"
  run concurrent_update_cas "$r"
  run cas "$r" publish commit
  run cas "$r" publish rollback
  run cas "$r" reprice commit
  run update_unpublish "$r"
  run split_flow_control "$r"
done
[ "$RAN" -gt 0 ] || fail "no scenario matched SCENARIOS='$SCENARIOS'"
echo "PASS 069_bundle_membership_contention"
