-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds transaction-level payment tracking to
-- bundle_checkout_snapshots -- see the Phase 9B-2 zero-eligible-item
-- audit for why this is needed.
--
-- Until now, bundle_checkout_snapshots recorded a paid bundle's total
-- (total_amount_cents) but had no way to record its Stripe payment
-- intent or its own refund state -- both facts lived exclusively on the
-- purchases rows a fulfillment wrote. That works for every bundle
-- checkout that grants at least one new entitlement, but fails for the
-- one case where a snapshot's every item turns out, at payment time, to
-- already be actively owned through some unrelated transaction: zero
-- purchases rows are written for that payment, so it had no durable
-- record of its own Stripe payment intent, and a later refund of that
-- exact charge had no row to attach to -- correct entitlement handling
-- (nothing was touched that shouldn't be), but a real payment with no
-- accounting or refund trail in Librum.
--
-- stripe_payment_intent_id is UNIQUE, unlike purchases.stripe_payment_
-- intent_id (which is deliberately NOT unique, since one bundle checkout
-- fans out into several purchase rows sharing one payment intent).
-- bundle_checkout_snapshots has the opposite cardinality: one snapshot
-- already maps to exactly one Stripe Checkout Session
-- (stripe_checkout_session_id is already unique on this table), and a
-- "payment" mode Checkout Session has exactly one PaymentIntent -- so
-- snapshot-to-payment-intent is genuinely 1:1. UNIQUE catches a real bug
-- class (two snapshot rows accidentally attributed to the same Stripe
-- payment) rather than being decorative, and Postgres unique constraints
-- allow unlimited NULLs, so pre-fulfillment rows (not yet paid) and free
-- ($0) bundle fulfillments (which never get a Stripe PaymentIntent at
-- all) are unaffected. The UNIQUE constraint's own backing b-tree index
-- is sufficient for the charge.refunded lookup this column exists for --
-- no separate CREATE INDEX is added.
--
-- refunded_at mirrors purchases.refunded_at exactly: null while active,
-- set once by charge.refunded. No index is added for it -- every query
-- that reads it also filters by author_id or matches a single row by
-- stripe_payment_intent_id, both already indexed/unique.
--
-- No backfill: every existing row predates this column and has no
-- payment intent to record retroactively (nothing here reconstructs
-- Stripe history for old rows) -- both new columns are simply NULL for
-- them, which is the correct "unknown/not applicable" state.

alter table public.bundle_checkout_snapshots
  add column stripe_payment_intent_id text unique,
  add column refunded_at timestamptz;

-- Row level security is already enabled on this table (migration 025) --
-- nothing to add there. Until now this table deliberately had ZERO
-- policies for anon/authenticated (see its comment in schema.sql): no
-- product surface ever showed a reader "my pending checkout," and
-- nothing read it except the Stripe webhook's service-role client, which
-- bypasses RLS entirely. That posture no longer covers every legitimate
-- reader now that the sales dashboard needs to fold a fulfilled bundle
-- snapshot's total_amount_cents into an author's own revenue reporting
-- (see the Phase 9B-2 zero-eligible-item accounting fix) -- using the
-- request-scoped, RLS-respecting client, not the admin client, so this
-- policy is what actually makes that read legal rather than silently
-- empty.
--
-- Scoped as narrowly as the feature that needs it:
-- - auth.uid() = author_id: only the bundle's own author, exactly the
--   same scoping already used by "Authors can view purchases of their
--   own books" on the purchases table -- no reader-facing exposure is
--   added by this policy at all.
-- - fulfilled_at is not null: an in-flight, unpaid, or expired checkout
--   attempt stays completely invisible -- "nothing surfaces my pending
--   checkout" remains true for the author side of this table exactly as
--   it already was for the reader side. Only a completed transaction
--   this author was actually paid for becomes visible.
create policy "Authors can view their own fulfilled bundle snapshot transactions"
  on public.bundle_checkout_snapshots
  for select
  using (
    auth.uid() = author_id
    and fulfilled_at is not null
  );
