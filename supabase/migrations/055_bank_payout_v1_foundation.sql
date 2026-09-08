-- ============================================================
-- LIBRUM 2.0 BANK-PAYOUT-1C: manual-bank V1 financial foundation.
--
-- Database-foundation only -- no author form, no admin UI, no CSV
-- download UI, no bank adapter, no bank contact, no minimum-threshold
-- value, no scheduler enablement, no real money movement anywhere in
-- this file. Migrations 048-054 are already LIVE production history
-- and are NOT modified in any way except the two narrowly-scoped
-- CREATE OR REPLACE edits explicitly justified in Parts 6 and 7 below
-- (author_payout_eligibility's body, start_author_payout's body) --
-- their external signatures/RETURNS TABLE shapes are preserved
-- unchanged. reserve_author_payout(), mark_author_payout_reconciling(),
-- cancel_author_payout(), start_scheduled_payout_run(),
-- complete_scheduled_payout_run(), dry_run_scheduled_payouts() are all
-- completely untouched -- ZERO duplicate lifecycle RPCs are created
-- here.
--
-- This migration is the implementation of the design approved across
-- BANK-PAYOUT-1A / 1A.1 / 1B / 1B.1. Every design decision below cites
-- back to the specific corrected reasoning from that review chain
-- rather than re-deriving it.
--
-- New objects: payout_minimum_policy, author_payout_destinations,
-- payout_destination_snapshots, payout_reversal; a new
-- author_ledger_entries entry_type ('payout_reversal'); two new staff
-- permissions (finance.payout_export, finance.payout_operate); four
-- new RPCs (set_author_payout_threshold, set_author_payout_destination,
-- record_payout_reversal, list_payout_batch_export); and CREATE OR
-- REPLACE on six existing functions (author_payout_eligibility,
-- get_author_payout_overview, start_author_payout,
-- finalize_author_payout, author_ledger_balance,
-- list_author_payout_history, staff_has_permission) -- every one named
-- explicitly, no silent omission.
-- ============================================================

-- ============================================================
-- Part 1: payout_minimum_policy -- provider/bank-neutral minimum
-- threshold policy, per currency. Platform financial policy, not an
-- author preference (BANK-PAYOUT-1B Section 15/18; BANK-PAYOUT-1B.1
-- Correction 2 confirms the eligibility-time design this table feeds).
--
-- NO ROW IS INSERTED BY THIS MIGRATION. No minimum value -- 25, 50, or
-- any other number -- is invented here. The first real policy row is
-- populated later, through a separate, explicit, reviewed
-- administrative operation, once real bank/provider economics are
-- known. Until that happens, author_payout_eligibility() (Part 6) and
-- set_author_payout_threshold() (Part 12) both fail closed for every
-- currency -- see those parts for the exact mechanism.
-- ============================================================

