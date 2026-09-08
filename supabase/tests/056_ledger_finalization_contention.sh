#!/usr/bin/env bash
# Two-connection proof that two genuinely concurrent, IDENTICAL
# finalize_ledger_book_payment() calls for the same (payment_event,
# provider_payment_id) converge to exactly one financial history -- not
# just that the RPC's own sequential retry logic would prevent
# duplication (already covered deterministically in
# 056_ledger_v1_transactional_payment_foundation.test.sql's Part 7 late-
# retry case), but that two REAL, separate Postgres backends racing the
# exact same webhook delivery can never both create a payments/ledger
# row, or deadlock against each other's locks.
#
# This is the realistic concurrency scenario this migration's own
# wrapper design exists to handle: Stripe (or any provider) redelivering
# the SAME checkout.session.completed event to two overlapping webhook
# requests. It is NOT a synthetic race with no real-world analogue --
# see finalize_ledger_book_payment()'s own row locks (payment_events
# `for update`, book_checkout_intents `for update`) and record_
# successful_sale()'s own payments-row insert-or-conflict, both of which
# this script exercises for real, under real backend-to-backend
# contention, exactly like 032_advisory_lock_contention.sh and
# 051_payout_reservation_contention.sh already do for their own RPCs.
#
# Expected outcome: BOTH concurrent calls complete successfully (no
# error, no deadlock). The winner reports 'eligible_fulfilled'; the
# second to acquire the row locks resolves via
# finalize_book_checkout_intent_entitlement_core's own
# 'already_finalized' outcome, then record_successful_sale's own
# retry-idempotency (same purchase, same economics) recognizes it as
# already-recorded rather than erroring. Exactly one payments row, one
# sale ledger row, and the payment_event lands 'processed'.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/056_ledger_finalization_contention.sh
# (or pass the database name as $1). Requires psql on PATH, migration
# 056 already applied, and a database whose fixtures for the fixed ids
# below are safe to delete and reseed. Exits non-zero on any assertion
# failure, error, or setup timeout.

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

AUTHOR_ID="e0560900-0000-0000-0000-000000000001"
READER_ID="e0560900-0000-0000-0000-000000000002"
BOOK_ID="e0560900-0000-0000-0000-000000000003"

# Fixtures must be COMMITTED (not wrapped in a rolled-back transaction,
# unlike the rest of this repo's SQL test convention) -- two genuinely
# separate connections need to see them. Cleans up any leftover rows
# from a prior failed run first, so this script is safely rerunnable.
# create_book_checkout_intent()/record_payment_event() are run here
# (as the connecting superuser/table-owner, which retains implicit
# EXECUTE regardless of any grant) to produce a real, RPC-created
# intent/event pair, exactly what a genuine webhook delivery would have.
SETUP_OUT="$(psql -d "$DB" -v ON_ERROR_STOP=1 -q -t -A <<SQL
begin;

