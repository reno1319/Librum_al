#!/usr/bin/env bash
# Two-connection proof that retiring a checkout attempt and finalizing a
# payment for that same attempt cannot deadlock each other, and that
# whichever order they land in, the money still arrives.
#
# This is the one genuinely new concurrency hazard the STALE-CHECKOUT-1
# repair introduces, and the reason its lock-order change exists. Two
# operations now touch the same (intent, mapping) pair from opposite
# directions:
#
#   retire_book_checkout_attempt   advisory(reader, book) -> intent row -> mapping row
#   finalize_ledger_book_payment   payment event -> advisory(reader, book) -> intent row
#
# Before the repair, finalize took the intent row lock in its WRAPPER,
# BEFORE entering the entitlement core where the advisory lock was
# acquired. That is the classic deadlock cycle: one holds the advisory
# lock and wants the row, the other holds the row and wants the advisory
# lock. Moving the advisory acquisition ahead of the intent row lock in
# both paths is what closes it, and a proof that two real backends can
# race these two RPCs without 40P01 is the only honest evidence that it
# is actually closed -- a single connection cannot hold two overlapping
# transactions, so this cannot be shown from inside a .test.sql file.
#
# The second thing proven here matters more than the deadlock: a
# verified payment must reach fulfilment EVEN IF the attempt was retired
# and the intent superseded a moment earlier. Losing a real payment
# because a classifier called the attempt dead is the one failure in
# this design with no remedy, since no POK refund path exists. So both
# interleavings are legal, and both must end with the reader owning the
# book:
#
#   retire first   -> retire_and_superseded, then the payment completes
#                     a superseded intent (allowed by design)
#   finalize first -> the retire is refused as already_completed /
#                     already_fulfilled and mutates nothing
#
# What is NEVER legal is a deadlock, an error, or a fulfilled intent
# whose payment vanished.
#
# The race is run repeatedly, because a lock-ordering bug is a race: one
# round can pass by luck, a dozen rounds with randomized start offsets
# will not.
#
# Three phases, and they prove different things:
#
#   1   the lock order of finalize_ledger_book_payment, the POK/ledger
#       wrapper, against a constructed advisory-lock holder.
#   1B  the lock order of finalize_book_checkout_intent_entitlement_core
#       ITSELF, reached through the legacy Stripe wrapper
#       finalize_book_checkout_intent -- the one caller that adds no
#       advisory lock of its own, and therefore the only way to observe
#       the core's own acquisition. Phase 1 cannot see it: the ledger
#       wrapper already holds the lock by the time the core runs, so the
#       core's acquisition there is re-entrant and deleting it changes
#       nothing phase 1 measures. Mutation-tested both ways.
#   2   the fulfilment invariant, under a free-running race.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/059_retire_vs_finalize_contention.sh
# (or pass the database name as $1). Requires psql on PATH and a
# database carrying the STALE-CHECKOUT-1 objects. Exits non-zero on any
# deadlock, error, or assertion failure.

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
ROUNDS="${ROUNDS:-12}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

AUTHOR_ID="e0590900-0000-0000-0000-000000000001"
READER_ID="e0590900-0000-0000-0000-000000000002"
BOOK_ID="e0590900-0000-0000-0000-000000000003"
# Phase 1B uses its own book so that its advisory key -- (reader, book)
# -- is disjoint from phase 1's and phase 2's, and neither phase can
# serialize against the other by accident and mask what it is testing.
BOOK2_ID="e0590900-0000-0000-0000-000000000004"

cleanup_sql() {
  cat <<SQL
delete from public.author_ledger_entries where payment_id in (
  select id from public.payments where provider = 'pok' and provider_payment_id like 'pi_p059_%');
delete from public.purchases where book_id in ('$BOOK_ID', '$BOOK2_ID');
delete from public.pok_book_checkout_orders where intent_id in (
  select id from public.book_checkout_intents where book_id in ('$BOOK_ID', '$BOOK2_ID'));
delete from public.book_checkout_intents where book_id in ('$BOOK_ID', '$BOOK2_ID');
delete from public.payment_events where provider = 'pok' and provider_event_id like 'evt_p059_%';
delete from public.payments where provider = 'pok' and provider_payment_id like 'pi_p059_%';
delete from public.books where id in ('$BOOK_ID', '$BOOK2_ID');
delete from auth.users where id in ('$AUTHOR_ID', '$READER_ID');
SQL
}

