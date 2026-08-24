-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LAUNCH-1 P1-8: closes the P0 finding from the P1-8 money-flow
-- audit -- Librum's destination-charge model means Stripe debits a lost
-- dispute's full amount (plus its own dispute fee) from Librum's
-- PLATFORM balance, but never automatically claws back the matching
-- share Stripe already transferred to the author's connected account at
-- checkout time. Before this migration, processDisputeEvent (route.ts)
-- only ever recorded a dispute's status -- it never attempted to
-- recover the author's share, so every lost dispute was a guaranteed,
-- unrecovered platform loss. See the P1-8 audit and the three Migration
-- 036 design rounds that preceded this migration for the full reasoning
-- behind every decision below; summarized here only where needed to
-- explain what this migration actually does.
--
-- Approved policy (unchanged from the design phase): a transfer
-- reversal is attempted ONLY when a dispute's live status reaches
-- exactly 'lost' -- never merely because a dispute was opened. A won or
-- still-open dispute produces zero author-money movement. Application-
-- fee refund policy on this reversal is explicitly left UNSET
-- (refund_application_fee is never passed) -- a separate, undecided
-- business-policy question, unchanged by this migration.
--
-- If you're setting up a fresh project, just run schema.sql instead --
-- it already includes all of this.

-- ============================================================
-- payment_disputes: extended with durable transfer-reversal-recovery
-- state. Added directly to this existing table rather than a new child
-- table -- the relationship is strictly 1:1 (at most one logical
-- recovery operation per dispute, ever, under the approved policy), and
-- Postgres's own `ON CONFLICT ... DO UPDATE SET <listed columns>`
-- semantics mean the pre-existing dispute-status upsert in
-- processDisputeEvent can never accidentally clobber these columns --
-- it only ever writes the columns it explicitly lists. See the
-- Migration 036 design report for the full comparison against a
-- dedicated table.
--
-- transfer_reversal_status: a small state machine, NOT a boolean --
-- 'not_attempted' (default, the overwhelming majority of rows, since
-- most disputes are never lost at all) -> 'attempting' (claimed by
-- either the webhook or the reconciliation route, a live Stripe call is
-- about to be or has been made) -> 'succeeded' | 'failed'. A 'failed'
-- row is not terminal -- both the webhook's own immediate retry (on a
-- redelivered charge.dispute.closed for an already-'failed' row) and
-- the reconciliation route (below) can re-claim it for a fresh attempt.
--
-- stripe_transfer_id: resolved once (dispute.charge -> charge.transfer,
-- the destination-charge transfer -- Charges.d.ts's own doc comment:
-- "ID of the transfer to the destination account... only applicable if
-- the charge was created using the destination parameter") and cached
-- here so a retry never needs to re-walk that resolution chain.
--
-- stripe_transfer_reversal_id: set only once a real TransferReversal
-- object is independently observed to exist (either the direct
-- createReversal() response, or a reconciliation match against
-- transfers.listReversals()) -- never written merely because a Stripe
-- call didn't throw.
--
-- transfer_reversal_amount_cents: the amount actually reversed (or, on
-- a 'failed' row, last attempted) -- always derived live from the
-- Transfer object at attempt time (transfer.amount * dispute.amount /
-- charge.amount, clamped to transfer.amount - transfer.amount_reversed
-- -- see the Migration 036 design reports for why this is never
-- computed from Librum's own 80/20 platform-fee split).
--
-- transfer_reversal_attempt_count: increments ONLY when a claim
-- transitions INTO 'attempting' FROM 'not_attempted' or a definitively-
-- terminal 'failed' -- never when re-claiming a STALE 'attempting' row
-- (an ambiguous, unknown-outcome retry reuses the same attempt number
-- and therefore the same deterministic Stripe idempotency key, so a
-- timeout alone can never mint a fresh key -- see
-- buildTransferReversalIdempotencyKey in route.ts).
--
-- transfer_reversal_failure_code / _failure_message: Stripe's own error
-- detail, stored verbatim -- same "never invent a closed taxonomy"
-- posture already established for status/reason on this table.
-- ============================================================

alter table public.payment_disputes
  add column transfer_reversal_status text not null default 'not_attempted'
    check (transfer_reversal_status in ('not_attempted', 'attempting', 'succeeded', 'failed')),
  add column stripe_transfer_id text,
  add column stripe_transfer_reversal_id text,
  add column transfer_reversal_amount_cents integer
    check (transfer_reversal_amount_cents is null or transfer_reversal_amount_cents >= 0),
  add column transfer_reversal_attempt_count integer not null default 0
    check (transfer_reversal_attempt_count >= 0),
  add column transfer_reversal_attempted_at timestamptz,
  add column transfer_reversal_succeeded_at timestamptz,
  add column transfer_reversal_failure_code text,
  add column transfer_reversal_failure_message text;

-- Supports both the webhook's own immediate 'failed' retry and the
-- reconciliation route's periodic scan for 'failed' rows and STALE
-- 'attempting' rows in one composite partial index -- deliberately
-- excludes 'not_attempted' (the vast majority of rows, never need
-- reconciling) and 'succeeded' (permanently done) from the index
-- entirely. See the Migration 036 design report, section 5, for why the
-- originally-proposed single-column version was insufficient for the
-- 'attempting' + attempted_at range condition.
create index payment_disputes_needs_reversal_idx
  on public.payment_disputes (transfer_reversal_status, transfer_reversal_attempted_at)
  where status = 'lost'
    and transfer_reversal_status in ('attempting', 'failed');

-- No RLS policy changes required: payment_disputes already carries zero
-- policies plus an explicit `revoke all ... from public, anon,
-- authenticated` (migration 035) -- the new columns above are
-- automatically covered by that same posture. Only service_role (the
-- webhook and the new reconciliation route, both running under the
-- admin client) and the SECURITY DEFINER function below ever touch
-- them.

-- ============================================================
-- lost_disputed_payment_intents(): batched membership test for the
-- Sales dashboard correction (src/app/dashboard/sales/page.tsx) --
-- returns which of the caller-supplied payment intent ids have a
-- 'lost' dispute. A single batched call, not one call per purchases
-- row: unlike the Library page (bounded to one reader's own purchases)
-- or a bundle's own book list (a handful of books at most), an
-- author's Sales dashboard can have hundreds or thousands of purchases
-- rows -- N sequential payment_intent_has_lost_dispute() calls would
-- not scale the same way. Same SECURITY DEFINER / empty search_path /
-- stable posture as payment_intent_has_lost_dispute() above, and the
-- same security shape: it only answers a caller-supplied-subset
-- membership test (no amounts, no reader identity, no dispute reason),
-- over payment-intent ids the caller must already know to ask about.
-- ============================================================
create or replace function public.lost_disputed_payment_intents(
  target_payment_intent_ids text[]
)
returns table (stripe_payment_intent_id text)
language sql
security definer
set search_path = ''
stable
as $$
  select distinct d.stripe_payment_intent_id
  from public.payment_disputes d
  where d.stripe_payment_intent_id = any(target_payment_intent_ids)
    and d.status = 'lost';
$$;

revoke all on function public.lost_disputed_payment_intents(text[]) from public;
revoke all on function public.lost_disputed_payment_intents(text[]) from anon;
revoke all on function public.lost_disputed_payment_intents(text[]) from authenticated;
grant execute on function public.lost_disputed_payment_intents(text[]) to authenticated;
