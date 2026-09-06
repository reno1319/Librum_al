-- LIBRUM 2.0 LEDGER-1E-B: provider-neutral author payout reservation +
-- state-machine foundation. Built on migrations 048/049/050, all already
-- LIVE in production and NOT modified by this file in any way. No
-- payout provider is called anywhere in this migration; no scheduler
-- exists yet; no real money moves. All financial tables have zero
-- production rows at the time this migration is written.
--
-- SCOPE (LEDGER-1E-A's approved architecture, refined per LEDGER-1E-B's
-- own review):
--   Part 1: author_payout_settings -- evolve PRIMARY KEY(author_id) to
--           PRIMARY KEY(author_id, currency) (a real schema defect
--           found during the 1E-A audit: one row per author permitted
--           only ONE currency's threshold).
--   Part 2: payout_runs -- a small, provider-neutral grouping/audit
--           table. NOT the money-safety mechanism.
--   Part 3: author_payouts -- additive changes: 'reconciling' status,
--           payout_run_id, the active-payout-per-author-currency unique
--           index (the actual money-safety mechanism), a provider-
--           reference uniqueness index, and a trigger enforcing that
--           amount_minor/currency/author_id/payout_run_id become
--           immutable once a payout leaves 'pending'.
--   Part 4: author_ledger_balance(p_author_id uuid) -- the ONE
--           canonical internal balance calculation, callable only by
--           service_role. get_author_financial_summary() (migration
--           050) is redefined here to be a thin auth.uid()-scoped
--           wrapper around it -- byte-identical external contract,
--           zero formula duplication.
--   Part 5-10: the six payout-mutation RPCs (reserve/start/mark-
--           reconciling/finalize/fail/cancel), service_role EXECUTE
--           only. No RPC in this migration is reachable by anon,
--           authenticated, or any staff permission -- not even
--           finance.view, which remains read-only exactly as it always
--           has been.
--
-- EXPLICITLY NOT IN THIS MIGRATION (per LEDGER-1E-B's own scope):
--   no payout provider adapter of any kind; no scheduler/cron route;
--   no manual-payout RPC or payouts.manage permission (deferred --
--   Section 27 of the task: manual-payout semantics aren't needed to
--   prove the automated system and would needlessly widen the money-
--   mutation surface today); no author-facing payout history/dashboard
--   change (LEDGER-1E-C); no payout_reversal entry_type (flagged as a
--   REQUIRED future migration before any real provider goes live --
--   see Part 8's own comment); no threshold-setting UI/RPC beyond what
--   SQL tests need as direct fixture inserts.
--
-- LEDGER-1E-B.1 (pre-commit hardening, folded into this same migration
-- rather than a new 052 -- 051 remains unapplied to production):
--   (a) payout_runs.run_key is now REQUIRED and non-blank for every
--       'scheduled' run, not merely unique when present.
--   (b) the amount/currency/author_id/payout_run_id immutability
--       trigger now applies from the moment a payout is INSERTED, not
--       only after it leaves 'pending' -- there is no legitimate
--       resize/reassignment path at any lifecycle stage in this
--       architecture; a stale reservation is cancelled and a fresh one
--       created, never mutated in place.
--   (c) service_role's DEFAULT-PRIVILEGES-derived direct INSERT/UPDATE/
--       DELETE on author_payouts and payout_runs is explicitly revoked
--       (SELECT retained) -- the only legal mutation path is now
--       EXECUTE on the six payout RPCs below, which succeed regardless
--       (a SECURITY DEFINER function runs its body as its OWNER, not as
--       the calling role, so this closes a real direct-DML bypass
--       without affecting the RPCs at all).
--   (d) finalize_author_payout() rejects blank/whitespace-only
--       provider/provider_reference, not merely NULL.
--   (e) a narrow CHECK enforces that a 'paid' row always carries a
--       non-blank provider, a non-blank provider_reference, and a
--       non-null paid_at -- a paid-with-no-external-correlation row is
--       now structurally impossible, not merely RPC-discouraged.
--   (f) reserve_author_payout()'s unique_violation handler now inspects
--       the actual constraint name (GET STACKED DIAGNOSTICS) -- only
--       the active-reservation index is treated as an expected losing
--       concurrency race; any other uniqueness violation re-raises,
--       so a future schema defect can never be silently swallowed as
--       "not eligible."
--   (g) author_payouts.payout_run_id changes from ON DELETE SET NULL to
--       ON DELETE RESTRICT -- now that payout_run_id is immutable from
--       insert, a payout's link to its run is permanent audit history,
--       and a run with any historical payouts must never be deletable
--       out from under them (matches the same RESTRICT posture already
--       used for author_payouts.author_id and author_ledger_entries'
--       own author_id/payout_id references).
-- ============================================================

-- ============================================================
-- Part 1: author_payout_settings multi-currency fix.
--
-- Migration 048 shipped this table with PRIMARY KEY(author_id) --
-- reasonable-looking at the time, but it structurally permits only ONE
-- currency's threshold per author. An author who earns in both EUR and
-- USD cannot express two independent thresholds. Zero production rows
-- exist, so this is a safe, non-destructive DDL change: drop the
-- single-column PK, add the composite one. currency (already NOT NULL,
-- already format-checked since 048) simply becomes part of the key
-- instead of a plain column. FK lifecycle (author_id -> profiles,
-- ON DELETE CASCADE -- pure preference data, no financial loss),
-- threshold_minor > 0, currency format, and created_at/updated_at are
-- all untouched. The existing RLS policy ("Authors can view their own
-- payout settings", auth.uid() = author_id) remains correct unchanged
-- under the new PK -- it already tolerates multiple rows per author
-- (it was never a single-row assumption, just a single-row REALITY
-- imposed by the old PK).
-- ============================================================

alter table public.author_payout_settings
  drop constraint author_payout_settings_pkey;

alter table public.author_payout_settings
  add primary key (author_id, currency);

-- ============================================================
-- Part 2: payout_runs -- provider-neutral grouping/audit table.
--
-- Purpose is auditability/reconciliation/idempotency-of-SCHEDULING
-- ONLY -- explicitly NOT the primary money-safety mechanism (Section
-- 15 of the task). That job belongs entirely to Part 3's active-payout
-- uniqueness index, which is robust to manual reruns/partial recovery
-- in a way a single "this month's run already happened" flag can never
-- be by itself. Kept intentionally minimal: no scheduler exists yet to
-- populate it (LEDGER-1E-D), so every column here is inert until then.
--
-- run_type is deliberately restricted to 'scheduled' only, not
-- ('scheduled', 'manual') -- there is no manual-payout feature in this
-- migration (Part 5's own comment), and inventing that vocabulary now
-- would be exactly the kind of speculative-ahead-of-the-feature-it-
-- guards addition this codebase's own established convention warns
-- against (see src/lib/staff-permissions.ts's comment on
-- finance.reconcile/finance.export). Widening this CHECK later, when a
-- manual-payout phase actually needs it, is a trivial additive
-- migration.
--
-- run_key is REQUIRED and non-blank for every row (LEDGER-1E-B.1):
-- since run_type currently allows only 'scheduled', this is
-- unconditional today, expressed as an explicit CHECK rather than a
-- plain NOT NULL so the rule's own reasoning stays documented in the
-- schema and generalizes cleanly if a future run_type is ever added
-- (e.g. 'manual', if a manual-payout phase legitimately needs a
-- keyless run -- at which point this CHECK's `run_type <> 'scheduled'`
-- escape clause already accommodates that without further change). A
-- nullable-run_key design was rejected: scheduler-invocation
-- idempotency (Section 15) only actually holds if every scheduled run
-- MUST supply a key that collides with a duplicate/concurrent firing --
-- an optional key would let a caller silently skip the very protection
-- this table exists to provide. The partial unique index below remains
-- the durable idempotency guard itself: two concurrent/duplicate
-- scheduler firings for the same logical period (e.g. run_key =
-- '2026-10') can never both succeed in creating a payout_runs row, so
-- at most one of them ever proceeds to reserve anything under that run.
-- ============================================================

create table public.payout_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null default 'scheduled' check (run_type in ('scheduled')),
  run_key text,
  scheduled_for date,
  started_at timestamptz,
  completed_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  created_at timestamptz not null default now(),

  constraint payout_runs_scheduled_run_key_required check (
    run_type <> 'scheduled'
    or (run_key is not null and btrim(run_key) <> '')
  )
);

create unique index payout_runs_run_type_run_key_idx
  on public.payout_runs (run_type, run_key)
  where run_key is not null;

-- No RLS policy is added -- deliberately locked down entirely for now
-- (RLS enabled, zero policies). There is no reporting UI/RPC yet
-- (LEDGER-1E-C). Reopening this for a staff-facing reconciliation view
-- is exactly the kind of narrow, purpose-built addition to make later,
-- not a speculative grant now.
alter table public.payout_runs enable row level security;
revoke all on public.payout_runs from anon, authenticated;

-- LEDGER-1E-B.1 (Section 5 hardening): service_role's own DEFAULT
-- PRIVILEGES-derived direct INSERT/UPDATE/DELETE is revoked here too --
-- there is no legitimate direct-DML path onto this table in this phase
-- either (no scheduler exists yet; every fixture/production write to
-- come is expected to go through a future scheduler entry point, never
-- a raw client INSERT). SELECT is retained (a future scheduler/staff
-- reporting surface will need to read it; read access carries no
-- money-safety risk). See the identical, more detailed comment on
-- author_payouts below for the full reasoning -- this table needs the
-- same posture even though it has no RPC of its own yet.
revoke all on public.payout_runs from service_role;
grant select on public.payout_runs to service_role;

-- ============================================================
-- Part 3: author_payouts -- additive state-machine + safety columns.
-- ============================================================

-- 3a. Add 'reconciling' to the status vocabulary. REQUIRED from V1
-- (Section 21 of the task): a provider outcome that is genuinely
-- AMBIGUOUS (e.g. a network timeout after the send request, where
-- Librum cannot tell whether the transfer went through) is a
-- fundamentally different fact from a CONFIRMED failure, and must be
-- representable as its own state -- collapsing the two would make an
-- automatic "just retry" response to an ambiguous outcome
-- indistinguishable from a safe retry of a confirmed failure, which is
-- exactly the double-pay risk this whole migration exists to prevent.
alter table public.author_payouts
  drop constraint author_payouts_status_check;

alter table public.author_payouts
  add constraint author_payouts_status_check
  check (status in ('pending', 'processing', 'paid', 'failed', 'cancelled', 'reconciling'));

-- 3b. payout_run_id -- nullable by design (no scheduler exists yet to
-- populate it, LEDGER-1E-D; a future manual payout, if ever built, may
-- also legitimately have none), but ON DELETE RESTRICT, not SET NULL
-- (LEDGER-1E-B.1, Section 12): once inserted, payout_run_id becomes
-- IMMUTABLE (3e's trigger, hardened below to cover it from insert
-- onward) -- it is permanent audit/grouping history, not mutable
-- metadata. SET NULL would have silently severed that history the
-- moment a payout_runs row was ever deleted, which is exactly backwards
-- for a field this migration now treats as immutable: a run with any
-- historical payouts referencing it must never be deletable at all,
-- forcing that to surface as an explicit failure an operator has to
-- deal with, not a silent orphaning. This matches the exact RESTRICT
-- posture already used for author_payouts.author_id itself and for
-- author_ledger_entries' own author_id/payout_id references (both
-- migration 048) -- financial/audit history in this schema is never
-- allowed to quietly go missing.
alter table public.author_payouts
  add column payout_run_id uuid references public.payout_runs(id) on delete restrict;

create index author_payouts_payout_run_id_idx
  on public.author_payouts (payout_run_id)
  where payout_run_id is not null;

-- 3c. THE MONEY-SAFETY INVARIANT (Sections 9/12/13 of the task): at
-- most ONE active reservation per (author_id, currency), where "active"
-- means status IN ('pending', 'processing', 'reconciling') -- exactly
-- the three non-terminal states, i.e. author_payouts itself IS the
-- reservation for as long as it hasn't reached paid/failed/cancelled.
--
-- This single partial unique index is the ENTIRE concurrency mechanism
-- (Section 12) -- no advisory lock, no explicit SELECT ... FOR UPDATE
-- is needed at reservation time. If reserve_author_payout() (Part 5)
-- computes the payoutable amount and INSERTs the reservation row inside
-- one transaction, then two genuinely concurrent calls for the same
-- author+currency may both compute the same payoutable figure (READ
-- COMMITTED won't see the other's still-uncommitted INSERT), but only
-- ONE of their two INSERTs can ever land -- the second hits
-- unique_violation and its entire transaction rolls back atomically,
-- with zero partial effect. Application-level "if" checks alone
-- (Section 12's own explicit instruction) cannot close this race; a
-- real unique constraint can, because Postgres itself serializes on it.
create unique index author_payouts_one_active_per_author_currency_idx
  on public.author_payouts (author_id, currency)
  where status in ('pending', 'processing', 'reconciling');

-- 3d. Provider-reference uniqueness (Section 17): once a provider and a
-- provider_reference are both known, that pair must correlate to
-- exactly one Librum payout -- otherwise one external transfer could be
-- claimed by two different payout rows. Partial (both columns
-- non-null) because a pending/processing payout legitimately has
-- neither yet.
create unique index author_payouts_provider_reference_idx
  on public.author_payouts (provider, provider_reference)
  where provider is not null and provider_reference is not null;

-- 3e. ECONOMIC IDENTITY IMMUTABILITY, DATABASE-ENFORCED (Section 20,
-- HARDENED per LEDGER-1E-B.1 Section 4): this is money state, so "only
-- the six RPCs below ever touch this table" is not treated as
-- sufficient on its own -- service_role itself bypasses RLS (confirmed:
-- "Bypass RLS" is an inherent property of the service_role database
-- role in this project) and, before Section 5's grant hardening further
-- below, could in principle run an arbitrary UPDATE directly, outside
-- any RPC. A BEFORE UPDATE trigger closes that gap independently of
-- (i.e. as defense-in-depth alongside) the grant change: author_id/
-- currency/amount_minor/payout_run_id can NEVER change again through
-- ANY update path, from the moment a payout is INSERTED, regardless of
-- its current status -- not "only after it leaves pending." The
-- approved payout architecture has no legitimate resize/reassignment
-- path at ANY lifecycle stage: a stale pending reservation that no
-- longer fits the current balance is CANCELLED and a fresh one created
-- (see start_author_payout()'s own revalidation logic, Part 6 below),
-- never mutated in place. status/provider/provider_reference/the
-- lifecycle timestamps remain freely updatable by the legal-transition
-- RPCs.
--
-- This mirrors the emergency-maintenance posture already established
-- elsewhere in this schema for append-only tables (e.g. payment_events/
-- author_ledger_entries themselves carry no mutating grants to any
-- client role, table owner/superuser remains able to intervene
-- directly) -- a trigger the actual table owner/superuser can disable
-- for genuine incident recovery (ALTER TABLE ... DISABLE TRIGGER) is
-- the same "blocked by default, owner-overridable" shape, just applied
-- to UPDATE instead of relying purely on absent grants, because here
-- some UPDATEs (status transitions) are legitimate and must remain
-- normal operation.
create or replace function public.enforce_author_payouts_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.amount_minor is distinct from old.amount_minor
    or new.currency is distinct from old.currency
    or new.author_id is distinct from old.author_id
    or new.payout_run_id is distinct from old.payout_run_id
  then
    raise exception
      'author_payouts: amount_minor/currency/author_id/payout_run_id are immutable from the moment a payout is created (payout id %, current status %)',
      old.id, old.status;
  end if;
  return new;
end;
$$;

create trigger author_payouts_enforce_immutability
  before update on public.author_payouts
  for each row
  execute function public.enforce_author_payouts_immutability();

-- 3f. PAID-STATE STRUCTURAL INVARIANT (LEDGER-1E-B.1 Section 8): a
-- 'paid' row must always carry a real external correlation -- a
-- non-blank provider, a non-blank provider_reference, and a non-null
-- paid_at. finalize_author_payout() (Part 8 below) already validates
-- and sets all three atomically in the same UPDATE that sets
-- status='paid', so this CHECK never fires against normal operation --
-- it exists so a paid-with-no-correlation row is impossible even
-- against a hypothetical future bug or a direct superuser mistake, not
-- merely RPC-discouraged. Deliberately ONE-DIRECTIONAL and narrow: it
-- says nothing about pending/processing/reconciling/failed/cancelled
-- rows' own provider/timestamp combinations (which legitimately vary
-- across those states -- e.g. failed_at is set only on failure,
-- processing_at only once processing begins), so it can never obstruct
-- any of those transitions. The reverse implication (a NON-paid row
-- must have a NULL paid_at) is intentionally NOT added as a matching
-- CHECK: no RPC in this schema ever sets paid_at except
-- finalize_author_payout(), always paired with status='paid' in the
-- same statement, so that direction is already guaranteed structurally
-- -- a redundant CHECK for it would add constraint surface without
-- adding real protection, and would make a legitimate future need (e.g.
-- recording forensic detail on an already-failed row) awkward for no
-- benefit.
alter table public.author_payouts
  add constraint author_payouts_paid_requires_provider_and_reference
  check (
    status <> 'paid'
    or (
      provider is not null and btrim(provider) <> ''
      and provider_reference is not null and btrim(provider_reference) <> ''
      and paid_at is not null
    )
  );

-- LEDGER-1E-B.1 Section 5: close the direct service_role money-state
-- DML path. This project's stub/production Supabase provisioning
-- grants service_role ALL privileges (SELECT/INSERT/UPDATE/DELETE) on
-- every public-schema table by default (ALTER DEFAULT PRIVILEGES,
-- confirmed empirically: has_table_privilege('service_role', ...,
-- 'INSERT'/'UPDATE'/'DELETE') all returned true before this statement)
-- -- migrations 048/049/050 never revoked this for author_payouts, so
-- the intended "service_role calls the RPC, the RPC's OWNER performs
-- the actual mutation" architecture was, until now, sitting alongside
-- an unused-but-real direct-DML bypass.
--
-- Revoking it here is both SAFE and EFFECTIVE, verified directly (not
-- assumed): BYPASSRLS and table-level GRANT/REVOKE are two entirely
-- separate Postgres privilege layers -- BYPASSRLS only affects which
-- ROWS a policy would otherwise hide, never whether a role may run
-- INSERT/UPDATE/DELETE on a table at all, so revoking these grants is
-- fully effective regardless of service_role's BYPASSRLS attribute
-- (confirmed: a direct service_role INSERT/UPDATE/DELETE against this
-- table now fails with "permission denied for table author_payouts").
-- It does not break the RPCs below: every one of them is SECURITY
-- DEFINER, so its body executes with the privileges of its OWNER (the
-- table owner), never the calling role's own grants -- confirmed
-- directly: the full reserve/start/finalize lifecycle, called AS
-- service_role, still succeeds end to end after this revoke. SELECT is
-- retained (harmless for money-safety, and useful for a future
-- scheduler/reporting surface to read raw rows).
revoke all on public.author_payouts from service_role;
grant select on public.author_payouts to service_role;

-- ============================================================
-- Part 4: THE CANONICAL BALANCE CALCULATION (Sections 4-5 of the task
-- -- a new, explicit requirement this migration exists partly to
-- satisfy).
--
-- get_author_financial_summary() (migration 050) is auth.uid()-scoped
-- by design -- correct for an author-facing RPC, but structurally
-- unusable by a service-role payout engine that must compute an
-- ARBITRARY author's balance. The wrong fix would be copying migration
-- 050's CTE formula into reserve_author_payout() (Part 5) -- two
-- independently-maintained copies of the pending/available formula
-- WILL drift the first time either one is edited without the other.
--
-- The fix: extract that exact formula into ONE canonical, parameterized
-- function -- author_ledger_balance(p_author_id uuid) -- and make
-- get_author_financial_summary() itself a one-line wrapper around it.
-- Every accounting rule LEDGER-1D established (sale/refund sibling
-- re-attribution, the adjustment COALESCE(available_at, created_at)
-- rule, payout's own available_at convention, current_balance = pending
-- + available) now has exactly ONE implementation, read by both the
-- author-facing RPC and the payout engine. This is copied byte-for-byte
-- from migration 050's own CTE body, with only `ale.author_id =
-- auth.uid()` generalized to `ale.author_id = p_author_id` -- no
-- accounting logic changes at all.
--
-- SECURITY: SECURITY DEFINER (reads author_ledger_entries directly,
-- bypassing RLS as the function owner, exactly like every other
-- SECURITY DEFINER function in this schema -- the p_author_id filter in
-- the query text IS the access control). EXECUTE granted ONLY to
-- service_role -- not PUBLIC, not anon, not authenticated, not even
-- finance.view staff (finance.view remains READ-ONLY via its own
-- existing RLS policy on the raw table; it was never meant to imply
-- "can compute an arbitrary author's balance on demand via RPC", and
-- extending it to do so is exactly the kind of privilege-creep this
-- migration does not introduce). This makes it structurally impossible
-- for any authenticated client -- author, reader, or staff -- to use
-- this function as an arbitrary-author data-extraction endpoint; it is
-- reachable ONLY from other SECURITY DEFINER functions owned by the
-- same role (get_author_financial_summary below, and the payout RPCs
-- in Parts 5-10), whose own grants are the real, narrower authorization
-- boundary in each case.
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
    coalesce(-sum(amount_minor) filter (where entry_type = 'payout'), 0)::bigint as paid_out_minor,
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

-- Redefine get_author_financial_summary() as a thin, auth.uid()-scoped
-- wrapper around the canonical helper above. EXTERNAL CONTRACT
-- UNCHANGED from migration 050: identical return shape (same 9
-- columns, same names, same types, same order), identical semantics
-- (own rows only, one row per currency, zero rows for an author/reader
-- with no ledger activity), identical grants (authenticated only, never
-- anon/public). The ONLY change is that the accounting formula now
-- lives in exactly one place.
create or replace function public.get_author_financial_summary()
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
  select * from public.author_ledger_balance(auth.uid());
$$;

revoke all on function public.get_author_financial_summary() from public, anon, authenticated;
grant execute on function public.get_author_financial_summary() to authenticated;

-- ============================================================
-- Part 5: reserve_author_payout() -- the one entry point that ever
-- creates a payout reservation.
--
-- Caller supplies ONLY author_id + currency (+ optional payout_run_id
-- for a future scheduler's own grouping) -- NEVER an amount (Section 11
-- of the task: "Caller must NOT supply payout amount"). The database
-- computes it, deterministically, from the canonical balance (Part 4)
-- minus every currently-active reservation for this exact
-- author+currency, compared against that exact currency's own
-- threshold row (Section 7's V1 rule: no settings row for this exact
-- currency means NOT eligible, full stop -- never a guessed default).
--
-- On success: reserves the FULL payoutable balance (Section 11's own
-- worked example -- threshold 50, payoutable 73, reserves 73, not 50),
-- inserts one 'pending' author_payouts row, returns exactly one row
-- (payout_id, amount_minor, currency).
--
-- On "not eligible" (no ledger balance in this currency at all; no
-- settings row for this exact currency; payoutable below threshold):
-- returns ZERO rows -- a deterministic, ordinary, expected outcome, NOT
-- an exception. A batch scheduler processing many authors will see this
-- constantly and should never need to catch an error for it.
--
-- On a genuine concurrent race (Part 3c's unique index rejects a second
-- simultaneous reservation attempt for the same author+currency): the
-- resulting unique_violation is caught and folded into the SAME "zero
-- rows returned" outcome -- from the caller's point of view, "another
-- process already reserved this author+currency" and "this author
-- isn't eligible right now" are both simply "nothing to do here,"
-- which is exactly the right uniform shape for a batch caller.
-- ============================================================

create or replace function public.reserve_author_payout(
  p_author_id uuid,
  p_currency text,
  p_payout_run_id uuid default null
)
returns table (
  payout_id uuid,
  amount_minor bigint,
  currency text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_available bigint;
  v_threshold bigint;
  v_reserved bigint;
  v_payoutable bigint;
  v_payout_id uuid;
begin
  select balance.available_minor into v_available
  from public.author_ledger_balance(p_author_id) balance
  where balance.currency = p_currency;

  if v_available is null then
    -- No ledger activity at all for this author in this currency --
    -- an entirely ordinary case, not an error.
    return;
  end if;

  select aps.threshold_minor into v_threshold
  from public.author_payout_settings aps
  where aps.author_id = p_author_id and aps.currency = p_currency;

  if v_threshold is null then
    -- No settings row for this exact author+currency: not eligible
    -- (Section 7's approved V1 rule). Never invent a default.
    return;
  end if;

  select coalesce(sum(ap.amount_minor), 0) into v_reserved
  from public.author_payouts ap
  where ap.author_id = p_author_id
    and ap.currency = p_currency
    and ap.status in ('pending', 'processing', 'reconciling');

  v_payoutable := v_available - v_reserved;

  if v_payoutable < v_threshold then
    return;
  end if;

  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status, payout_run_id)
    values (p_author_id, v_payoutable, p_currency, 'pending', p_payout_run_id)
    returning id into v_payout_id;
  exception
    when unique_violation then
      -- LEDGER-1E-B.1 Section 10: do NOT swallow every possible
      -- unique_violation as "expected concurrency race" -- only the
      -- ONE constraint this INSERT can legitimately collide with under
      -- normal operation, the active-reservation index, is treated that
      -- way. GET STACKED DIAGNOSTICS reads the actual constraint name
      -- Postgres attributes the violation to (verified directly against
      -- a real concurrent-reservation collision: it returns exactly
      -- 'author_payouts_one_active_per_author_currency_idx'). Any OTHER
      -- uniqueness violation here -- e.g. a future schema defect, or an
      -- unexpected provider_reference collision this code path was
      -- never meant to hit -- is RE-RAISED, never silently reinterpreted
      -- as "this author just isn't eligible." Hiding a genuine defect
      -- behind the same deterministic "zero rows" shape a normal losing
      -- race produces would make that defect invisible to every caller.
      declare
        v_constraint_name text;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'author_payouts_one_active_per_author_currency_idx' then
          -- A concurrent call already holds the active reservation slot
          -- for this exact author+currency. Nothing to do -- the same
          -- deterministic "zero rows" outcome as any other
          -- not-eligible-right-now case.
          return;
        else
          raise;
        end if;
      end;
  end;

  payout_id := v_payout_id;
  amount_minor := v_payoutable;
  currency := p_currency;
  return next;
end;
$$;

revoke all on function public.reserve_author_payout(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reserve_author_payout(uuid, text, uuid) to service_role;

-- ============================================================
-- Part 6: start_author_payout() -- pending -> processing, WITH
-- REVALIDATION (Section 18 of the task).
--
-- This is the last DB-side checkpoint before a future provider call
-- would ever be made, and the moment amount/currency/author become
-- immutable (Part 3e's trigger takes effect the instant status leaves
-- 'pending'). Before transitioning, it recomputes the canonical balance
-- FRESH and confirms the reservation is still economically supportable
-- -- a refund or other debit may have posted since reserve_author_payout()
-- computed this amount.
--
-- If the reservation no longer fits: DO NOT resize it (Section 18's own
-- explicit instruction) -- cancel it outright (pending -> cancelled,
-- itself a legal transition) and return that as the deterministic
-- result. A future run's reserve_author_payout() call will compute a
-- fresh, correctly-sized reservation from the now-current balance. This
-- keeps "the reserved amount is always exactly what was true either at
-- reservation time or is now being explicitly re-decided" true, rather
-- than ever silently mutating a number this whole design otherwise
-- treats as sacred.
--
-- SELECT ... FOR UPDATE locks the specific payout row for the duration
-- of this check-then-transition, so a concurrent cancel_author_payout()
-- or a second start_author_payout() retry on the SAME row cannot race
-- with this one.
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
    -- Table alias required: this function's own OUT parameter is also
    -- named "status" (RETURNS TABLE(payout_id uuid, status text)
    -- above), which otherwise makes a bare "status" reference in the
    -- WHERE clause ambiguous between the PL/pgSQL variable and the
    -- table column -- the same class of bug already fixed once this
    -- session in record_payment_event()'s ON CONFLICT target list.
    update public.author_payouts ap
    set status = 'cancelled'
    where ap.id = p_payout_id and ap.status = 'pending';

    payout_id := p_payout_id;
    status := 'cancelled';
    return next;
    return;
  end if;

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
-- Part 7: mark_author_payout_reconciling() -- processing -> reconciling
-- only. No ledger movement whatsoever. Idempotent if already
-- reconciling (a retried "I don't know what happened" signal is a
-- safe no-op, not an error). See Part 3a's comment for why this state
-- exists at all: it exists precisely so a genuinely ambiguous provider
-- outcome is never conflated with either a confirmed success or a
-- confirmed failure.
-- ============================================================

create or replace function public.mark_author_payout_reconciling(p_payout_id uuid)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select ap.status into v_status
  from public.author_payouts ap
  where ap.id = p_payout_id
  for update;

  if not found then
    raise exception 'mark_author_payout_reconciling: payout % not found', p_payout_id;
  end if;

  if v_status = 'reconciling' then
    payout_id := p_payout_id;
    status := 'reconciling';
    return next;
    return;
  end if;

  if v_status <> 'processing' then
    raise exception
      'mark_author_payout_reconciling: payout % is not processing (current status %)',
      p_payout_id, v_status;
  end if;

  update public.author_payouts ap
  set status = 'reconciling'
  where ap.id = p_payout_id and ap.status = 'processing';

  payout_id := p_payout_id;
  status := 'reconciling';
  return next;
end;
$$;

revoke all on function public.mark_author_payout_reconciling(uuid) from public, anon, authenticated;
grant execute on function public.mark_author_payout_reconciling(uuid) to service_role;

-- ============================================================
-- Part 8: finalize_author_payout() -- processing/reconciling -> paid.
-- The ONE place a payout ledger debit is ever created.
--
-- Creates exactly one author_ledger_entries row (entry_type='payout',
-- amount_minor = -author_payouts.amount_minor, payout_id set) --
-- already backed by an EXISTING migration-048 invariant confirmed still
-- live: author_ledger_entries_one_entry_per_payout_idx, a partial
-- unique index on (payout_id) WHERE entry_type='payout'. A second
-- ledger debit for the same payout is structurally impossible even
-- before considering this function's own idempotency handling.
--
-- IDEMPOTENT RETRY (Section 24): called again for an already-'paid' row
-- with the SAME provider+provider_reference is a safe no-op, returning
-- the existing ledger entry id -- tolerates a webhook/API retry.
-- Called again with a DIFFERENT provider+provider_reference on an
-- already-'paid' row is treated as a financial anomaly and REJECTED
-- (raises) rather than silently overwritten -- that shape would mean
-- either a duplicate external send or data corruption, and either way
-- needs a human, not an automatic acceptance.
--
-- provider/provider_reference are both required (NOT NULL enforced in
-- the function body) -- a "success" with no way to correlate it back to
-- an external transfer is not a state this design accepts.
--
-- PAYOUT REVERSAL -- explicitly NOT built here (Section 29 of the
-- task). Confirmed: migration 048's author_ledger_entries.entry_type
-- CHECK still only permits ('sale', 'refund', 'adjustment', 'payout').
-- Before any real payout provider is ever enabled, a future migration
-- MUST add a payout_reversal entry_type (a positive compensating entry,
-- mirroring exactly how 'refund' was added alongside 'sale' in 048/049)
-- so a provider-returned/reversed transfer can be represented WITHOUT
-- ever mutating the original payout debit. This is a hard
-- pre-real-money requirement, flagged here, not implemented.
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
begin
  -- LEDGER-1E-B.1 Section 7: reject blank/whitespace-only inputs, not
  -- merely NULL -- a payout must never become paid without a MEANINGFUL
  -- external correlation, and an empty string or '   ' is exactly as
  -- useless for that purpose as NULL. Checked before any state or
  -- ledger mutation whatsoever.
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
-- Part 9: fail_author_payout() -- processing/reconciling -> failed,
-- for a CONFIRMED provider failure only (never for an ambiguous/
-- timeout outcome -- that goes to mark_author_payout_reconciling()
-- instead, Part 7). No ledger debit is ever created. The reservation
-- releases automatically: 'failed' no longer matches
-- author_payouts_one_active_per_author_currency_idx's predicate
-- (Part 3c), so the amount becomes payoutable again the instant this
-- commits, with zero additional code needed. This function never
-- creates a new payout row itself -- a future run's own
-- reserve_author_payout() call is what may reserve again.
-- ============================================================

create or replace function public.fail_author_payout(
  p_payout_id uuid,
  p_failure_code text
)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select ap.status into v_status
  from public.author_payouts ap
  where ap.id = p_payout_id
  for update;

  if not found then
    raise exception 'fail_author_payout: payout % not found', p_payout_id;
  end if;

  if v_status not in ('processing', 'reconciling') then
    raise exception
      'fail_author_payout: payout % is not processing/reconciling (current status %)',
      p_payout_id, v_status;
  end if;

  update public.author_payouts
  set status = 'failed', failed_at = now(), failure_code = p_failure_code
  where id = p_payout_id;

  payout_id := p_payout_id;
  status := 'failed';
  return next;
end;
$$;

revoke all on function public.fail_author_payout(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_author_payout(uuid, text) to service_role;

-- ============================================================
-- Part 10: cancel_author_payout() -- pending -> cancelled ONLY. Once
-- start_author_payout() has moved a row to 'processing', cancellation
-- through this function is refused -- a provider call may already be
-- in flight and there is no reliable way to un-send it (Section 26's
-- own V1 boundary). No ledger debit. Reservation releases the same way
-- fail_author_payout()'s does: 'cancelled' falls outside the active-
-- payout index's predicate automatically.
-- ============================================================

create or replace function public.cancel_author_payout(p_payout_id uuid)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select ap.status into v_status
  from public.author_payouts ap
  where ap.id = p_payout_id
  for update;

  if not found then
    raise exception 'cancel_author_payout: payout % not found', p_payout_id;
  end if;

  if v_status <> 'pending' then
    raise exception
      'cancel_author_payout: payout % is not pending (current status %)',
      p_payout_id, v_status;
  end if;

  update public.author_payouts ap
  set status = 'cancelled'
  where ap.id = p_payout_id and ap.status = 'pending';

  payout_id := p_payout_id;
  status := 'cancelled';
  return next;
end;
$$;

revoke all on function public.cancel_author_payout(uuid) from public, anon, authenticated;
grant execute on function public.cancel_author_payout(uuid) to service_role;

-- ============================================================
-- Part 11: production rollout compatibility. Every object this
-- migration adds is new (payout_runs; author_ledger_balance;
-- reserve/start/mark_reconciling/finalize/fail/cancel_author_payout) or
-- purely additive to an existing table with zero production rows
-- (author_payout_settings' PK; author_payouts' status vocabulary,
-- payout_run_id, the two new indexes, the immutability trigger).
-- get_author_financial_summary()'s external contract is byte-identical
-- to migration 050's -- same columns, same semantics, same grants --
-- only its internal implementation now delegates to
-- author_ledger_balance(). Migrations 048, 049, and 050 remain
-- byte-unchanged. No Stripe code path, buyer-payment flow, or
-- refund-provider-execution path is touched, called, or affected by
-- anything in this migration. No scheduler, no provider adapter, no
-- manual-payout capability, and no real money movement exist anywhere
-- in this file.
-- ============================================================
