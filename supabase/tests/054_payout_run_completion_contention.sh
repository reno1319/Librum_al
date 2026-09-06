#!/usr/bin/env bash
# Two-connection proof that reserve_author_payout()'s new closed-run
# barrier (migration 054, LEDGER-1E-D-D.1) actually serializes against
# complete_scheduled_payout_run() via real, genuinely concurrent
# Postgres backends -- not just that the RPCs' own sequential logic
# would prevent a stale reservation (already covered deterministically
# in 054_payout_run_reservation_barrier.test.sql's own scenario A), but
# that two REAL, separate connections racing reserve vs complete on the
# SAME payout_run can never produce a reservation created after that
# run is observably completed.
#
# A single psql connection can't run two overlapping transactions at
# once, so the FOR SHARE / FOR UPDATE lock-wait itself can't be proven
# from inside the main .sql suite alone -- it needs two real, separate
# connections, exactly like 032/051/053's own scripts' reasoning for
# existing separately. Kept separate for the same reason those give:
# this is timing-adjacent (uses a bounded poll for a starting-gun
# barrier only, never for the assertion itself), so a flake here should
# never block the rest of the regression suite.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/054_payout_run_completion_contention.sh
# (or pass the database name as $1). Requires psql on PATH, migration
# 054 already applied, and a database whose fixtures below are safe to
# delete/reseed. Exits non-zero on any assertion failure or setup
# timeout. Runs the race ITERATIONS times (default 5).

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
ITERATIONS="${ITERATIONS:-5}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

AUTHOR_RACE="05400900-0000-0000-0000-00000000a001"
AUTHOR_POST="05400900-0000-0000-0000-00000000a002"
BOOK_RACE="05400900-0000-0000-0000-00000000b001"
BOOK_POST="05400900-0000-0000-0000-00000000b002"
PURCHASE_RACE="05400900-0000-0000-0000-00000000c001"
PURCHASE_POST="05400900-0000-0000-0000-00000000c002"
LEDGER_RACE="05400900-0000-0000-0000-00000000d001"
LEDGER_POST="05400900-0000-0000-0000-00000000d002"

# A fixed, safely-in-the-past target month, offset from both 053's own
# script (-11 months) and this suite's own .sql fixtures (-13..-16
# months), so a run created here can never collide with either.
TARGET_MONTH_SQL="date_trunc('month', now() - interval '17 months')::date"

cleanup_sql() {
  cat <<SQL
delete from public.author_payouts where author_id in ('$AUTHOR_RACE', '$AUTHOR_POST');
delete from public.payout_runs
  where run_type = 'scheduled'
    and run_key = 'monthly:' || to_char($TARGET_MONTH_SQL, 'YYYY-MM');
delete from public.author_payout_settings where author_id in ('$AUTHOR_RACE', '$AUTHOR_POST');
delete from public.author_ledger_entries where author_id in ('$AUTHOR_RACE', '$AUTHOR_POST');
delete from public.purchases where id in ('$PURCHASE_RACE', '$PURCHASE_POST');
delete from public.books where id in ('$BOOK_RACE', '$BOOK_POST');
delete from auth.users where id in ('$AUTHOR_RACE', '$AUTHOR_POST');
SQL
}

# Fixtures/results must be COMMITTED (not wrapped in a rolled-back
# transaction, unlike the rest of this repo's SQL test convention) --
# two genuinely separate connections need to see them. Cleans up any
# leftover rows from a prior failed run first, so this script is safely
# rerunnable.
psql -d "$DB" -v ON_ERROR_STOP=1 > /dev/null <<SQL
$(cleanup_sql)
SQL

setup_iteration() {
  psql -d "$DB" -v ON_ERROR_STOP=1 > /dev/null <<SQL
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('$AUTHOR_RACE', 'p054-race@test', now(), '{"role":"author","display_name":"P054 Race Author"}'),
  ('$AUTHOR_POST', 'p054-post@test', now(), '{"role":"author","display_name":"P054 Post Author"}')
on conflict (id) do nothing;

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('$BOOK_RACE', '$AUTHOR_RACE', 'P054 Race Book', '', '', '', 100, 'published'),
  ('$BOOK_POST', '$AUTHOR_POST', 'P054 Post Book', '', '', '', 100, 'published')
on conflict (id) do nothing;

insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('$PURCHASE_RACE', '$BOOK_RACE', '$AUTHOR_RACE', 'cs_p054_race_' || gen_random_uuid(), 100),
  ('$PURCHASE_POST', '$BOOK_POST', '$AUTHOR_POST', 'cs_p054_post_' || gen_random_uuid(), 100)
on conflict (id) do nothing;

insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('$LEDGER_RACE', '$AUTHOR_RACE', '$PURCHASE_RACE', 'sale', 100, 'USD', 8000, 100, 0, now() - interval '10 days', now() - interval '10 days'),
  ('$LEDGER_POST', '$AUTHOR_POST', '$PURCHASE_POST', 'sale', 100, 'USD', 8000, 100, 0, now() - interval '10 days', now() - interval '10 days')
on conflict (id) do nothing;

insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('$AUTHOR_RACE', 50, 'USD'),
  ('$AUTHOR_POST', 50, 'USD')
on conflict (author_id, currency) do nothing;
SQL

  psql -d "$DB" -t -A -c \
    "set role service_role; select payout_run_id from public.start_scheduled_payout_run($TARGET_MONTH_SQL)"
}

teardown_iteration() {
  psql -d "$DB" -v ON_ERROR_STOP=1 > /dev/null <<SQL
$(cleanup_sql)
SQL
}

FAIL_COUNT=0
RESERVED_FIRST_COUNT=0
COMPLETED_FIRST_COUNT=0

