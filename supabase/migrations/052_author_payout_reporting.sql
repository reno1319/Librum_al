-- LIBRUM 2.0 LEDGER-1E-C: author-facing payout reporting + safe payout
-- history read model. Built on migrations 048/049/050/051, all already
-- LIVE in production and NOT modified by this file in any way (048-051's
-- own DDL/function text is byte-unchanged; this migration only ADDS two
-- new SECURITY DEFINER functions and DROPS one now-superseded RLS
-- policy on author_payouts).
--
-- CRITICAL BUSINESS FACT (unchanged since LEDGER-1E-B): no payout
-- provider exists, no scheduler exists, and no real payout can occur.
-- All financial tables (payments, payment_events, payment_refunds,
-- author_ledger_entries, author_payouts, author_payout_settings,
-- payout_runs) have zero production rows at the time this migration is
-- written. This migration is REPORTING/SAFE-READ-MODEL ONLY -- it adds
-- no table, no column, no payout mutation RPC, and calls no payout
-- mutation RPC anywhere in its own body.
--
-- ============================================================
-- SCOPE:
--   Part 1: author_payouts -- drop the author-own raw-row RLS policy
--           (migration 048). The table now carries internal operational
--           fields (provider, provider_reference, failure_code,
--           payout_run_id) added by migration 051 that were never meant
--           for direct author consumption -- exactly the same
--           tightening LEDGER-1D already applied to author_ledger_
--           entries in migration 050, Part 1. finance.view staff raw
--           read is untouched.
--   Part 2: get_author_payout_overview() -- a safe, currency-grouped,
--           reservation-aware payoutability snapshot, built on top of
--           author_ledger_balance() (migration 051) and author_payouts'
--           own active-reservation rows. Does NOT redefine or touch
--           get_author_financial_summary() or author_ledger_balance()
--           in any way -- "ledger available" remains PURE LEDGER TRUTH,
--           exactly as approved in LEDGER-1D. This is a NEW, separate,
--           reservation-aware number layered on top of it.
--   Part 3: list_author_payout_history() -- a bounded, keyset-paginated,
--           safe-fields-only view of an author's own payout rows.
--
-- EXPLICITLY NOT IN THIS MIGRATION (LEDGER-1E-C's own scope):
--   no payout provider adapter; no scheduler; no manual-payout RPC; no
--   threshold-setting RPC/UI (author_payout_settings remains read-only
--   to its owning author, exactly as migration 048 left it); no change
--   to any of the six payout mutation RPCs (migration 051) -- none of
--   them are invoked here, nor by this migration's own application
--   against production; no payout_reversal entry_type (remains a hard
--   pre-real-money blocker, unchanged, deferred exactly as migration
--   051's own Part 8 comment documents); no change to payout_runs
--   access -- it remains fully locked down (RLS enabled, zero policies),
--   no author or staff policy is added here.
-- ============================================================

-- ============================================================
-- Part 1: tighten author-facing raw author_payouts access.
--
-- Migration 048 gave authors a direct RLS policy onto author_payouts'
-- base table -- reasonable when written (no payout state machine
-- existed yet). Migration 051 has since added provider,
-- provider_reference, failure_code, and payout_run_id -- internal
-- operational/reconciliation detail an author has no legitimate need to
-- read directly (a provider failure code may contain operational detail
-- never intended for the end user; provider/provider_reference/
-- payout_run_id are internal correlation identifiers with no author-
-- facing meaning). Production author_payouts currently has ZERO rows
-- and no current application code reads this table at all, so this is
-- the clean moment to close the direct path before any real usage
-- pattern would ever have to be migrated off of it -- exactly the same
-- reasoning, and the same "clean moment," LEDGER-1D already used to
-- close the equivalent author-own policy on author_ledger_entries
-- (migration 050, Part 1).
--
-- DROP POLICY, not a grant change: the table-level `grant select ... to
-- authenticated` (migration 048) is left untouched, because
-- staff_has_permission('finance.view')'s own SELECT policy on this same
-- table -- also from migration 048, also untouched -- still needs that
-- grant to have anything to narrow. Dropping ONLY the author-own policy
-- means: staff with finance.view keeps reading this table exactly as
-- before (completely unaffected -- finance.view is never broken by this
-- migration); an ordinary authenticated caller who is NOT staff now
-- matches zero policies on this table and sees zero rows (the same
-- "grant present, no matching policy -> empty result set" behavior
-- established by migration 050's own equivalent change). Their new,
-- safe path is exclusively list_author_payout_history() below, which
-- returns only the fields this migration's own Part 3 approves.
-- ============================================================

drop policy "Authors can view their own payouts" on public.author_payouts;

-- ============================================================
-- Part 2: get_author_payout_overview() -- THE reservation-aware
-- payoutability snapshot.
--
-- FORMULA (per currency):
--   ledger_available_minor      = author_ledger_balance().available_minor
--   reserved_minor               = SUM(author_payouts.amount_minor)
--                                   WHERE status IN ('pending','processing','reconciling')
--   available_for_payout_minor   = ledger_available_minor - reserved_minor
--
-- RECONCILIATION INVARIANT (always holds, by construction, never
-- computed twice): ledger_available_minor = reserved_minor +
-- available_for_payout_minor.
--
-- DELIBERATELY NOT CLAMPED TO ZERO: available_for_payout_minor can
-- legitimately go NEGATIVE -- a payout reservation is snapshotted at
-- reserve time, but a refund can still reduce the underlying ledger
-- balance while that reservation is processing/reconciling (before
-- start_author_payout()'s own fresh revalidation ever gets a chance to
-- run again). That is a real, visible financial fact (an over-reserved
-- position), not a bug to hide by flooring the number at zero -- hiding
-- it would misrepresent the author's actual financial exposure.
--
-- TERMINAL PAYOUTS DO NOT COUNT AS RESERVED: 'paid' no longer matches
-- the WHERE clause above -- its ledger debit has already been posted by
-- finalize_author_payout() and is therefore already reflected inside
-- ledger_available_minor itself (via author_ledger_balance()), so
-- counting it in reserved_minor AS WELL would double-subtract it.
-- 'failed'/'cancelled' also fall outside the WHERE clause -- the
-- reservation was released (no ledger debit was ever created for
-- either), so the full amount is naturally available again the instant
-- either transition commits, with zero special-case code needed here.
--
-- CURRENCY UNIVERSE: a currency is reportable if it has ANY of: ledger
-- activity, an author_payout_settings row, or an author_payouts row of
-- ANY status (not just active) -- never omitted merely because its
-- current ledger balance nets to zero (e.g. a fully-paid-out currency
-- with no further activity still has payout history worth showing).
-- Currencies are never combined; every column above is computed
-- independently per currency.
--
-- THRESHOLD (Section 6/7): author_payout_settings is keyed by
-- (author_id, currency) since migration 051. No settings row for a
-- given currency means threshold_configured = false, threshold_minor =
-- NULL -- never a fabricated default. threshold_reached is exposed as a
-- plain boolean fact ("the configured threshold has been reached"),
-- deliberately NOT named/implied as "you will be paid" or "eligible for
-- payout execution" -- no scheduler or provider exists yet to make that
-- promise true, and this function makes no claim about when or whether
-- a payout will actually be sent. When no threshold is configured,
-- threshold_reached is always false (never NULL): `threshold_minor IS
-- NOT NULL AND ... >= threshold_minor` short-circuits to FALSE the
-- moment the first operand is false, regardless of the unconfigured
-- comparison's own NULL result.
--
-- SECURITY: SECURITY DEFINER, auth.uid()-scoped identically to
-- get_author_financial_summary()/list_author_financial_activity()
-- (migration 050) -- no p_author_id parameter exists, so there is
-- structurally no way to request another author's overview. Internally
-- calls author_ledger_balance(auth.uid()) -- safe and unchanged from
-- migration 051's own established pattern (reserve_author_payout() and
-- get_author_financial_summary() already call it the same way): the
-- function owner's own privileges govern this internal call, so
-- author_ledger_balance()'s service_role-only EXECUTE grant is NOT
-- broadened by this migration in any way. EXECUTE on THIS function
-- itself is granted to authenticated only (never anon/public), exactly
-- like every other author-facing reporting RPC in this schema.
-- ============================================================

create or replace function public.get_author_payout_overview()
returns table (
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  available_for_payout_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  threshold_reached boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  with ledger as (
    select balance.currency, balance.available_minor
    from public.author_ledger_balance(auth.uid()) balance
  ),
  reservations as (
    select ap.currency, sum(ap.amount_minor)::bigint as reserved_minor
    from public.author_payouts ap
    where ap.author_id = auth.uid()
      and ap.status in ('pending', 'processing', 'reconciling')
    group by ap.currency
  ),
  settings as (
    select aps.currency, aps.threshold_minor
    from public.author_payout_settings aps
    where aps.author_id = auth.uid()
  ),
  payout_currencies as (
    select distinct ap.currency
    from public.author_payouts ap
    where ap.author_id = auth.uid()
  ),
  currencies as (
    select currency from ledger
    union
    select currency from settings
    union
    select currency from payout_currencies
  )
  select
    c.currency,
    coalesce(l.available_minor, 0)::bigint as ledger_available_minor,
    coalesce(r.reserved_minor, 0)::bigint as reserved_minor,
    (coalesce(l.available_minor, 0) - coalesce(r.reserved_minor, 0))::bigint as available_for_payout_minor,
    (s.threshold_minor is not null) as threshold_configured,
    s.threshold_minor as threshold_minor,
    (
      s.threshold_minor is not null
      and (coalesce(l.available_minor, 0) - coalesce(r.reserved_minor, 0)) >= s.threshold_minor
    ) as threshold_reached
  from currencies c
  left join ledger l on l.currency = c.currency
  left join reservations r on r.currency = c.currency
  left join settings s on s.currency = c.currency
  order by c.currency;
$$;

revoke all on function public.get_author_payout_overview() from public, anon, authenticated;
grant execute on function public.get_author_payout_overview() to authenticated;

-- ============================================================
-- Part 3: list_author_payout_history() -- bounded, keyset-paginated,
-- safe-fields-only view of an author's own payout rows. Mirrors the
-- exact pagination convention already established by
-- list_author_financial_activity() (migration 050): p_limit clamped to
-- [1, 100] (default 25), keyset cursor as a (created_at, id) tuple
-- compared with `<` for strict descending pagination, "cursor fields
-- must both be null or both be set" validation.
--
-- SAFE FIELDS ONLY: id, amount_minor, currency, status, created_at,
-- processing_at, paid_at, failed_at. Never selects provider,
-- provider_reference, failure_code, payout_run_id, or anything from
-- payout_runs -- none of these carry author-facing meaning, and
-- failure_code specifically may contain operational/provider detail
-- never intended for the end user (a failed payout is represented to
-- the author purely as status='failed'; the UI supplies its own generic
-- copy for that state -- detailed failure diagnostics stay finance/
-- internal territory, reached only via finance.view's existing raw
-- table access). period_start/period_end are also omitted for now: no
-- scheduler exists yet to populate them with any author-facing meaning
-- (LEDGER-1E-D) -- they can be added here in that later phase if/when
-- they actually mean something to an author, not speculatively now.
--
-- STATUS IS RETURNED VERBATIM: 'pending', 'processing', 'paid',
-- 'failed', 'cancelled', 'reconciling' all pass through exactly as
-- stored -- this function makes no attempt to collapse or relabel any
-- of them (e.g. never folds 'reconciling' into 'failed', never folds
-- 'pending'/'processing' into 'paid'). Any user-facing copy mapping
-- (e.g. 'reconciling' -> "Under review") is a presentation-layer
-- decision, not a reporting-layer one, so it belongs in application
-- code, never in this function's own output.
--
-- OWNERSHIP: identical posture to list_author_financial_activity() --
-- auth.uid() alone, no p_author_id parameter, SECURITY DEFINER for the
-- same reason Part 1 above just removed the author-own policy this
-- function would otherwise need as an invoker.
-- ============================================================

create or replace function public.list_author_payout_history(
  p_limit integer default 25,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns table (
  id uuid,
  amount_minor bigint,
  currency text,
  status text,
  created_at timestamptz,
  processing_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      ap.id,
      ap.amount_minor,
      ap.currency,
      ap.status,
      ap.created_at,
      ap.processing_at,
      ap.paid_at,
      ap.failed_at
    from public.author_payouts ap
    where ap.author_id = auth.uid()
      and (
        p_cursor_created_at is null
        or (ap.created_at, ap.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by ap.created_at desc, ap.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_author_payout_history(integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_author_payout_history(integer, timestamptz, uuid) to authenticated;

-- ============================================================
-- Part 4: production rollout compatibility. Every object this migration
-- adds is new (get_author_payout_overview, list_author_payout_history)
-- or a single RLS policy DROP against a table with zero production rows
-- and zero current application readers. No existing column, constraint,
-- grant, or function is altered; migrations 048, 049, 050, and 051
-- remain byte-unchanged. finance.view staff access to author_payouts is
-- completely unaffected (its own policy and the underlying table grant
-- are both untouched). author_ledger_balance() and
-- get_author_financial_summary()'s own grants are untouched -- neither
-- is broadened, and "ledger available" keeps its exact LEDGER-1D
-- meaning. No payout mutation RPC (migration 051) is modified, and none
-- is called anywhere in this file. payout_runs remains fully locked
-- down -- no policy is added for it here. The current Stripe Connect
-- flow (/dashboard/payouts) continues to run completely unaffected; the
-- new safe payout reporting surface is additive, read-only, and reached
-- exclusively through the two SECURITY DEFINER functions above.
-- ============================================================
