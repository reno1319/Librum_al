-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds refund tracking to purchases. If you're setting up a
-- fresh project, just run schema.sql instead.
--
-- Note: purchases made before this migration won't have a
-- stripe_payment_intent_id, so a Stripe refund on one of those older
-- purchases won't be automatically detected — only purchases made after
-- this migration is applied support automatic refund handling.

alter table public.purchases
  add column stripe_payment_intent_id text,
  add column refunded_at timestamptz;

create index purchases_payment_intent_idx on public.purchases(stripe_payment_intent_id);
