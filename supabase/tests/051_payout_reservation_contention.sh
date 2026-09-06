#!/usr/bin/env bash
# Two-connection proof that
# author_payouts_one_active_per_author_currency_idx (migration 051)
# actually excludes a second, concurrent reserve_author_payout() call
# for the same author+currency -- not just that the RPC's own
# sequential logic would prevent it (already covered deterministically
# in 051_author_payout_foundation.test.sql's "second reserve attempt in
# the same transaction" case), but that two REAL, separate Postgres
# backends racing the exact same reservation can never both succeed.
#
# A single psql connection can't run two overlapping transactions at
# once, so this can't be proven from inside the main .sql suite alone
# -- it needs two real, separate connections, exactly like
# 032_advisory_lock_contention.sh's own reasoning for existing as a
# separate script. Kept separate for the same reason that script gives:
# this is timing-adjacent (uses a bounded poll for a starting-gun
# barrier only, never for the assertion itself, which is a plain
# row-count check), so a flake here should never block the rest of the
# regression suite.
#
# Unlike 032's script (which proves one session BLOCKS while another
# HOLDS a lock, needing a hold-then-try ordering), this test wants both
# attempts to race with no artificial ordering -- so instead of a
# "signal when holding" marker, both racing subshells poll-wait on one
# shared "go" file, created by the orchestrator only once both racers
# are already spawned and waiting, then fire their single
# reserve_author_payout() call as close to simultaneously as this
# harness allows.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/051_payout_reservation_contention.sh
# (or pass the database name as $1). Requires psql on PATH, migration
# 051 already applied, and a database whose author_payout_settings/
# author_ledger_entries/author_payouts fixtures for the fixed test
# author id below are safe to delete and reseed. Exits non-zero on any
# assertion failure or setup timeout.

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

AUTHOR_ID="e0510000-0000-0000-0000-000000000001"
BOOK_ID="e0510000-0000-0000-0000-000000000002"
PURCHASE_ID="e0510000-0000-0000-0000-000000000003"
LEDGER_ID="e0510000-0000-0000-0000-000000000004"

# Fixtures must be COMMITTED (not wrapped in a rolled-back transaction,
# unlike the rest of this repo's SQL test convention) -- two genuinely
# separate connections need to see them. Cleans up any leftover rows
# from a prior failed run first, so this script is safely rerunnable.
psql -d "$DB" -v ON_ERROR_STOP=1 > /dev/null <<SQL
delete from public.author_payouts where author_id = '$AUTHOR_ID';
delete from public.author_payout_settings where author_id = '$AUTHOR_ID';
delete from public.author_ledger_entries where author_id = '$AUTHOR_ID';
delete from public.purchases where id = '$PURCHASE_ID';
delete from public.books where id = '$BOOK_ID';
delete from auth.users where id = '$AUTHOR_ID';

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('$AUTHOR_ID', 'p051-contention@test', now(), '{"role":"author","display_name":"Contention Test"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('$BOOK_ID', '$AUTHOR_ID', 'Contention Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('$PURCHASE_ID', '$BOOK_ID', '$AUTHOR_ID', 'cs_p051_contention', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('$LEDGER_ID', '$AUTHOR_ID', '$PURCHASE_ID', 'sale', 80, 'USD', 8000, 100, 20, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('$AUTHOR_ID', 50, 'USD');
SQL

GO="$WORKDIR/go"
RESULT_A="$WORKDIR/result_a.txt"
RESULT_B="$WORKDIR/result_b.txt"

race_attempt() {
  local out_file="$1"
  while [ ! -f "$GO" ]; do sleep 0.01; done
  psql -d "$DB" -t -A -c \
    "set role service_role; select count(*) from public.reserve_author_payout('$AUTHOR_ID', 'USD')" \
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

# Each result file's last line is the "count(*)" scalar from
# reserve_author_payout() -- 1 for the attempt that won the reservation,
# 0 for the one that lost it. `SET` (from `set role`) precedes it.
COUNT_A="$(tail -n1 "$RESULT_A")"
COUNT_B="$(tail -n1 "$RESULT_B")"

if [ "$((COUNT_A + COUNT_B))" != "1" ]; then
  echo "FAIL: expected exactly one of the two concurrent reserve_author_payout() calls to succeed, got counts $COUNT_A and $COUNT_B" >&2
  cat "$RESULT_A" >&2
  cat "$RESULT_B" >&2
  exit 1
fi

ACTIVE_ROWS="$(psql -d "$DB" -t -A -c \
  "select count(*) from public.author_payouts where author_id = '$AUTHOR_ID' and currency = 'USD' and status in ('pending','processing','reconciling')")"

if [ "$ACTIVE_ROWS" != "1" ]; then
  echo "FAIL: expected exactly 1 active payout row after the race, found $ACTIVE_ROWS" >&2
  exit 1
fi

# Clean up the committed fixtures/reservation this script created.
psql -d "$DB" -v ON_ERROR_STOP=1 > /dev/null <<SQL
delete from public.author_payouts where author_id = '$AUTHOR_ID';
delete from public.author_payout_settings where author_id = '$AUTHOR_ID';
delete from public.author_ledger_entries where author_id = '$AUTHOR_ID';
delete from public.purchases where id = '$PURCHASE_ID';
delete from public.books where id = '$BOOK_ID';
delete from auth.users where id = '$AUTHOR_ID';
SQL

echo "PASS: 051_payout_reservation_contention.sh -- exactly one of two genuinely concurrent reserve_author_payout() calls for the same author+currency succeeded"