# Fixtures must be COMMITTED, unlike the rest of this repo's SQL test
# convention: two genuinely separate connections have to see them.
psql -d "$DB" -v ON_ERROR_STOP=1 -q > /dev/null <<SQL
begin;
$(cleanup_sql)
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('$AUTHOR_ID', 'p059-contention-author@test', now(), '{"role":"author","display_name":"Contention Author"}'),
  ('$READER_ID', 'p059-contention-reader@test', now(), '{"role":"reader","display_name":"Contention Reader"}');
-- ALL-CHECKOUT-1: price_all is required now -- the RPC prices from it
-- and refuses a null. Both books freeze 50000 minor units (500 lek).
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, price_all, status) values
  ('$BOOK_ID', '$AUTHOR_ID', 'Retire Contention Book', '', '', '', 500, 500, 'published'),
  ('$BOOK2_ID', '$AUTHOR_ID', 'Core Lock Order Book', '', '', '', 500, 500, 'published');
commit;
SQL

RETIRED_FIRST=0
FINALIZE_FIRST=0

# ============================================================
# Phase 1: the DETERMINISTIC deadlock probe.
#
# Racing the two RPCs with sleep offsets and hoping to land in the cycle
# is not evidence: mutation-testing this harness against a build with
# the pre-repair lock order showed it catching the deadlock on one run
# and passing on the next. A lock-order proof that only works when the
# scheduler cooperates proves nothing.
#
# So the cycle is CONSTRUCTED instead of hoped for. Session R opens a
# transaction and takes the (reader, book) advisory lock by hand -- the
# same key, which retire_book_checkout_attempt itself re-acquires
# re-entrantly a moment later, so this is the state that function is
# genuinely in, not a synthetic one. Session F then runs finalize while
# R holds it:
#
#   pre-repair order  F takes the intent ROW lock, then wants the
#                     advisory lock R holds; R wants the row F holds.
#                     Postgres reports 40P01. Deterministically.
#   repaired order    F wants the advisory lock FIRST, holding no row
#                     lock at all, so it simply waits; R finishes,
#                     commits, and F proceeds.
#
# The whole difference between the two builds is which lock F reaches
# for first, and that is exactly what this phase observes.
# ============================================================
probe_intent_setup() {
  PROBE_CLAIM="$(psql -d "$DB" -t -A -c "select gen_random_uuid()")"
  PROBE_OUT="$(psql -d "$DB" -v ON_ERROR_STOP=1 -q -t -A <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$READER_ID', true);
select intent_id, price_cents_at_checkout
  from public.create_book_checkout_intent('$BOOK_ID'::uuid, null);
reset role;
commit;
SQL
)"
  PROBE_INTENT="$(echo "$PROBE_OUT" | sed -n '2p' | cut -d'|' -f1)"
  PROBE_PRICE="$(echo "$PROBE_OUT" | sed -n '2p' | cut -d'|' -f2)"

  PROBE_EVENT_OUT="$(psql -d "$DB" -v ON_ERROR_STOP=1 -q -t -A <<SQL
begin;
insert into public.pok_book_checkout_orders
  (intent_id, merchant_custom_reference, provider_order_id, checkout_url,
   creation_claim_id, state, provider_window_ends_at)
values ('$PROBE_INTENT', 'book:$PROBE_INTENT', 'ord_p059_probe',
        'https://pay-staging.pokpay.io/sdk-orders/ord_p059_probe',
        '$PROBE_CLAIM', 'ready', now() + interval '30 minutes');
set local role service_role;
select id from public.record_payment_event('pok', 'evt_p059_probe', 'pok.order.payment_verified', 'pi_p059_probe');
reset role;
select now();
commit;
SQL
)"
  PROBE_EVENT="$(echo "$PROBE_EVENT_OUT" | sed -n '1p')"
  PROBE_PAID_AT="$(echo "$PROBE_EVENT_OUT" | tail -n1)"

  if [ -z "$PROBE_INTENT" ] || [ -z "$PROBE_EVENT" ]; then
    echo "FAIL: deadlock probe setup produced no intent/event" >&2
    echo "$PROBE_OUT" >&2
    echo "$PROBE_EVENT_OUT" >&2
    exit 1
  fi
}

probe_intent_setup

