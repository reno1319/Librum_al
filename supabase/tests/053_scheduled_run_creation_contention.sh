#!/usr/bin/env bash
# Two-connection proof that the (run_type, run_key) partial unique
# index on payout_runs (migration 051), exercised through
# start_scheduled_payout_run() (migration 053), actually excludes a
# second, concurrent scheduled-run creation for the same target month
# -- not just that the RPC's own sequential logic would prevent it
# (already covered deterministically in
# 053_payout_scheduler_foundation.test.sql's own R2 "same target month
# retry" case), but that two REAL, separate Postgres backends racing
# the exact same monthly run identity can never both create a row.
#
# A single psql connection can't run two overlapping transactions at
# once, so this can't be proven from inside the main .sql suite alone
# -- it needs two real, separate connections, exactly like
# 032_advisory_lock_contention.sh's and
# 051_payout_reservation_contention.sh's own reasoning for existing as
# separate scripts. Kept separate for the same reason those give: this
# is timing-adjacent (uses a bounded poll for a starting-gun barrier
# only, never for the assertion itself, which is a plain row-count/
# row-id check), so a flake here should never block the rest of the
# regression suite.
#
# Unlike 032's script (which proves one session BLOCKS while another
# HOLDS a lock), and much like 051's own script, this test wants both
# attempts to race with no artificial ordering -- so both racing
# subshells poll-wait on one shared "go" file, created by the
# orchestrator only once both racers are already spawned and waiting,
# then fire their single start_scheduled_payout_run() call as close to
# simultaneously as this harness allows.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/053_scheduled_run_creation_contention.sh
# (or pass the database name as $1). Requires psql on PATH, migration
# 053 already applied, and a database whose payout_runs fixture for the
# fixed target month below is safe to delete and reseed. Exits non-zero
# on any assertion failure or setup timeout.

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# A fixed, safely-in-the-past target month so this script never
# collides with "the current month" (which the SQL suite's own R1/R2
# fixtures also use) and never trips the future-month rejection
# regardless of when this script is actually run.
TARGET_MONTH_SQL="date_trunc('month', now() - interval '11 months')::date"

# Fixtures/results must be COMMITTED (not wrapped in a rolled-back
# transaction, unlike the rest of this repo's SQL test convention) --
# two genuinely separate connections need to see them. Cleans up any
# leftover row from a prior failed run first, so this script is safely
# rerunnable.
psql -d "$DB" -v ON_ERROR_STOP=1 > /dev/null <<SQL
delete from public.payout_runs
where run_type = 'scheduled'
  and run_key = 'monthly:' || to_char($TARGET_MONTH_SQL, 'YYYY-MM');
SQL

GO="$WORKDIR/go"
RESULT_A="$WORKDIR/result_a.txt"
RESULT_B="$WORKDIR/result_b.txt"

race_attempt() {
  local out_file="$1"
  while [ ! -f "$GO" ]; do sleep 0.01; done
  psql -d "$DB" -t -A -c \
    "set role service_role; select payout_run_id, is_new from public.start_scheduled_payout_run($TARGET_MONTH_SQL)" \
    > "$out_file" 2>&1
}

race_attempt "$RESULT_A" &
PID_A=$!
race_attempt "$RESULT_B" &
PID_B=$!

# Give both subshells time to reach their wait-loop before firing the
# starting gun -- this is setup synchronization only, not the
# assertion itself.
sleep 0.3
touch "$GO"

wait "$PID_A"
wait "$PID_B"

# Each result file's last line is "payout_run_id|is_new" from
# start_scheduled_payout_run() -- `SET` (from `set role`) precedes it.
ROW_A="$(tail -n1 "$RESULT_A")"
ROW_B="$(tail -n1 "$RESULT_B")"
ID_A="$(echo "$ROW_A" | cut -d'|' -f1)"
ID_B="$(echo "$ROW_B" | cut -d'|' -f1)"
IS_NEW_A="$(echo "$ROW_A" | cut -d'|' -f2)"
IS_NEW_B="$(echo "$ROW_B" | cut -d'|' -f2)"

if [ -z "$ID_A" ] || [ -z "$ID_B" ]; then
  echo "FAIL: expected both concurrent start_scheduled_payout_run() calls to succeed and return a row id" >&2
  cat "$RESULT_A" >&2
  cat "$RESULT_B" >&2
  exit 1
fi

if [ "$ID_A" != "$ID_B" ]; then
  echo "FAIL: expected both concurrent calls to resolve to the SAME payout_runs id, got $ID_A and $ID_B" >&2
  exit 1
fi

if [ "$IS_NEW_A" = "$IS_NEW_B" ]; then
  echo "FAIL: expected exactly one of the two concurrent calls to report is_new=true (the creator) and the other is_new=false (the loser reading back the winner's row), got $IS_NEW_A and $IS_NEW_B" >&2
  exit 1
fi

ROW_COUNT="$(psql -d "$DB" -t -A -c \
  "select count(*) from public.payout_runs where run_type = 'scheduled' and run_key = 'monthly:' || to_char($TARGET_MONTH_SQL, 'YYYY-MM')")"

if [ "$ROW_COUNT" != "1" ]; then
  echo "FAIL: expected exactly 1 payout_runs row for the raced target month, found $ROW_COUNT" >&2
  exit 1
fi

# Clean up the committed fixture this script created.
psql -d "$DB" -v ON_ERROR_STOP=1 > /dev/null <<SQL
delete from public.payout_runs
where run_type = 'scheduled'
  and run_key = 'monthly:' || to_char($TARGET_MONTH_SQL, 'YYYY-MM');
SQL

echo "PASS: 053_scheduled_run_creation_contention.sh -- both concurrent start_scheduled_payout_run() calls for the same target month resolved to exactly one payout_runs row, no deadlock"