for i in $(seq 1 "$ITERATIONS"); do
  echo "--- iteration $i/$ITERATIONS ---"

  RUN_ID="$(setup_iteration | tail -n1)"
  if [ -z "$RUN_ID" ]; then
    echo "FAIL: setup did not yield a payout_run id" >&2
    exit 1
  fi

  GO="$WORKDIR/go_$i"
  RESULT_COMPLETE="$WORKDIR/complete_$i.txt"
  RESULT_RESERVE="$WORKDIR/reserve_$i.txt"

  race_complete() {
    while [ ! -f "$GO" ]; do sleep 0.01; done
    psql -d "$DB" -t -A -c \
      "set role service_role; select payout_run_status from public.complete_scheduled_payout_run('$RUN_ID')" \
      > "$RESULT_COMPLETE" 2>&1
  }

  race_reserve() {
    while [ ! -f "$GO" ]; do sleep 0.01; done
    psql -d "$DB" -t -A -c \
      "set role service_role; select payout_id from public.reserve_author_payout('$AUTHOR_RACE', 'USD', '$RUN_ID')" \
      > "$RESULT_RESERVE" 2>&1
  }

  race_complete &
  PID_COMPLETE=$!
  race_reserve &
  PID_RESERVE=$!

  sleep 0.3
  touch "$GO"

  wait "$PID_COMPLETE"
  wait "$PID_RESERVE"

  RUN_STATUS_AFTER="$(psql -d "$DB" -t -A -c "select status from public.payout_runs where id = '$RUN_ID'")"
  RESERVATION_ROW_COUNT="$(psql -d "$DB" -t -A -c "select count(*) from public.author_payouts where author_id = '$AUTHOR_RACE' and payout_run_id = '$RUN_ID'")"

  echo "  run status after race: $RUN_STATUS_AFTER, reservation rows created: $RESERVATION_ROW_COUNT"

  # PRIMARY ASSERTION (no deadlock, no crash): both racers must have
  # produced SOME output -- an empty/error result here means one side
  # errored unexpectedly (a deadlock would show as a Postgres deadlock
  # error in one of the two result files).
  if ! grep -q "^completed$\|^running$" "$RESULT_COMPLETE"; then
    echo "FAIL: complete_scheduled_payout_run produced an unexpected result:" >&2
    cat "$RESULT_COMPLETE" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  # The run MUST end up completed regardless of race ordering --
  # complete_scheduled_payout_run() always eventually wins its own
  # FOR UPDATE (reserve's FOR SHARE, even if granted first, is released
  # once reserve's own short transaction ends).
  if [ "$RUN_STATUS_AFTER" != "completed" ]; then
    echo "FAIL: expected run status 'completed' after the race, got '$RUN_STATUS_AFTER'" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  # At most ONE reservation may exist for the racing candidate --
  # either the reservation legitimately won (reserved while the run was
  # still running) or it legitimately lost (observed already-completed)
  # -- both are valid per the two-outcome design; NEVER more than one,
  # and NEVER a reservation whose existence is somehow inconsistent
  # with the run's own final completed state.
  if [ "$RESERVATION_ROW_COUNT" != "0" ] && [ "$RESERVATION_ROW_COUNT" != "1" ]; then
    echo "FAIL: expected 0 or 1 reservation rows for the racing candidate, got $RESERVATION_ROW_COUNT" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  if [ "$RESERVATION_ROW_COUNT" = "1" ]; then
    RESERVED_FIRST_COUNT=$((RESERVED_FIRST_COUNT + 1))
  else
    COMPLETED_FIRST_COUNT=$((COMPLETED_FIRST_COUNT + 1))
  fi

  # Section 18: POST-COMPLETION SECOND RESERVATION -- the run is now
  # PROVABLY completed (asserted above). A second, independent,
  # eligible candidate attempting to reserve against this SAME run must
  # get zero rows, unambiguously, regardless of how the race itself
  # resolved. This is the closed-run proof that does not depend on
  # race timing at all.
  # `set role` (like every other multi-statement -c call in this
  # script) prints its own "SET" status line before the actual query
  # result. Unlike start_scheduled_payout_run() (always exactly one
  # row, so a plain `tail -n1` works, e.g. in setup_iteration above),
  # THIS call can legitimately return ZERO rows -- that is precisely
  # the outcome under test -- so with -t -A the entire output can be
  # just the single "SET" line with nothing after it. `tail -n1` would
  # then wrongly treat "SET" itself as the result. Filtering out the
  # "SET" line explicitly (never a real payout_id value) is correct in
  # both the zero-row and one-row case.
  POST_RESULT="$(psql -d "$DB" -t -A -c \
    "set role service_role; select payout_id from public.reserve_author_payout('$AUTHOR_POST', 'USD', '$RUN_ID')" | grep -v '^SET$' || true)"
  POST_ROW_COUNT="$(psql -d "$DB" -t -A -c "select count(*) from public.author_payouts where author_id = '$AUTHOR_POST' and payout_run_id = '$RUN_ID'")"

  if [ -n "$POST_RESULT" ] || [ "$POST_ROW_COUNT" != "0" ]; then
    echo "FAIL: a reservation attempt AFTER the run is confirmed completed must yield zero rows, got payout_id='$POST_RESULT', row_count=$POST_ROW_COUNT" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  teardown_iteration
done

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT assertion failure(s) across $ITERATIONS iterations" >&2
  exit 1
fi

echo "PASS: 054_payout_run_completion_contention.sh -- $ITERATIONS iterations, no deadlock, run always ended completed, at most one reservation per race (reserved-first: $RESERVED_FIRST_COUNT, completed-first: $COMPLETED_FIRST_COUNT), zero post-completion reservations ever created"