create table public.payout_minimum_policy (
  currency text primary key check (currency ~ '^[A-Z]{3}$'),
  minimum_threshold_minor bigint not null check (minimum_threshold_minor > 0),
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.payout_minimum_policy enable row level security;

-- This is platform financial policy, not author data -- no author-own
-- read policy exists or is needed. anon/authenticated get no direct
-- access of any kind (not even SELECT): the currently-active minimum
-- is exposed to authors only indirectly, through
-- get_author_payout_overview()'s own safe, derived fields (Part 8),
-- never as a raw table read. service_role's own default DML is
-- revoked too -- the only legitimate mutation path in this phase is a
-- future, separate, explicitly-reviewed administrative operation
-- (Section 18's own instruction: "no policy-editing UI/API in this
-- phase"), and even that is deliberately not built here. The
-- SECURITY DEFINER RPCs that need to READ this table
-- (author_payout_eligibility, get_author_payout_overview,
-- set_author_payout_threshold) run as their OWNER regardless of the
-- calling role's own table grants, so revoking SELECT from every
-- ordinary role does not break them.
revoke all on public.payout_minimum_policy from anon, authenticated, service_role;

-- ============================================================
-- Part 2: author_payout_destinations -- live, author-editable payout
-- destination preference. (author_id, currency) identity, mirroring
-- author_payout_settings' own composite-PK precedent exactly
-- (BANK-PAYOUT-1B.1 Section 5's locked decision).
--
-- Deliberately excluded (BANK-PAYOUT-1A.1 Section 5/BANK-PAYOUT-1C
-- Section 9): bank-login data, provider credentials, card data, KYC
-- documents, a free-text bank-name field (derivable from the IBAN's
-- own bank-code segment if ever needed for display), and BIC (not
-- required for Albanian domestic ALL transfers or for SEPA EUR
-- transfers under the EU's IBAN-only rule; add only if a real future
-- adapter proves otherwise).
-- ============================================================

create table public.author_payout_destinations (
  author_id uuid not null references public.profiles(id) on delete cascade,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  beneficiary_name text not null check (btrim(beneficiary_name) <> ''),
  iban text not null check (btrim(iban) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (author_id, currency)
);

alter table public.author_payout_destinations enable row level security;

-- Author-own SELECT only -- mirrors author_payout_settings' own exact
-- posture. No finance.view policy here at all (BANK-PAYOUT-1A.1
-- Section D/1C Section 10): full bank-destination data must never
-- become visible through the broad, already-existing finance.view
-- permission. Full IBAN visibility for staff is exclusively through
-- the narrowly-gated list_payout_batch_export() RPC (Part 13), which
-- checks finance.payout_export internally.
revoke all on public.author_payout_destinations from anon, authenticated, service_role;
grant select on public.author_payout_destinations to authenticated;

create policy "Authors can view their own payout destination"
  on public.author_payout_destinations for select
  using (auth.uid() = author_id);

-- Writes occur exclusively through set_author_payout_destination()
-- (Part 11), a SECURITY DEFINER RPC scoped by auth.uid() with no
-- author_id parameter. No INSERT/UPDATE/DELETE policy exists for any
-- role, and service_role's own default DML is revoked above too
-- (1A.1's own correction to the author_payout_settings gap): even the
-- internal scheduler process cannot bypass this table's one write
-- path via raw table access.

-- ============================================================
-- Part 3: payout_destination_snapshots -- immutable, per-payout,
-- frozen-at-handoff facts. A dedicated table, not columns on
-- author_payouts (BANK-PAYOUT-1A.1 Section D/E's own privacy
-- correction): author_payouts already carries a "Staff with
-- finance.view can view all payouts" SELECT * policy, so placing raw
-- IBAN/beneficiary data there would silently hand it to every
-- finance.view staff member. Keeping it in its own table, with no
-- finance.view policy at all, closes that off completely.
--
-- payment_reference is a genuinely persisted, uniquely-constrained
-- column (BANK-PAYOUT-1B.1 Correction 2/2b) -- generated exactly once
-- inside start_author_payout() (Part 7) and never recomputed. A
-- truncated hash is not "unique by construction"; the UNIQUE
-- constraint below is what actually guarantees it, and the generation
-- ALGORITHM itself lives entirely in start_author_payout()'s own body,
-- free to change later (e.g. once a real bank's field-length limit is
-- known) with zero migration/table-shape change required.
-- ============================================================

create table public.payout_destination_snapshots (
  payout_id uuid primary key references public.author_payouts(id) on delete restrict,
  beneficiary_name text not null,
  iban text not null,
  currency text not null,
  payment_reference text not null,
  created_at timestamptz not null default now(),

  constraint payout_destination_snapshots_payment_reference_key unique (payment_reference)
);

alter table public.payout_destination_snapshots enable row level security;

-- No finance.view policy, no author-own policy -- access is
-- exclusively through the narrowly-gated list_payout_batch_export()
-- RPC (Part 13) and the trusted service_role payout-lifecycle
-- functions (start_author_payout, finalize_author_payout) that read
-- it internally. service_role's own default DML is revoked below too
-- -- the only legitimate INSERT path is the one inside
-- start_author_payout() itself.
revoke all on public.payout_destination_snapshots from anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Part 3a: explicit immutability enforcement (BANK-PAYOUT-1C Section
-- 13's own mandatory correction over BANK-PAYOUT-1A.1's original
-- "absent UPDATE/DELETE grant is enough" design) -- a trigger that
-- unconditionally rejects UPDATE and DELETE on this table, so
-- immutability is a real database invariant rather than merely an
-- absence of a grant a future migration could accidentally add back.
-- ------------------------------------------------------------

create or replace function public.reject_payout_destination_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'payout_destination_snapshots: rows are immutable once inserted (payout %, attempted %)',
    coalesce(old.payout_id, new.payout_id), tg_op;
end;
$$;

create trigger payout_destination_snapshots_reject_update
  before update on public.payout_destination_snapshots
  for each row
  execute function public.reject_payout_destination_snapshot_mutation();

create trigger payout_destination_snapshots_reject_delete
  before delete on public.payout_destination_snapshots
  for each row
  execute function public.reject_payout_destination_snapshot_mutation();

-- ============================================================
-- Part 4: payout_reversal -- the immutable primitive that finally
-- unblocks real external payout execution (BANK-PAYOUT-1A Section D /
-- BANK-PAYOUT-1B.1 Correction 3 for the exact V1 economic rule).
--
-- amount_minor/currency/provider are NOT caller-supplied anywhere
-- (record_payout_reversal, Part 5, derives all three internally from
-- the original author_payouts row) -- "reversal amount MUST equal the
-- original payout amount" is therefore true by construction, not by a
-- validation rule a caller could get wrong. The CHECK/trigger below is
-- still added as defense-in-depth, matching this codebase's own
-- established belt-and-suspenders pattern (e.g.
-- author_payouts_paid_requires_provider_and_reference).
--
-- One reversal per payout in V1 (BANK-PAYOUT-1B.1 Section 4's locked
-- rule) -- no partial reversals, no multiple reversals. A bank/return
-- fee is a Librum operating expense, never charged to the author's own
-- ledger (BANK-PAYOUT-1B.1 Correction 3's own reasoning) -- this
-- structurally cannot happen here since the amount is never a caller
-- input to begin with.
-- ============================================================

create table public.payout_reversal (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.author_payouts(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider text not null check (btrim(provider) <> ''),
  provider_reference text not null check (btrim(provider_reference) <> ''),
  reason text,
  reversed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint payout_reversal_one_per_payout unique (payout_id),
  constraint payout_reversal_provider_reference_key unique (provider, provider_reference)
);

alter table public.payout_reversal enable row level security;

-- Same posture as author_payouts itself: authenticated gets SELECT
-- only (no policy is added here granting anyone read access beyond
-- what a later, separate task might add for finance reporting -- this
-- migration does not expose reversal rows to any role, matching the
-- "no author/client write access" requirement and keeping this
-- strictly a service_role-mutated, currently server-only-readable
-- table). service_role's own default DML is revoked -- the only
-- legitimate mutation path is record_payout_reversal() (Part 5).
revoke all on public.payout_reversal from anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Part 4a: cross-table defense-in-depth -- the referenced payout must
-- be 'paid', and the reversal's own amount/currency must match it
-- exactly. Enforced via trigger (a plain CHECK constraint cannot
-- reference another table in Postgres).
-- ------------------------------------------------------------

create or replace function public.enforce_payout_reversal_matches_original()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_payout record;
begin
  select ap.status, ap.amount_minor, ap.currency into v_payout
  from public.author_payouts ap
  where ap.id = new.payout_id;

  if not found then
    raise exception 'payout_reversal: payout % not found', new.payout_id;
  end if;

  if v_payout.status <> 'paid' then
    raise exception
      'payout_reversal: payout % is not paid (current status %) -- only a paid payout may be reversed',
      new.payout_id, v_payout.status;
  end if;

  if new.amount_minor <> v_payout.amount_minor then
    raise exception
      'payout_reversal: amount % does not match original payout amount % (payout %) -- V1 permits only a full reversal',
      new.amount_minor, v_payout.amount_minor, new.payout_id;
  end if;

  if new.currency <> v_payout.currency then
    raise exception
      'payout_reversal: currency % does not match original payout currency % (payout %)',
      new.currency, v_payout.currency, new.payout_id;
  end if;

  return new;
end;
$$;

create trigger payout_reversal_enforce_matches_original
  before insert on public.payout_reversal
  for each row
  execute function public.enforce_payout_reversal_matches_original();

-- ============================================================
-- Part 5: author_ledger_entries -- admit the new 'payout_reversal'
-- entry type (BANK-PAYOUT-1B Section 5/1B.1 Section 12; migration 048
-- itself is NOT touched, all changes are additive here).
--
-- Sign: positive (a compensating credit, mirroring exactly how
-- 'refund' was added alongside 'sale' -- never overloading
-- 'adjustment'). payout_id is required for this entry type (a
-- reversal without a referenced payout is meaningless), and exactly
-- one 'payout_reversal' ledger credit is permitted per payout_id,
-- mirroring author_ledger_entries_one_entry_per_payout_idx's own exact
-- existing shape for 'payout' entries.
-- ============================================================

alter table public.author_ledger_entries
  drop constraint author_ledger_entries_entry_type_check;

alter table public.author_ledger_entries
  add constraint author_ledger_entries_entry_type_check
  check (entry_type = any (array['sale', 'refund', 'adjustment', 'payout', 'payout_reversal']));

alter table public.author_ledger_entries
  add constraint author_ledger_entries_payout_reversal_amount_positive
  check (entry_type <> 'payout_reversal' or amount_minor > 0);

alter table public.author_ledger_entries
  add constraint author_ledger_entries_payout_reversal_requires_payout_id
  check (entry_type <> 'payout_reversal' or payout_id is not null);

create unique index author_ledger_entries_one_reversal_per_payout_idx
  on public.author_ledger_entries (payout_id)
  where entry_type = 'payout_reversal';

-- ============================================================
-- Part 6: record_payout_reversal() -- the one entry point that ever
-- creates a payout_reversal row. Correctness-by-construction contract
-- (BANK-PAYOUT-1C Section 4's own mandatory correction): the caller
-- supplies ONLY p_payout_id, p_reversal_reference, p_reason -- never
-- amount, never currency, never provider. All three are derived from
-- the original author_payouts row, because a reversal is a reversal OF
-- that payout, and a different administrative notification channel is
-- not a different payout provider (Section 4's own rationale, accepted
-- as-is -- no existing constraint made deriving provider unsafe, so no
-- substitute contract was needed).
--
-- Idempotency mirrors finalize_author_payout()'s own already-
-- established pattern exactly (BANK-PAYOUT-1B.1 Correction 2d): an
-- identical retry (same payout_id, same reversal reference) is a safe
-- no-op returning the existing row; a different reference on an
-- already-reversed payout is rejected, requiring a human.
-- ============================================================

create or replace function public.record_payout_reversal(
  p_payout_id uuid,
  p_reversal_reference text,
  p_reason text default null
)
returns table (
  reversal_id uuid,
  payout_id uuid,
  amount_minor bigint,
  currency text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout record;
  v_existing record;
  v_reversal_id uuid;
begin
  if p_reversal_reference is null or btrim(p_reversal_reference) = '' then
    raise exception 'record_payout_reversal: p_reversal_reference is required and must not be blank';
  end if;

  select * into v_payout
  from public.author_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'record_payout_reversal: payout % not found', p_payout_id;
  end if;

  -- Table alias required: this function's own OUT parameter is also
  -- named "payout_id" (RETURNS TABLE above), which otherwise makes a
  -- bare "payout_id" reference in the WHERE clause ambiguous -- the
  -- same class of bug already documented and fixed elsewhere in this
  -- schema (start_author_payout's own comment).
  select * into v_existing
  from public.payout_reversal pr
  where pr.payout_id = p_payout_id;

  if found then
    if v_existing.provider = 'manual_bank' and v_existing.provider_reference = p_reversal_reference then
      reversal_id := v_existing.id;
      payout_id := p_payout_id;
      amount_minor := v_existing.amount_minor;
      currency := v_existing.currency;
      return next;
      return;
    else
      raise exception
        'record_payout_reversal: payout % is already reversed with a DIFFERENT reference (existing %, received %) -- refusing to overwrite; this requires operator investigation, not an automatic retry',
        p_payout_id, v_existing.provider_reference, p_reversal_reference;
    end if;
  end if;

  if v_payout.status <> 'paid' then
    raise exception
      'record_payout_reversal: payout % is not paid (current status %) -- only a paid payout may be reversed',
      p_payout_id, v_payout.status;
  end if;

  -- provider is derived, not caller-supplied (Section 4): the payout's
  -- own provider is the natural, always-safe choice for V1, where
  -- 'manual_bank' is the only provider that exists.
  insert into public.payout_reversal
    (payout_id, amount_minor, currency, provider, provider_reference, reason)
  values
    (p_payout_id, v_payout.amount_minor, v_payout.currency, v_payout.provider, p_reversal_reference, p_reason)
  returning id into v_reversal_id;

  insert into public.author_ledger_entries
    (author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
  values
    (v_payout.author_id, p_payout_id, 'payout_reversal', v_payout.amount_minor, v_payout.currency, now(), now());

  reversal_id := v_reversal_id;
  payout_id := p_payout_id;
  amount_minor := v_payout.amount_minor;
  currency := v_payout.currency;
  return next;
end;
$$;

revoke all on function public.record_payout_reversal(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_payout_reversal(uuid, text, text) to service_role;

-- ============================================================
-- Part 7: author_payout_eligibility() -- CREATE OR REPLACE, RETURNS
-- TABLE signature preserved EXACTLY (BANK-PAYOUT-1C Section 21's own
-- mandatory correction over BANK-PAYOUT-1B.1's original plan to widen
-- it). The scheduler/reservation callers need the decision, not
-- UI-explanation fields -- those are added to
-- get_author_payout_overview() instead (Part 8). Preserving the exact
-- signature avoids a DROP/recreate and any dependency risk on the two
-- existing callers (dry_run_scheduled_payouts, reserve_author_payout),
-- neither of which is touched by this migration.
--
-- Body changes (BANK-PAYOUT-1B.1 Correction 1's locked priority
-- order): no_settings -> no_minimum_policy -> no_available_balance ->
-- active_reservation -> below_threshold (against the EFFECTIVE
-- threshold, greatest(stored, current minimum)) -> no_destination ->
-- eligible. The greatest() computation only ever runs after
-- v_threshold is already confirmed non-null (Correction 1's own
-- NULL-safety note) -- an author who never configured a threshold is
-- never treated as having implicitly opted in at the policy minimum.
-- ============================================================

create or replace function public.author_payout_eligibility(
  p_author_id uuid,
  p_currency text
)
returns table (
  author_id uuid,
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  payoutable_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  active_reservation boolean,
  eligible boolean,
  ineligible_reason text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_available bigint;
  v_threshold bigint;
  v_minimum_policy bigint;
  v_effective_threshold bigint;
  v_reserved bigint;
  v_payoutable bigint;
  v_active_reservation boolean;
  v_has_destination boolean;
begin
  select balance.available_minor into v_available
  from public.author_ledger_balance(p_author_id) balance
  where balance.currency = p_currency;

  select aps.threshold_minor into v_threshold
  from public.author_payout_settings aps
  where aps.author_id = p_author_id and aps.currency = p_currency;

  select pmp.minimum_threshold_minor into v_minimum_policy
  from public.payout_minimum_policy pmp
  where pmp.currency = p_currency and pmp.is_active = true;

  select coalesce(sum(ap.amount_minor), 0) into v_reserved
  from public.author_payouts ap
  where ap.author_id = p_author_id
    and ap.currency = p_currency
    and ap.status in ('pending', 'processing', 'reconciling');

  v_active_reservation := exists (
    select 1
    from public.author_payouts ap
    where ap.author_id = p_author_id
      and ap.currency = p_currency
      and ap.status in ('pending', 'processing', 'reconciling')
  );

  v_has_destination := exists (
    select 1
    from public.author_payout_destinations apd
    where apd.author_id = p_author_id and apd.currency = p_currency
  );

  if v_available is null then
    v_payoutable := null;
  else
    v_payoutable := v_available - v_reserved;
  end if;

  author_id := p_author_id;
  currency := p_currency;
  ledger_available_minor := v_available;
  reserved_minor := v_reserved;
  payoutable_minor := v_payoutable;
  threshold_configured := v_threshold is not null;
  threshold_minor := v_threshold;
  active_reservation := v_active_reservation;

  if v_threshold is null then
    eligible := false;
    ineligible_reason := 'no_settings';
  elsif v_minimum_policy is null then
    eligible := false;
    ineligible_reason := 'no_minimum_policy';
  else
    -- Both operands are non-null here (Correction 1's own NULL-safety
    -- requirement) -- safe to compute the effective threshold now.
    v_effective_threshold := greatest(v_threshold, v_minimum_policy);

    if v_available is null then
      eligible := false;
      ineligible_reason := 'no_available_balance';
    elsif v_active_reservation then
      eligible := false;
      ineligible_reason := 'active_reservation';
    elsif v_payoutable < v_effective_threshold then
      eligible := false;
      ineligible_reason := 'below_threshold';
    elsif not v_has_destination then
      eligible := false;
      ineligible_reason := 'no_destination';
    else
      eligible := true;
      ineligible_reason := null;
    end if;
  end if;

  return next;
end;
$$;

revoke all on function public.author_payout_eligibility(uuid, text) from public, anon, authenticated;
grant execute on function public.author_payout_eligibility(uuid, text) to service_role;

-- ============================================================
-- Part 8: get_author_payout_overview() -- CREATE OR REPLACE. Adds safe,
-- policy-aware fields so the author-facing dashboard can never claim
-- "threshold reached" using only the raw stored threshold when the
-- active platform minimum is higher (BANK-PAYOUT-1B.1 Correction 1's
-- own dashboard-implication finding; BANK-PAYOUT-1C Section 22).
--
-- No bank details, no fabricated minimum: minimum_policy_configured is
-- false and effective_threshold_minor/destination_configured are
-- honestly null/false whenever no active policy exists for that
-- currency -- exactly mirroring author_payout_eligibility()'s own
-- fail-closed semantics, never inventing a number.
--
-- Unlike author_payout_eligibility() (Part 7), this function's own
-- RETURNS TABLE shape DOES change (three new output columns) -- an
-- explicit DROP is required first, since CREATE OR REPLACE cannot
-- widen a function's OUT-parameter shape in Postgres.
-- ============================================================

drop function if exists public.get_author_payout_overview();

create or replace function public.get_author_payout_overview()
returns table (
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  available_for_payout_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  threshold_reached boolean,
  minimum_policy_configured boolean,
  effective_threshold_minor bigint,
  destination_configured boolean
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
  policy as (
    select pmp.currency, pmp.minimum_threshold_minor
    from public.payout_minimum_policy pmp
    where pmp.is_active = true
  ),
  destinations as (
    select apd.currency
    from public.author_payout_destinations apd
    where apd.author_id = auth.uid()
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
      and p.minimum_threshold_minor is not null
      and (coalesce(l.available_minor, 0) - coalesce(r.reserved_minor, 0))
        >= greatest(s.threshold_minor, p.minimum_threshold_minor)
    ) as threshold_reached,
    (p.minimum_threshold_minor is not null) as minimum_policy_configured,
    case
      when s.threshold_minor is not null and p.minimum_threshold_minor is not null
        then greatest(s.threshold_minor, p.minimum_threshold_minor)
      else null
    end as effective_threshold_minor,
    (d.currency is not null) as destination_configured
  from currencies c
  left join ledger l on l.currency = c.currency
  left join reservations r on r.currency = c.currency
  left join settings s on s.currency = c.currency
  left join policy p on p.currency = c.currency
  left join destinations d on d.currency = c.currency
  order by c.currency;
$$;

revoke all on function public.get_author_payout_overview() from public, anon, authenticated;
grant execute on function public.get_author_payout_overview() to authenticated;

-- ============================================================
-- Part 9: author_ledger_balance() -- CREATE OR REPLACE. The only
-- change is paid_out_minor's own filter, extended from entry_type =
-- 'payout' to entry_type in ('payout', 'payout_reversal') (BANK-
-- PAYOUT-1B Section E/1B.1's own worked-example confirmation). Because
-- 'payout' entries are negative and 'payout_reversal' entries are
-- positive, this single change turns paid_out_minor into the correct
-- NET figure -- a full reversal nets exactly back to zero. Every other
-- column (current_balance_minor, available_minor, net_earnings_minor,
-- pending_minor, lifetime_*) is untouched: they are already either
-- entry-type-agnostic sums (automatically absorbing the new type) or
-- explicitly filtered to a set that correctly excludes it.
-- ============================================================

create or replace function public.author_ledger_balance(p_author_id uuid)
returns table (
  currency text,
  lifetime_sale_minor bigint,
  lifetime_refund_minor bigint,
  lifetime_adjustment_minor bigint,
  net_earnings_minor bigint,
  paid_out_minor bigint,
  pending_minor bigint,
  available_minor bigint,
  current_balance_minor bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  with entries as (
    select
      ale.currency,
      ale.entry_type,
      ale.amount_minor,
      case
        when ale.entry_type = 'sale' then ale.available_at
        when ale.entry_type = 'refund' then coalesce(
          (
            select sib.available_at
            from public.author_ledger_entries sib
            where sib.purchase_id = ale.purchase_id and sib.entry_type = 'sale'
            limit 1
          ),
          ale.available_at
        )
        else coalesce(ale.available_at, ale.created_at)
      end as effective_available_at
    from public.author_ledger_entries ale
    where ale.author_id = p_author_id
  )
  select
    currency,
    coalesce(sum(amount_minor) filter (where entry_type = 'sale'), 0)::bigint as lifetime_sale_minor,
    coalesce(-sum(amount_minor) filter (where entry_type = 'refund'), 0)::bigint as lifetime_refund_minor,
    coalesce(sum(amount_minor) filter (where entry_type = 'adjustment'), 0)::bigint as lifetime_adjustment_minor,
    coalesce(sum(amount_minor) filter (where entry_type in ('sale', 'refund', 'adjustment')), 0)::bigint as net_earnings_minor,
    coalesce(-sum(amount_minor) filter (where entry_type in ('payout', 'payout_reversal')), 0)::bigint as paid_out_minor,
    coalesce(sum(amount_minor) filter (where effective_available_at > now()), 0)::bigint as pending_minor,
    (
      coalesce(sum(amount_minor), 0)
      - coalesce(sum(amount_minor) filter (where effective_available_at > now()), 0)
    )::bigint as available_minor,
    coalesce(sum(amount_minor), 0)::bigint as current_balance_minor
  from entries
  group by currency;
$$;

revoke all on function public.author_ledger_balance(uuid) from public, anon, authenticated;
grant execute on function public.author_ledger_balance(uuid) to service_role;

-- ============================================================
-- Part 10: list_author_payout_history() -- CREATE OR REPLACE. Adds a
-- safe, derived `reversed boolean` and `reversed_at timestamptz` via a
-- LEFT JOIN against payout_reversal -- never provider, provider_
-- reference, or reason (BANK-PAYOUT-1B Section 8's own explicit
-- instruction). author_payouts.status remains 'paid' -- this migration
-- does not add a 'reversed' status (BANK-PAYOUT-1B.1 Section 9's
-- locked decision: the payout_reversal row's own existence is the
-- authoritative signal; a join is exactly as queryable as a status
-- value, without growing the CHECK-constrained enum for zero net
-- capability).
--
-- This function's RETURNS TABLE shape also changes (two new output
-- columns) -- an explicit DROP is required first, same reason as
-- get_author_payout_overview() above.
-- ============================================================

drop function if exists public.list_author_payout_history(integer, timestamptz, uuid);

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
  failed_at timestamptz,
  reversed boolean,
  reversed_at timestamptz
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
      ap.failed_at,
      (pr.payout_id is not null) as reversed,
      pr.reversed_at
    from public.author_payouts ap
    left join public.payout_reversal pr on pr.payout_id = ap.id
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
-- Part 11: set_author_payout_destination() -- the one entry point that
-- ever writes author_payout_destinations. No author_id parameter --
-- auth.uid() exclusively (BANK-PAYOUT-1A Section J / 1C Section 11).
--
-- IBAN validation (BANK-PAYOUT-1A.1 Section H): structural length +
-- MOD-97 (ISO 7064) checksum + Albanian-specific length when the
-- country prefix is 'AL'. This proves the string is well-formed --
-- NEVER that the account exists or belongs to the author. Nothing in
-- this function's success response implies ownership verification.
-- ============================================================

create or replace function public.iban_mod97_valid(p_iban text)
returns boolean
language plpgsql
set search_path = ''
immutable
as $$
declare
  v_rearranged text;
  v_numeric text;
  v_char text;
  v_remainder numeric := 0;
  i integer;
begin
  if p_iban is null or length(p_iban) < 4 or length(p_iban) > 34 then
    return false;
  end if;
  if p_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]+$' then
    return false;
  end if;

  -- Move the first 4 characters (country + check digits) to the end,
  -- then expand every letter to its two-digit numeric value (A=10 ...
  -- Z=35), exactly per ISO 7064 MOD 97-10.
  v_rearranged := substr(p_iban, 5) || substr(p_iban, 1, 4);
  v_numeric := '';
  for i in 1..length(v_rearranged) loop
    v_char := substr(v_rearranged, i, 1);
    if v_char between '0' and '9' then
      v_numeric := v_numeric || v_char;
    else
      v_numeric := v_numeric || (ascii(v_char) - ascii('A') + 10)::text;
    end if;
  end loop;

  -- Compute the numeric string mod 97 in manageable chunks (it can be
  -- far longer than fits in a standard integer/bigint).
  for i in 1..length(v_numeric) loop
    v_remainder := (v_remainder * 10 + substr(v_numeric, i, 1)::numeric) % 97;
  end loop;

  return v_remainder = 1;
end;
$$;

revoke all on function public.iban_mod97_valid(text) from public, anon, authenticated;
grant execute on function public.iban_mod97_valid(text) to service_role, authenticated;

create or replace function public.set_author_payout_destination(
  p_currency text,
  p_beneficiary_name text,
  p_iban text
)
returns table (
  currency text,
  beneficiary_name text,
  iban text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_beneficiary_name text;
  v_iban text;
begin
  v_currency := upper(btrim(coalesce(p_currency, '')));
  v_beneficiary_name := btrim(coalesce(p_beneficiary_name, ''));
  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'set_author_payout_destination: currency must be a 3-letter ISO code';
  end if;

  if v_beneficiary_name = '' then
    raise exception 'set_author_payout_destination: beneficiary_name is required and must not be blank';
  end if;

  if v_iban = '' then
    raise exception 'set_author_payout_destination: iban is required and must not be blank';
  end if;

  if v_currency = 'ALL' and v_iban !~ '^AL[0-9]{2}[A-Z0-9]{24}$' then
    raise exception 'set_author_payout_destination: iban does not match the expected Albanian IBAN format (AL + 26 digits/letters)';
  end if;

  if not public.iban_mod97_valid(v_iban) then
    raise exception 'set_author_payout_destination: iban fails checksum validation -- this only confirms the format is well-formed, never that the account exists or belongs to you';
  end if;

  -- ON CONFLICT ON CONSTRAINT (not a bare column list): this
  -- function's own OUT parameter is also named "currency" (RETURNS
  -- TABLE above), which makes an unqualified "currency" in a bare
  -- ON CONFLICT (author_id, currency) column list ambiguous between
  -- the PL/pgSQL variable and the table column -- the same class of
  -- bug start_author_payout()'s own comment already documents once
  -- this session. Naming the constraint sidesteps it entirely.
  insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban, updated_at)
  values (auth.uid(), v_currency, v_beneficiary_name, v_iban, now())
  on conflict on constraint author_payout_destinations_pkey do update
    set beneficiary_name = excluded.beneficiary_name,
        iban = excluded.iban,
        updated_at = now();

  currency := v_currency;
  beneficiary_name := v_beneficiary_name;
  iban := v_iban;
  select apd.updated_at into updated_at
  from public.author_payout_destinations apd
  where apd.author_id = auth.uid() and apd.currency = v_currency;
  return next;
end;
$$;

revoke all on function public.set_author_payout_destination(text, text, text) from public, anon, authenticated;
grant execute on function public.set_author_payout_destination(text, text, text) to authenticated;

-- ============================================================
-- Part 12: set_author_payout_threshold() -- gated deterministically on
-- an active payout_minimum_policy row (BANK-PAYOUT-1B.1 Correction 1 /
-- BANK-PAYOUT-1C Section 16/19). No author_id parameter. While no
-- active policy row exists for the target currency, every write is
-- refused -- never a silent unvalidated accept, never a silently
-- clamped value. No amount is invented anywhere in this function.
-- ============================================================

create or replace function public.set_author_payout_threshold(
  p_currency text,
  p_threshold_minor bigint
)
returns table (
  currency text,
  threshold_minor bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_minimum bigint;
begin
  v_currency := upper(btrim(coalesce(p_currency, '')));

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'set_author_payout_threshold: currency must be a 3-letter ISO code';
  end if;

  if p_threshold_minor is null or p_threshold_minor <= 0 then
    raise exception 'set_author_payout_threshold: threshold_minor must be a positive amount';
  end if;

  select pmp.minimum_threshold_minor into v_minimum
  from public.payout_minimum_policy pmp
  where pmp.currency = v_currency and pmp.is_active = true;

  if v_minimum is null then
    raise exception
      'set_author_payout_threshold: no active minimum payout policy is configured for % yet -- threshold cannot be saved until one is',
      v_currency;
  end if;

  if p_threshold_minor < v_minimum then
    raise exception
      'set_author_payout_threshold: threshold_minor (%) is below the current minimum (%) for % -- choose a value at or above the minimum',
      p_threshold_minor, v_minimum, v_currency;
  end if;

  -- ON CONFLICT ON CONSTRAINT, same reasoning as
  -- set_author_payout_destination() above: this function's own OUT
  -- parameter is also named "currency", which makes a bare column-list
  -- conflict target ambiguous.
  insert into public.author_payout_settings (author_id, currency, threshold_minor, updated_at)
  values (auth.uid(), v_currency, p_threshold_minor, now())
  on conflict on constraint author_payout_settings_pkey do update
    set threshold_minor = excluded.threshold_minor,
        updated_at = now();

  currency := v_currency;
  threshold_minor := p_threshold_minor;
  select aps.updated_at into updated_at
  from public.author_payout_settings aps
  where aps.author_id = auth.uid() and aps.currency = v_currency;
  return next;
end;
$$;

revoke all on function public.set_author_payout_threshold(text, bigint) from public, anon, authenticated;
grant execute on function public.set_author_payout_threshold(text, bigint) to authenticated;

-- ============================================================
-- Part 13: staff_has_permission() -- CREATE OR REPLACE. Adds
-- 'finance.payout_export' and 'finance.payout_operate' to the admin
-- role's existing permission list, alongside 'finance.view' (owner
-- already has every permission unconditionally via its own first
-- branch, unchanged). This is the ONLY place valid permission strings
-- are registered in this codebase -- there is no separate permissions
-- table (BANK-PAYOUT-1C's own required discovery: 'finance.export'/
-- 'finance.reconcile'/'finance.recover_orphaned', named in a migration
-- 050 comment, were never actually wired in here or anywhere else --
-- confirmed by reading this function's live body before writing this
-- migration, not assumed).
-- ============================================================

create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_members sm
    where sm.user_id = auth.uid()
      and (
        sm.role = 'owner'
        or (
          sm.role = 'admin'
          and p_permission in (
            'admin.access', 'reports.view', 'reports.resolve',
            'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view',
            'finance.view', 'finance.payout_export', 'finance.payout_operate',
            'blog.view', 'blog.manage'
          )
        )
        or (
          sm.role = 'editor'
          and p_permission in ('admin.access', 'blog.view', 'blog.manage')
        )
        or (
          sm.role = 'moderator'
          and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
        )
        or (
          sm.role = 'support'
          and p_permission in ('admin.access', 'refunds.view')
        )
      )
  );
$$;

-- ============================================================
-- Part 14: start_author_payout() -- CREATE OR REPLACE. External
-- signature/RETURNS TABLE shape unchanged. Existing behavior fully
-- preserved (pending-only source, fresh balance revalidation,
-- cancel-don't-resize on shrunk balance). Additions (BANK-PAYOUT-1B.1
-- Section 10/1C Section 15): a final live destination lookup; if none
-- exists, CANCEL (not "leave pending"), by direct analogy to the
-- existing balance-shrink cancel behavior -- a stale, unactionable
-- reservation must never sit silently blocking the author's own
-- eligibility for a future, correctly-configured attempt. Otherwise:
-- generate a unique payment_reference (retrying only on a genuine
-- payment_reference collision -- every other error re-raises,
-- BANK-PAYOUT-1C Section 14's own instruction), freeze the immutable
-- snapshot, and transition atomically, in the same transaction as the
-- existing balance check.
-- ============================================================

create or replace function public.start_author_payout(p_payout_id uuid)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout record;
  v_available bigint;
  v_reserved_excluding_self bigint;
  v_payoutable bigint;
  v_destination record;
  v_payment_reference text;
  v_attempt integer := 0;
  v_constraint_name text;
begin
  select * into v_payout
  from public.author_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'start_author_payout: payout % not found', p_payout_id;
  end if;

  if v_payout.status <> 'pending' then
    raise exception
      'start_author_payout: payout % is not pending (current status %)',
      p_payout_id, v_payout.status;
  end if;

  select balance.available_minor into v_available
  from public.author_ledger_balance(v_payout.author_id) balance
  where balance.currency = v_payout.currency;

  select coalesce(sum(ap.amount_minor), 0) into v_reserved_excluding_self
  from public.author_payouts ap
  where ap.author_id = v_payout.author_id
    and ap.currency = v_payout.currency
    and ap.status in ('pending', 'processing', 'reconciling')
    and ap.id <> p_payout_id;

  v_payoutable := coalesce(v_available, 0) - v_reserved_excluding_self;

  if v_payoutable < v_payout.amount_minor then
    update public.author_payouts ap
    set status = 'cancelled'
    where ap.id = p_payout_id and ap.status = 'pending';

    payout_id := p_payout_id;
    status := 'cancelled';
    return next;
    return;
  end if;

  -- Final live destination check (Section 13/15): a payout must never
  -- be handed off with nothing to pay to. Cancelling here mirrors the
  -- balance-shrink branch above exactly, for exactly the same reason.
  select * into v_destination
  from public.author_payout_destinations
  where author_id = v_payout.author_id and currency = v_payout.currency;

  if not found then
    update public.author_payouts ap
    set status = 'cancelled'
    where ap.id = p_payout_id and ap.status = 'pending';

    payout_id := p_payout_id;
    status := 'cancelled';
    return next;
    return;
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_payment_reference := 'LIBRUM-' || to_char(now(), 'YYYY-MM') || '-'
      || upper(substr(encode(gen_random_uuid()::text::bytea, 'hex'), 1, 6));

    begin
      insert into public.payout_destination_snapshots
        (payout_id, beneficiary_name, iban, currency, payment_reference)
      values
        (p_payout_id, v_destination.beneficiary_name, v_destination.iban, v_destination.currency, v_payment_reference);

      exit;
    exception
      when unique_violation then
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'payout_destination_snapshots_payment_reference_key' then
          if v_attempt >= 8 then
            raise exception
              'start_author_payout: could not generate a unique payment_reference for payout % after % attempts',
              p_payout_id, v_attempt;
          end if;
          -- Retry with a fresh candidate -- a genuine, expected,
          -- collision-safe retry per BANK-PAYOUT-1C Section 14.
        else
          -- Any other uniqueness violation (e.g. the payout_id primary
          -- key, which would indicate this function ran twice for the
          -- same payout) is a real anomaly -- re-raise, never silently
          -- retried.
          raise;
        end if;
    end;
  end loop;

  update public.author_payouts ap
  set status = 'processing', processing_at = now()
  where ap.id = p_payout_id and ap.status = 'pending';

  payout_id := p_payout_id;
  status := 'processing';
  return next;
end;
$$;

revoke all on function public.start_author_payout(uuid) from public, anon, authenticated;
grant execute on function public.start_author_payout(uuid) to service_role;

-- ============================================================
-- Part 15: finalize_author_payout() -- CREATE OR REPLACE. External
-- signature/RETURNS TABLE shape unchanged. Existing idempotency/state
-- behavior fully preserved. The one addition (BANK-PAYOUT-1B.1
-- Correction 2c/1C Section 16): when p_provider = 'manual_bank',
-- p_provider_reference MUST equal the frozen
-- payout_destination_snapshots.payment_reference for that payout --
-- the database is the final authority preventing a mismatched
-- reference from ever being finalized. Deliberately NOT a universal,
-- provider-agnostic rule: a future automated provider's own
-- provider_reference (its own transaction id) is legitimately a
-- different string from Librum's internal payment_reference, and nothing
-- here constrains that case.
-- ============================================================

create or replace function public.finalize_author_payout(
  p_payout_id uuid,
  p_provider text,
  p_provider_reference text
)
returns table (
  payout_id uuid,
  status text,
  ledger_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout record;
  v_ledger_id uuid;
  v_snapshot_reference text;
begin
  if p_provider is null or btrim(p_provider) = ''
    or p_provider_reference is null or btrim(p_provider_reference) = ''
  then
    raise exception 'finalize_author_payout: provider and provider_reference are both required and must not be blank';
  end if;

  select * into v_payout
  from public.author_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'finalize_author_payout: payout % not found', p_payout_id;
  end if;

  if v_payout.status = 'paid' then
    if v_payout.provider = p_provider and v_payout.provider_reference = p_provider_reference then
      select ale.id into v_ledger_id
      from public.author_ledger_entries ale
      where ale.payout_id = p_payout_id and ale.entry_type = 'payout';

      payout_id := p_payout_id;
      status := 'paid';
      ledger_entry_id := v_ledger_id;
      return next;
      return;
    else
      raise exception
        'finalize_author_payout: payout % is already paid with a DIFFERENT provider reference (existing %/%, received %/%) -- refusing to overwrite; this requires operator investigation, not an automatic retry',
        p_payout_id, v_payout.provider, v_payout.provider_reference, p_provider, p_provider_reference;
    end if;
  end if;

  if v_payout.status not in ('processing', 'reconciling') then
    raise exception
      'finalize_author_payout: payout % is not processing/reconciling (current status %)',
      p_payout_id, v_payout.status;
  end if;

  if p_provider = 'manual_bank' then
    select pds.payment_reference into v_snapshot_reference
    from public.payout_destination_snapshots pds
    where pds.payout_id = p_payout_id;

    if v_snapshot_reference is null then
      raise exception
        'finalize_author_payout: payout % has no destination snapshot -- it was never started/processed through start_author_payout()',
        p_payout_id;
    end if;

    if p_provider_reference <> v_snapshot_reference then
      raise exception
        'finalize_author_payout: for manual_bank, provider_reference (%) must equal the frozen payment reference used at hand-off (%) for payout %',
        p_provider_reference, v_snapshot_reference, p_payout_id;
    end if;
  end if;

  insert into public.author_ledger_entries
    (author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
  values
    (v_payout.author_id, p_payout_id, 'payout', -v_payout.amount_minor, v_payout.currency, now(), now())
  returning id into v_ledger_id;

  update public.author_payouts
  set status = 'paid',
      provider = p_provider,
      provider_reference = p_provider_reference,
      paid_at = now()
  where id = p_payout_id;

  payout_id := p_payout_id;
  status := 'paid';
  ledger_entry_id := v_ledger_id;
  return next;
end;
$$;

revoke all on function public.finalize_author_payout(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_author_payout(uuid, text, text) to service_role;

-- ============================================================
-- Part 16: list_payout_batch_export() -- the ONLY place full
-- beneficiary/IBAN data becomes visible to a staff member, gated
-- internally on finance.payout_export (BANK-PAYOUT-1B.1 Section
-- 19/1C Section 24/25). Granted to `authenticated`, matching this
-- codebase's own existing /admin/finance RPC convention (permission
-- checked inside the body, not via a service_role-only grant) --
-- distinct from the payout-mutation RPCs above, which are called
-- through a trusted server action, never directly by a staff member's
-- own session.
--
-- Pure read, provider-neutral row shape, only `processing`-status
-- payouts for the given run, joined to their own immutable snapshot.
-- No mutation, no unrelated internal identifiers, no provider
-- credentials.
-- ============================================================

create or replace function public.list_payout_batch_export(p_payout_run_id uuid)
returns table (
  payout_id uuid,
  payment_reference text,
  beneficiary_name text,
  iban text,
  currency text,
  amount_minor bigint
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.staff_has_permission('finance.payout_export') then
    raise exception 'list_payout_batch_export: permission denied';
  end if;

  return query
    select
      ap.id as payout_id,
      pds.payment_reference,
      pds.beneficiary_name,
      pds.iban,
      ap.currency,
      ap.amount_minor
    from public.author_payouts ap
    join public.payout_destination_snapshots pds on pds.payout_id = ap.id
    where ap.payout_run_id = p_payout_run_id
      and ap.status = 'processing'
    order by pds.payment_reference;
end;
$$;

revoke all on function public.list_payout_batch_export(uuid) from public, anon, authenticated;
grant execute on function public.list_payout_batch_export(uuid) to authenticated;

-- ============================================================
-- Scope confirmation: migrations 048-054 remain byte-unchanged.
-- reserve_author_payout(), mark_author_payout_reconciling(),
-- cancel_author_payout(), start_scheduled_payout_run(),
-- complete_scheduled_payout_run(), dry_run_scheduled_payouts() are
-- completely untouched -- zero duplicate lifecycle RPCs. No Stripe
-- code path is touched, called, or affected. No scheduler HTTP route,
-- no cron configuration, no feature switch, no bank/provider adapter,
-- and no real money movement exist anywhere in this file.
-- payout_minimum_policy carries zero rows -- no minimum value is
-- invented here. PAYOUT_SCHEDULER_ENABLED is not referenced by this
-- migration at all.
-- ============================================================
