-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds the columns needed for Phase 5 (author payouts). If
-- you're setting up a fresh project, just run schema.sql — it already
-- includes this, so you don't need this file too.

alter table public.profiles
  add column stripe_account_id text,
  add column stripe_payouts_enabled boolean not null default false;

-- These columns are only ever written by server code using the service
-- role key, never by the user directly.
revoke update (stripe_account_id, stripe_payouts_enabled) on public.profiles from authenticated;