PROBE_MARKER="$WORKDIR/probe_holder_ready"
PROBE_R="$WORKDIR/probe_retire.txt"
PROBE_F="$WORKDIR/probe_finalize.txt"

cat > "$WORKDIR/probe_hold.sql" <<'SQLEOF'
\o /dev/null
begin;
select pg_advisory_xact_lock(hashtext(:'reader'), hashtext(:'book'));
\o
\! touch __MARKER__
select pg_sleep(3);
set role service_role;
\o
select public.retire_book_checkout_attempt(
  :'intent'::uuid, :'claim'::uuid, 'ord_p059_probe', 'ready', 'provider_attempt_expired');
commit;
SQLEOF
sed -i "s#__MARKER__#$PROBE_MARKER#" "$WORKDIR/probe_hold.sql"

psql -d "$DB" -t -A \
  -v reader="$READER_ID" -v book="$BOOK_ID" \
  -v intent="$PROBE_INTENT" -v claim="$PROBE_CLAIM" \
  -f "$WORKDIR/probe_hold.sql" > "$PROBE_R" 2>&1 &
PROBE_PID=$!

waited=0
until [ -f "$PROBE_MARKER" ]; do
  sleep 0.05
  waited=$((waited + 1))
  if [ "$waited" -ge 200 ]; then
    echo "FAIL: the advisory-lock holder never signaled (10s timeout)" >&2
    kill "$PROBE_PID" 2>/dev/null || true
    exit 1
  fi
done

# R now holds the advisory lock and is asleep. F runs into it.
psql -d "$DB" -t -A -c \
  "set role service_role; select outcome from public.finalize_ledger_book_payment('$PROBE_EVENT'::uuid, '$PROBE_INTENT'::uuid, 'pok', 'pi_p059_probe', $PROBE_PRICE::bigint, 'ALL', '$PROBE_PAID_AT'::timestamptz)" \
  > "$PROBE_F" 2>&1 &
PROBE_F_PID=$!

set +e
wait "$PROBE_PID"; PROBE_RC_R=$?
wait "$PROBE_F_PID"; PROBE_RC_F=$?
set -e

if grep -qi "deadlock" "$PROBE_R" "$PROBE_F"; then
  echo "FAIL: DEADLOCK -- finalize_ledger_book_payment reaches for the intent row lock before the (reader, book) advisory lock, so it can cycle with retire_book_checkout_attempt" >&2
  cat "$PROBE_R" "$PROBE_F" >&2
  exit 1
fi
if [ "$PROBE_RC_R" != "0" ] || [ "$PROBE_RC_F" != "0" ]; then
  echo "FAIL: the deadlock probe errored (rc_retire=$PROBE_RC_R rc_finalize=$PROBE_RC_F)" >&2
  cat "$PROBE_R" "$PROBE_F" >&2
  exit 1
fi
if [ "$(tail -n1 "$PROBE_F")" != "eligible_fulfilled" ]; then
  echo "FAIL: the probe's payment did not fulfil (got '$(tail -n1 "$PROBE_F")')" >&2
  cat "$PROBE_F" >&2
  exit 1
fi

psql -d "$DB" -v ON_ERROR_STOP=1 -q > /dev/null <<SQL
delete from public.author_ledger_entries where payment_id in (
  select id from public.payments where provider = 'pok' and provider_payment_id = 'pi_p059_probe');
delete from public.purchases where book_id = '$BOOK_ID';
delete from public.payments where provider = 'pok' and provider_payment_id = 'pi_p059_probe';
SQL

echo "  deadlock probe: clean -- finalize waited on the advisory lock instead of cycling"