-- author_ledger_entries must go before purchases/payments: its sale rows
-- require a non-null purchase_id/payment_id (author_ledger_entries_check3,
-- author_ledger_entries_sale_requires_payment_id), but both FKs are ON
-- DELETE SET NULL -- deleting purchases/payments first while a sale row
-- still references them would try to null the column and hit the check.
delete from public.author_ledger_entries where payment_id in (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_contention');
delete from public.purchases where book_id = '$BOOK_ID';
delete from public.book_checkout_intents where book_id = '$BOOK_ID';
delete from public.payment_events where provider = 'stripe' and provider_event_id = 'evt_p056_contention';
delete from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_contention';
delete from public.books where id = '$BOOK_ID';
delete from auth.users where id in ('$AUTHOR_ID', '$READER_ID');

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('$AUTHOR_ID', 'p056-contention-author@test', now(), '{"role":"author","display_name":"Contention Author"}'),
  ('$READER_ID', 'p056-contention-reader@test', now(), '{"role":"reader","display_name":"Contention Reader"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('$BOOK_ID', '$AUTHOR_ID', 'Contention Book', '', '', '', 500, 'published');

set local role authenticated;
select set_config('request.jwt.claim.sub', '$READER_ID', true);
select intent_id, price_cents_at_checkout
  from public.create_book_checkout_intent('$BOOK_ID'::uuid, null, 'librum_ledger_v1', 'ALL', 8000);
reset role;

set local role service_role;
select id from public.record_payment_event('stripe', 'evt_p056_contention', 'checkout.session.completed', 'pi_p056_contention');
reset role;

select now();

commit;
SQL
)"

INTENT_ID="$(echo "$SETUP_OUT" | sed -n '2p' | cut -d'|' -f1)"
PRICE_CENTS="$(echo "$SETUP_OUT" | sed -n '2p' | cut -d'|' -f2)"
EVENT_ID="$(echo "$SETUP_OUT" | sed -n '3p')"
PAID_AT="$(echo "$SETUP_OUT" | tail -n1)"

if [ -z "$INTENT_ID" ] || [ -z "$EVENT_ID" ] || [ -z "$PAID_AT" ]; then
  echo "FAIL: setup did not produce a usable intent_id/event_id/paid_at (got intent='$INTENT_ID' event='$EVENT_ID' paid_at='$PAID_AT')" >&2
  echo "$SETUP_OUT" >&2
  exit 1
fi

GO="$WORKDIR/go"
RESULT_A="$WORKDIR/result_a.txt"
RESULT_B="$WORKDIR/result_b.txt"


# PAID_AT is a single timestamp captured once during setup, not each
# racer's own now() -- a real redelivered webhook carries the SAME
# provider-supplied timestamp on every delivery, and record_successful_sale
# intentionally rejects two DIFFERENT paid_at values for the same
# provider_payment_id as a distinct payment claim, not a retry.
race_attempt() {
  local out_file="$1"
  while [ ! -f "$GO" ]; do sleep 0.01; done
  psql -d "$DB" -t -A -c \
    "set role service_role; select outcome from public.finalize_ledger_book_payment('$EVENT_ID'::uuid, '$INTENT_ID'::uuid, 'stripe', 'pi_p056_contention', $PRICE_CENTS::bigint, 'ALL', '$PAID_AT'::timestamptz)" \
    > "$out_file" 2>&1
}

race_attempt "$RESULT_A" &
PID_A=$!
race_attempt "$RESULT_B" &
PID_B=$!

sleep 0.3
touch "$GO"

set +e
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
set -e

if [ "$RC_A" != "0" ] || [ "$RC_B" != "0" ]; then
  echo "FAIL: both concurrent finalize_ledger_book_payment() calls must succeed with no error/deadlock (rc_a=$RC_A rc_b=$RC_B)" >&2
  cat "$RESULT_A" >&2
  cat "$RESULT_B" >&2
  exit 1
fi

OUTCOME_A="$(tail -n1 "$RESULT_A")"
OUTCOME_B="$(tail -n1 "$RESULT_B")"

# The entitlement core's outcome legitimately differs between the two
# racers: whichever backend's `for update` lock loses the race sees the
# intent already finalized by the winner and reports 'already_finalized'
# (not an error) -- finalize_ledger_book_payment does not special-case
# this outcome away (STRIPE-CUTOVER-1B.3 Section 7), it proceeds to
# record_successful_sale either way, whose OWN idempotency (Part 13) is
# what actually converges both racers on one financial history. So the
# expected, order-independent result is exactly one 'eligible_fulfilled'
# and exactly one 'already_finalized' across the two racers.
SORTED_OUTCOMES="$(printf '%s\n%s\n' "$OUTCOME_A" "$OUTCOME_B" | sort | tr '\n' ',' )"
if [ "$SORTED_OUTCOMES" != "already_finalized,eligible_fulfilled," ]; then
  echo "FAIL: expected exactly one 'eligible_fulfilled' and one 'already_finalized' across the two racers, got '$OUTCOME_A' and '$OUTCOME_B'" >&2
  exit 1
fi

PAYMENT_ROWS="$(psql -d "$DB" -t -A -c \
  "select count(*) from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_contention'")"
SALE_ROWS="$(psql -d "$DB" -t -A -c \
  "select count(*) from public.author_ledger_entries ale join public.payments p on p.id = ale.payment_id where p.provider = 'stripe' and p.provider_payment_id = 'pi_p056_contention' and ale.entry_type = 'sale'")"
PURCHASE_ROWS="$(psql -d "$DB" -t -A -c \
  "select count(*) from public.purchases where book_id = '$BOOK_ID' and reader_id = '$READER_ID'")"
EVENT_STATUS="$(psql -d "$DB" -t -A -c \
  "select status from public.payment_events where id = '$EVENT_ID'")"

if [ "$PAYMENT_ROWS" != "1" ]; then
  echo "FAIL: expected exactly 1 payments row after the race, found $PAYMENT_ROWS (no duplicate payment)" >&2
  exit 1
fi
if [ "$SALE_ROWS" != "1" ]; then
  echo "FAIL: expected exactly 1 sale ledger row after the race, found $SALE_ROWS (no duplicate sale rows)" >&2
  exit 1
fi
if [ "$PURCHASE_ROWS" != "1" ]; then
  echo "FAIL: expected exactly 1 purchases row after the race, found $PURCHASE_ROWS" >&2
  exit 1
fi
if [ "$EVENT_STATUS" != "processed" ]; then
  echo "FAIL: expected payment_event status='processed' after the race, found '$EVENT_STATUS' (event processed consistently)" >&2
  exit 1
fi

# Clean up the committed fixtures this script created. author_ledger_entries
# must be deleted before purchases/payments -- see the matching comment in
# the setup block above.
psql -d "$DB" -v ON_ERROR_STOP=1 > /dev/null <<SQL
delete from public.author_ledger_entries where payment_id in (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_contention');
delete from public.purchases where book_id = '$BOOK_ID';
delete from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_contention';
delete from public.book_checkout_intents where book_id = '$BOOK_ID';
delete from public.payment_events where provider = 'stripe' and provider_event_id = 'evt_p056_contention';
delete from public.books where id = '$BOOK_ID';
delete from auth.users where id in ('$AUTHOR_ID', '$READER_ID');
SQL

echo "PASS: 056_ledger_finalization_contention.sh -- two genuinely concurrent, identical finalize_ledger_book_payment() calls converged to exactly one financial history, no deadlock"