# ============================================================
# Phase 1B: the ENTITLEMENT CORE's own lock order, proven through the
# LEGACY Stripe wrapper.
#
# Phase 1 above proves the lock order of finalize_ledger_book_payment.
# It cannot prove the lock order of
# finalize_book_checkout_intent_entitlement_core, and that distinction
# is not pedantry: the ledger wrapper takes the (reader, book) advisory
# lock ITSELF, before its own intent row lock, and the core's
# acquisition is then merely re-entrant. Delete the core's acquisition
# outright and phase 1 still passes -- the wrapper is already holding
# the lock. So phase 1 is evidence about the wrapper only.
#
# The core is reachable by a second caller that holds no advisory lock
# of its own: public.finalize_book_checkout_intent, the legacy
# legacy_stripe_connect_v1 RPC the live Stripe webhook still calls. It
# validates the regime with an unlocked read and delegates straight to
# the core, so on that path the core's own acquisition is the ONLY one
# there is. That is the path this phase drives.
#
# The contender is constructed rather than raced, for the same reason
# phase 1 constructs its own: a lock-order bug that only shows up when
# the scheduler cooperates is not evidence. Session R takes the
# (reader, book) advisory lock by hand and then, after a pause, the
# intent ROW lock -- exactly, and only, the acquisition sequence
# retire_book_checkout_attempt performs (advisory, then the intent row).
# Nothing here is synthetic about that order; it is the order the real
# function uses, isolated from the rest of its body so that the core,
# not the mapping table, is what is under test. Session F then calls
# the legacy RPC while R is paused.
#
#   repaired core   F asks for the advisory lock FIRST, holding no row
#                   lock, so it simply waits. R takes the row, commits,
#                   and only then does F proceed. F therefore CANNOT
#                   finish before R has released -- which is the
#                   property the whole move exists to buy, and which
#                   this phase measures directly.
#
#   advisory moved back below the row lock (the pre-repair order)
#                   F takes the intent row while R is paused, then asks
#                   for the advisory lock R holds; R wakes and asks for
#                   the row F holds. Postgres reports 40P01.
#                   Deterministically.
#
#   advisory deleted from the core entirely
#                   F never asks for the advisory lock at all, so there
#                   is no deadlock -- and no mutual exclusion either. F
#                   finalizes and commits while R still holds the lock.
#                   No deadlock check would notice; the release-order
#                   assertion below does.
#
# Both mutants are therefore caught, and by different assertions.
# ============================================================
# ALL-CHECKOUT-1: this legacy intent used to be minted through the RPC
# with p_regime/p_currency. No authenticated caller can do that any
# more, so the row is inserted directly as the connecting table owner.
# The probe needs a legacy intent only because the core's lock order is
# what is under observation here; how the row came to exist is
# irrelevant to that, and keeping an authenticated route capable of
# minting one would defeat the change this harness runs against.
PROBE2_SETUP="$(psql -d "$DB" -v ON_ERROR_STOP=1 -q -t -A <<SQL
begin;
select set_config('request.jwt.claim.sub', '$READER_ID', true);
insert into public.book_checkout_intents
  (book_id, reader_id, book_title, price_cents_at_checkout, expires_at,
   regime, currency, royalty_rate_bps)
values ('$BOOK2_ID', '$READER_ID', 'Core Lock Order Book', 500,
        now() + interval '23 hours', 'legacy_stripe_connect_v1', 'USD', null)
returning id, price_cents_at_checkout;
commit;
SQL
)"
PROBE2_INTENT="$(echo "$PROBE2_SETUP" | sed -n '2p' | cut -d'|' -f1)"
PROBE2_PRICE="$(echo "$PROBE2_SETUP" | sed -n '2p' | cut -d'|' -f2)"

if [ -z "$PROBE2_INTENT" ] || [ -z "$PROBE2_PRICE" ]; then
  echo "FAIL: core lock-order probe setup produced no legacy intent" >&2
  echo "$PROBE2_SETUP" >&2
  exit 1
fi

PROBE2_READY="$WORKDIR/core_holder_ready"
PROBE2_RELEASED="$WORKDIR/core_holder_released"
PROBE2_ORDER="$WORKDIR/core_release_order"
PROBE2_R="$WORKDIR/core_hold.txt"
PROBE2_F="$WORKDIR/core_finalize.txt"

# R: advisory lock, pause, intent row lock, commit. The RELEASED marker
# is written while the transaction is still open and still holding both
# locks, so "F saw RELEASED" can only mean F ran after R's COMMIT -- the
# marker cannot race ahead of the release it stands for.
cat > "$WORKDIR/core_hold.sql" <<'SQLEOF'
\o /dev/null
begin;
select pg_advisory_xact_lock(hashtext(:'reader'), hashtext(:'book'));
\o
\! touch __READY__
select pg_sleep(3);
\o /dev/null
select id from public.book_checkout_intents where id = :'intent'::uuid for update;
\o
\! touch __RELEASED__
commit;
SQLEOF
sed -i "s#__READY__#$PROBE2_READY#; s#__RELEASED__#$PROBE2_RELEASED#" "$WORKDIR/core_hold.sql"

psql -d "$DB" -t -A \
  -v reader="$READER_ID" -v book="$BOOK2_ID" -v intent="$PROBE2_INTENT" \
  -f "$WORKDIR/core_hold.sql" > "$PROBE2_R" 2>&1 &
PROBE2_PID=$!

waited=0
until [ -f "$PROBE2_READY" ]; do
  sleep 0.05
  waited=$((waited + 1))
  if [ "$waited" -ge 200 ]; then
    echo "FAIL: the core probe's advisory-lock holder never signaled (10s timeout)" >&2
    kill "$PROBE2_PID" 2>/dev/null || true
    exit 1
  fi
done

(
  psql -d "$DB" -t -A -c \
    "set role service_role; select outcome from public.finalize_book_checkout_intent('$PROBE2_INTENT'::uuid, 'cs_p059_core', 'pi_p059_core', $PROBE2_PRICE::integer)" \
    > "$PROBE2_F" 2>&1
  if [ -f "$PROBE2_RELEASED" ]; then echo "after" > "$PROBE2_ORDER"; else echo "before" > "$PROBE2_ORDER"; fi
) &
PROBE2_F_PID=$!

set +e
wait "$PROBE2_PID"; PROBE2_RC_R=$?
wait "$PROBE2_F_PID"; PROBE2_RC_F=$?
set -e

if grep -qi "deadlock" "$PROBE2_R" "$PROBE2_F"; then
  echo "FAIL: DEADLOCK -- finalize_book_checkout_intent_entitlement_core reaches for the intent row lock before the (reader, book) advisory lock, so the legacy Stripe path can cycle with retire_book_checkout_attempt" >&2
  cat "$PROBE2_R" "$PROBE2_F" >&2
  exit 1
fi
if [ "$PROBE2_RC_R" != "0" ] || [ "$PROBE2_RC_F" != "0" ]; then
  echo "FAIL: the core lock-order probe errored (rc_holder=$PROBE2_RC_R rc_finalize=$PROBE2_RC_F)" >&2
  cat "$PROBE2_R" "$PROBE2_F" >&2
  exit 1
fi
if [ "$(tail -n1 "$PROBE2_F")" != "eligible_fulfilled" ]; then
  echo "FAIL: the core probe's legacy finalization did not fulfil (got '$(tail -n1 "$PROBE2_F")')" >&2
  cat "$PROBE2_F" >&2
  exit 1
fi
if [ "$(cat "$PROBE2_ORDER" 2>/dev/null)" != "after" ]; then
  echo "FAIL: finalize_book_checkout_intent completed while another session still held the (reader, book) advisory lock -- the entitlement core is not taking that lock at all on the legacy path, so retire_book_checkout_attempt and a Stripe finalization no longer exclude each other" >&2
  cat "$PROBE2_R" "$PROBE2_F" >&2
  exit 1
fi

psql -d "$DB" -v ON_ERROR_STOP=1 -q > /dev/null <<SQL
delete from public.purchases where book_id = '$BOOK2_ID';
SQL

echo "  core lock-order probe: clean -- the legacy path waited on the advisory lock and finalized only after it was released"

# ============================================================
# Phase 2: the free-running race, for the fulfilment invariant.
#
# This phase is NOT the deadlock proof (phase 1 is). It exists to
# exercise both real interleavings and assert the thing that matters
# most: whichever one happens, the verified payment still arrives.
# ============================================================

for round in $(seq 1 "$ROUNDS"); do
  CLAIM_ID="$(psql -d "$DB" -t -A -c "select gen_random_uuid()")"
  ORDER_ID="ord_p059_${round}"
  EVENT_KEY="evt_p059_${round}"
  PAYMENT_KEY="pi_p059_${round}"

  # A real RPC-created intent and a real claimed, ready mapping -- the
  # exact shape a reader mid-checkout actually has.
  SETUP_OUT="$(psql -d "$DB" -v ON_ERROR_STOP=1 -q -t -A <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$READER_ID', true);
select intent_id, price_cents_at_checkout
  from public.create_book_checkout_intent('$BOOK_ID'::uuid, null);
reset role;
commit;
SQL
)"
  INTENT_ID="$(echo "$SETUP_OUT" | sed -n '2p' | cut -d'|' -f1)"
  PRICE_CENTS="$(echo "$SETUP_OUT" | sed -n '2p' | cut -d'|' -f2)"

  if [ -z "$INTENT_ID" ]; then
    echo "FAIL: round $round setup produced no intent" >&2
    echo "$SETUP_OUT" >&2
    exit 1
  fi

  EVENT_OUT="$(psql -d "$DB" -v ON_ERROR_STOP=1 -q -t -A <<SQL
begin;
insert into public.pok_book_checkout_orders
  (intent_id, merchant_custom_reference, provider_order_id, checkout_url,
   creation_claim_id, state, provider_window_ends_at)
values ('$INTENT_ID', 'book:$INTENT_ID', '$ORDER_ID',
        'https://pay-staging.pokpay.io/sdk-orders/$ORDER_ID',
        '$CLAIM_ID', 'ready', now() + interval '30 minutes');
set local role service_role;
select id from public.record_payment_event('pok', '$EVENT_KEY', 'pok.order.payment_verified', '$PAYMENT_KEY');
reset role;
select now();
commit;
SQL
)"
  EVENT_ID="$(echo "$EVENT_OUT" | sed -n '1p')"
  PAID_AT="$(echo "$EVENT_OUT" | tail -n1)"

  if [ -z "$EVENT_ID" ] || [ -z "$PAID_AT" ]; then
    echo "FAIL: round $round setup produced no payment event" >&2
    echo "$EVENT_OUT" >&2
    exit 1
  fi

  GO="$WORKDIR/go_$round"
  RESULT_F="$WORKDIR/finalize_$round.txt"
  RESULT_R="$WORKDIR/retire_$round.txt"

  # The skew ALTERNATES sides, and that is the point rather than a
  # detail: delaying only one racer means only one interleaving is ever
  # tested, and the untested one here is the invariant that actually
  # matters -- a payment arriving on an attempt that was retired and
  # superseded a moment earlier. Odd rounds hold the retirement back,
  # even rounds hold the payment back, and the near-zero offsets in
  # between leave real lockstep collisions in the mix too.
  SKEW="0.0$((round % 4))"
  if [ $((round % 2)) -eq 0 ]; then
    SKEW_FINALIZE="$SKEW"; SKEW_RETIRE="0"
  else
    SKEW_FINALIZE="0"; SKEW_RETIRE="$SKEW"
  fi

  (
    while [ ! -f "$GO" ]; do sleep 0.01; done
    [ "$SKEW_FINALIZE" != "0" ] && sleep "$SKEW_FINALIZE"
    psql -d "$DB" -t -A -c \
      "set role service_role; select outcome from public.finalize_ledger_book_payment('$EVENT_ID'::uuid, '$INTENT_ID'::uuid, 'pok', '$PAYMENT_KEY', $PRICE_CENTS::bigint, 'ALL', '$PAID_AT'::timestamptz)" \
      > "$RESULT_F" 2>&1
  ) &
  PID_F=$!

  (
    while [ ! -f "$GO" ]; do sleep 0.01; done
    [ "$SKEW_RETIRE" != "0" ] && sleep "$SKEW_RETIRE"
    psql -d "$DB" -t -A -c \
      "set role service_role; select public.retire_book_checkout_attempt('$INTENT_ID'::uuid, '$CLAIM_ID'::uuid, '$ORDER_ID', 'ready', 'provider_attempt_expired')" \
      > "$RESULT_R" 2>&1
  ) &
  PID_R=$!

  sleep 0.2
  touch "$GO"

  set +e
  wait "$PID_F"; RC_F=$?
  wait "$PID_R"; RC_R=$?
  set -e

  OUT_F="$(tail -n1 "$RESULT_F")"
  OUT_R="$(tail -n1 "$RESULT_R")"

  # A deadlock is the specific failure this harness exists to detect, so
  # it is named rather than folded into a generic error.
  if grep -qi "deadlock" "$RESULT_F" "$RESULT_R"; then
    echo "FAIL: round $round DEADLOCKED -- the lock order of retire_book_checkout_attempt and finalize_ledger_book_payment does not agree" >&2
    cat "$RESULT_F" "$RESULT_R" >&2
    exit 1
  fi
  if [ "$RC_F" != "0" ] || [ "$RC_R" != "0" ]; then
    echo "FAIL: round $round errored (rc_finalize=$RC_F rc_retire=$RC_R)" >&2
    cat "$RESULT_F" "$RESULT_R" >&2
    exit 1
  fi

  if [ "$OUT_F" != "eligible_fulfilled" ]; then
    echo "FAIL: round $round -- the payment must always be fulfilled, whatever the retirement did (got '$OUT_F', retire said '$OUT_R')" >&2
    exit 1
  fi

  case "$OUT_R" in
    retired_and_superseded) RETIRED_FIRST=$((RETIRED_FIRST + 1)) ;;
    already_completed|already_fulfilled) FINALIZE_FIRST=$((FINALIZE_FIRST + 1)) ;;
    *)
      echo "FAIL: round $round -- retire returned '$OUT_R', which is neither a clean retirement nor a money-wins refusal" >&2
      exit 1
      ;;
  esac

  # Whichever way the race fell, the reader owns the book and the
  # payment was recorded exactly once. A superseded intent that ate a
  # verified payment is the failure with no remedy.
  STATE="$(psql -d "$DB" -t -A -c \
    "select coalesce(i.fulfilled_at is not null, false)::text || '|' ||
            (select count(*) from public.purchases where book_id = '$BOOK_ID' and reader_id = '$READER_ID')::text || '|' ||
            (select count(*) from public.payments where provider = 'pok' and provider_payment_id = '$PAYMENT_KEY')::text
       from public.book_checkout_intents i where i.id = '$INTENT_ID'")"
  FULFILLED="$(echo "$STATE" | cut -d'|' -f1)"
  PURCHASES="$(echo "$STATE" | cut -d'|' -f2)"
  PAYMENTS="$(echo "$STATE" | cut -d'|' -f3)"

  if [ "$FULFILLED" != "true" ]; then
    echo "FAIL: round $round -- the intent was not fulfilled after a verified payment (retire said '$OUT_R')" >&2
    exit 1
  fi
  if [ "$PAYMENTS" != "1" ]; then
    echo "FAIL: round $round -- expected exactly 1 payments row, found $PAYMENTS" >&2
    exit 1
  fi
  if [ "$PURCHASES" != "1" ]; then
    echo "FAIL: round $round -- expected exactly 1 purchases row for this reader, found $PURCHASES" >&2
    exit 1
  fi

  # If the retirement won the race, the intent must be BOTH superseded
  # and fulfilled -- that combination existing is the invariant, not an
  # anomaly.
  if [ "$OUT_R" = "retired_and_superseded" ]; then
    BOTH="$(psql -d "$DB" -t -A -c \
      "select (superseded_at is not null and fulfilled_at is not null)::text
         from public.book_checkout_intents where id = '$INTENT_ID'")"
    if [ "$BOTH" != "true" ]; then
      echo "FAIL: round $round -- a retired-then-paid attempt must end up both superseded AND fulfilled" >&2
      exit 1
    fi
  fi

  # Reset for the next round: the reader must not already own the book,
  # or the next finalize would take a different path.
  psql -d "$DB" -v ON_ERROR_STOP=1 -q > /dev/null <<SQL
delete from public.author_ledger_entries where payment_id in (
  select id from public.payments where provider = 'pok' and provider_payment_id = '$PAYMENT_KEY');
delete from public.purchases where book_id = '$BOOK_ID';
delete from public.payments where provider = 'pok' and provider_payment_id = '$PAYMENT_KEY';
SQL
done

psql -d "$DB" -v ON_ERROR_STOP=1 -q > /dev/null <<SQL
$(cleanup_sql)
SQL

# A harness that only ever produced one interleaving proved half of what
# it claims. Both orders must have been observed for this to be evidence.
if [ "$RETIRED_FIRST" -eq 0 ] || [ "$FINALIZE_FIRST" -eq 0 ]; then
  echo "FAIL: only one interleaving occurred across $ROUNDS rounds (retire won $RETIRED_FIRST, finalize won $FINALIZE_FIRST) -- the race did not actually race, so this run is not evidence" >&2
  exit 1
fi

echo "PASS: 059_retire_vs_finalize_contention.sh -- ledger-wrapper and entitlement-core lock orders both clean, $ROUNDS rounds, no deadlock, every verified payment fulfilled, both interleavings observed (retire won $RETIRED_FIRST, finalize won $FINALIZE_FIRST)"
