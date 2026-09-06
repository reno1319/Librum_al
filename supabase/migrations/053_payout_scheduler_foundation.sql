-- LIBRUM 2.0 LEDGER-1E-D-B: payout scheduler DATABASE FOUNDATION --
-- canonical eligibility, pure dry run, idempotent scheduled-run
-- create/resume/complete. Built on migrations 048-052, all already LIVE
-- in production and NOT modified by this file in any way except one
-- narrow, behavior-preserving internal refactor of
-- reserve_author_payout() (Part 2 below). No table is added. No new
-- column is added. No scheduler HTTP route, no vercel.json change, no
-- CRON_SECRET, no feature switch, no provider, and no real payout
-- execution exist anywhere in this file.
--
-- ============================================================
-- SCOPE:
--   Part 1: author_payout_eligibility(author_id, currency) -- THE ONE
--           canonical eligibility/payoutable-amount calculation,
--           extracted verbatim (formula-identical) out of
--           reserve_author_payout()'s own previously-inline logic.
--           service_role-only.
--   Part 2: reserve_author_payout() -- refactored to CALL the new
--           helper instead of recomputing the formula inline. External
--           signature, external semantics, concurrency semantics, and
--           the constraint-specific unique_violation handling are all
--           UNCHANGED. This is the one existing, production-live,
--           money-state function this migration touches.
--   Part 3: dry_run_scheduled_payouts() -- a pure, STABLE, read-only
--           bulk preview over every author_payout_settings candidate,
--           calling the SAME Part 1 helper per candidate. Cannot
--           mutate anything -- there is no INSERT/UPDATE/DELETE
--           anywhere in its body.
--   Part 4: start_scheduled_payout_run(p_target_month date) --
--           idempotent create-or-fetch of exactly one payout_runs row
--           per calendar month, deriving its own run_key internally.
--           The ONLY legal INSERT path onto payout_runs.
--   Part 5: complete_scheduled_payout_run(p_run_id uuid) -- the ONLY
--           legal UPDATE path onto payout_runs, running -> completed,
--           idempotent on retry.
--
-- EXPLICITLY NOT IN THIS MIGRATION (LEDGER-1E-D-B's own scope):
--   no scheduler HTTP route (/api/internal/payouts/run is
--   LEDGER-1E-D-D, after this migration is separately applied to
--   production); no vercel.json cron entry; no CRON_SECRET code; no
--   PAYOUT_SCHEDULER_ENABLED/PAYOUT_EXECUTION_ENABLED (those belong
--   with the application route that consumes them); no payout provider
--   of any kind; no fail_scheduled_payout_run() (restart semantics for
--   a genuinely failed run are not yet designed -- a run that isn't
--   explicitly completed simply stays 'running' and is safely resumable
--   by a future retry, per this migration's own Part 4/5 comments); no
--   admin_audit_log writes (deferred until machine-actor metadata
--   semantics are explicitly chosen -- LEDGER-1E-D-A Section AA); no
--   payout_run_items / candidate-snapshot table (deliberately rejected,
--   see Part 4's own comment); no payout_reversal entry_type (remains
--   the hard pre-real-money blocker, untouched, unnecessary here since
--   no external payout ever succeeds in this phase).
-- ============================================================

-- ============================================================
-- Part 1: author_payout_eligibility() -- THE canonical payout
-- eligibility + payoutable-amount calculation.
--
-- Extracted byte-for-byte in formula (not merely "equivalent") from
-- reserve_author_payout()'s own previously-inline logic (migration
-- 051): same v_available/v_threshold/v_reserved/v_payoutable
-- computation, same author_ledger_balance()/author_payout_settings/
-- author_payouts reads. This becomes the SOLE implementation of payout
-- eligibility, called by both reserve_author_payout() (Part 2) and
-- dry_run_scheduled_payouts() (Part 3) -- and by any future scheduler
-- orchestration -- so dry-run and real reservation can never drift
-- into two different formulas (LEDGER-1E-D-A Section E's own
-- conclusion). Mirrors author_ledger_balance()'s own extraction
-- precedent from migration 051 exactly.
--
-- ACTIVE RESERVATION IS AN ABSOLUTE, EXPLICIT BLOCKER (Section 5 of the
-- task -- a deliberate REFINEMENT over the original inline logic, not a
-- behavior change to reserve_author_payout()'s own external outcome --
-- see Part 2's own comment for the full parity argument). The original
-- inline code never checked "does an active reservation already exist"
-- as its own named condition -- it discovered that fact LATE, only when
-- its own INSERT collided with the active-reservation unique index.
-- That is invisible/unusable for a pure, non-mutating dry-run caller,
-- which has no INSERT to fail. This helper therefore checks active-
-- reservation existence explicitly and EARLY, via a direct EXISTS
-- query -- deliberately not merely inferred from "reserved_minor > 0"
-- (which happens to be equivalent today given author_payouts'
-- amount_minor > 0 CHECK and the at-most-one-active-row invariant, but
-- an explicit EXISTS is more robust and doesn't lean on reasoning about
-- an unrelated constraint holding elsewhere).
--
-- THIS EXPLICIT CHECK IS NOT THE SAFETY MECHANISM. It is a read-only,
-- unlocked SELECT -- purely an eligibility/reporting classification and
-- (inside reserve_author_payout()) an early-exit optimization. The
-- REAL money-safety mechanism, unchanged, remains exactly what it has
-- always been since migration 051: the
-- author_payouts_one_active_per_author_currency_idx partial unique
-- index enforced by Postgres itself at INSERT time. Two genuinely
-- concurrent callers racing for the same author+currency, neither of
-- whom has committed yet, both still see active_reservation = false
-- from this helper (READ COMMITTED never sees the other's uncommitted
-- work) -- the constraint, not this check, is what decides the winner.
-- No advisory lock is introduced or needed (LEDGER-1E-D-A Section X's
-- own conclusion, matching migration 051's own reasoning for why no
-- advisory lock was needed there either).
--
-- OUTPUT (Section 4): author_id, currency, ledger_available_minor
-- (NULL when no ledger activity exists at all for this currency --
-- distinct from a real zero balance), reserved_minor (sum of active
-- reservation amounts, always 0 or one row's amount given the unique
-- index), payoutable_minor (NULL when ledger_available_minor is NULL;
-- otherwise ledger_available_minor - reserved_minor, NEVER clamped --
-- Section 6's own explicit "do not clamp" instruction, preserving
-- LEDGER-1D's negative-balance-stays-visible discipline),
-- threshold_configured/threshold_minor (NULL/false exactly when no
-- settings row exists for this exact author+currency -- never a
-- fabricated default, unchanged from migration 051's own V1 rule),
-- active_reservation (the explicit boolean above), eligible (the one
-- authoritative boolean both callers rely on), ineligible_reason (NULL
-- when eligible; otherwise exactly one of 'no_settings',
-- 'no_available_balance', 'active_reservation', 'below_threshold' --
-- a small, controlled vocabulary, chosen and checked in that priority
-- order so a caller with MULTIPLE simultaneously-true ineligibility
-- conditions still gets exactly one deterministic, most-fundamental
-- reason rather than an arbitrary one). No provider/payment/internal
-- correlation identifier appears anywhere in this output -- it exposes
-- nothing beyond what reserve_author_payout() itself already
-- implicitly depended on.
--
-- SECURITY: SECURITY DEFINER (reads author_ledger_balance()/
-- author_payout_settings/author_payouts directly, bypassing RLS as the
-- function owner -- the p_author_id/p_currency filters in the query
-- text ARE the access control, exactly like every other SECURITY
-- DEFINER function in this schema). EXECUTE granted ONLY to
-- service_role -- not PUBLIC, not anon, not authenticated, not even
-- finance.view staff (finance.view remains read-only via its own
-- existing RLS policies; it was never meant to imply "can compute an
-- arbitrary author's payout eligibility on demand," matching the exact
-- same reasoning already applied to author_ledger_balance() itself in
-- migration 051). Safe to call for a currency with no settings row at
-- all (Section 7's own explicit requirement) -- it simply reports
-- threshold_configured = false / eligible = false /
-- ineligible_reason = 'no_settings', never an exception.
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
  v_reserved bigint;
  v_payoutable bigint;
  v_active_reservation boolean;
begin
  select balance.available_minor into v_available
  from public.author_ledger_balance(p_author_id) balance
  where balance.currency = p_currency;

  select aps.threshold_minor into v_threshold
  from public.author_payout_settings aps
  where aps.author_id = p_author_id and aps.currency = p_currency;

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

  -- Priority order matters only for which single reason is reported
  -- when multiple ineligibility conditions hold simultaneously -- the
  -- resulting `eligible` boolean is identical regardless of this
  -- order, since every branch below requires ALL FOUR conditions to
  -- pass before reaching 'eligible'.
  if v_threshold is null then
    eligible := false;
    ineligible_reason := 'no_settings';
  elsif v_available is null then
    eligible := false;
    ineligible_reason := 'no_available_balance';
  elsif v_active_reservation then
    eligible := false;
    ineligible_reason := 'active_reservation';
  elsif v_payoutable < v_threshold then
    eligible := false;
    ineligible_reason := 'below_threshold';
  else
    eligible := true;
    ineligible_reason := null;
  end if;

  return next;
end;
$$;

revoke all on function public.author_payout_eligibility(uuid, text) from public, anon, authenticated;
grant execute on function public.author_payout_eligibility(uuid, text) to service_role;

-- ============================================================
-- Part 2: reserve_author_payout() -- refactored to CALL Part 1's
-- helper instead of recomputing the formula inline.
--
-- PARITY ARGUMENT (this is the one production-live money-state
-- function this migration touches, so the exact reasoning is recorded
-- here in full, not merely asserted):
--
--   1. No-ledger-activity case: old code returned zero rows the moment
--      v_available was NULL. New code: the helper reports
--      ineligible_reason='no_available_balance' (or 'no_settings' if
--      that check fires first -- see Part 1's own priority-order
--      comment; either way eligible=false), so reserve_author_payout()
--      still returns zero rows without ever attempting an INSERT.
--      Identical external outcome.
--   2. No-settings case: old code returned zero rows the moment
--      v_threshold was NULL. New code: eligible=false via
--      ineligible_reason='no_settings'. Identical external outcome.
--   3. Below-threshold case (including a payoutable amount that is
--      zero or negative, e.g. after an intervening ledger debit): old
--      code returned zero rows when v_payoutable < v_threshold. New
--      code: eligible=false via ineligible_reason='below_threshold'
--      (threshold_minor is always > 0 by CHECK, so a non-positive
--      payoutable amount is always "below" it). Identical external
--      outcome.
--   4. Already has a committed active reservation, but recomputed
--      arithmetic payoutable would still exceed threshold (e.g. new
--      ledger activity posted after the existing reservation was
--      made): old code proceeded to attempt the INSERT, which then hit
--      the active-reservation unique index and was caught by the
--      existing exception handler, returning zero rows. New code:
--      the helper's explicit active_reservation check now fires
--      BEFORE the INSERT is ever attempted, short-circuiting to zero
--      rows directly. The external result (zero rows, no payout_id) is
--      IDENTICAL in both versions -- the only change is that the new
--      version skips a guaranteed-to-fail INSERT + exception-catch
--      round trip, a pure efficiency/robustness improvement invisible
--      to any caller.
--   5. Genuine concurrent race (two callers, neither yet committed):
--      completely unaffected by this refactor -- see Part 1's own
--      comment on why the explicit active_reservation pre-check cannot
--      and does not interfere with this case (READ COMMITTED visibility
--      is unchanged). Both callers still see eligible=true from the
--      helper, both still attempt the INSERT, and the SAME unique
--      index + the SAME GET STACKED DIAGNOSTICS constraint-name check
--      below -- copied verbatim, not rewritten -- still decides exactly
--      one winner. Re-proven empirically against two real, separate
--      Postgres connections by this migration's own re-run of
--      051_payout_reservation_contention.sh (non-optional, per the
--      task's own Section 49).
--   6. Success case: old code inserted v_payoutable as amount_minor.
--      New code inserts v_eligibility.payoutable_minor -- the exact
--      same value, now computed once inside the shared helper instead
--      of twice (inline here and separately, if it ever existed
--      elsewhere).
--
-- Multi-currency, negative-balance, and pending-settlement-exclusion
-- behavior all flow from author_ledger_balance()/the same formula,
-- already unchanged by this refactor since Part 1 copies that formula
-- verbatim rather than altering it.
--
-- Every other line of this function -- signature, RETURNS TABLE shape,
-- grants, the exception handler's exact constraint-name comparison and
-- RE-RAISE-if-different-constraint behavior -- is preserved verbatim.
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
  v_eligibility record;
  v_payout_id uuid;
begin
  select * into v_eligibility
  from public.author_payout_eligibility(p_author_id, p_currency);

  if not v_eligibility.eligible then
    -- Not eligible right now, for any of the reasons Part 1's helper
    -- distinguishes internally -- from this function's own external
    -- point of view this remains the same single, deterministic
    -- "zero rows" outcome it has always produced, exactly as
    -- migration 051 originally documented.
    return;
  end if;

  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status, payout_run_id)
    values (p_author_id, v_eligibility.payoutable_minor, p_currency, 'pending', p_payout_run_id)
    returning id into v_payout_id;
  exception
    when unique_violation then
      -- LEDGER-1E-B.1 Section 10 (unchanged verbatim): do NOT swallow
      -- every possible unique_violation as "expected concurrency
      -- race" -- only the ONE constraint this INSERT can legitimately
      -- collide with under normal operation, the active-reservation
      -- index, is treated that way. GET STACKED DIAGNOSTICS reads the
      -- actual constraint name Postgres attributes the violation to.
      -- Any OTHER uniqueness violation here is RE-RAISED, never
      -- silently reinterpreted as "this author just isn't eligible."
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
  amount_minor := v_eligibility.payoutable_minor;
  currency := p_currency;
  return next;
end;
$$;

revoke all on function public.reserve_author_payout(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reserve_author_payout(uuid, text, uuid) to service_role;

-- ============================================================
-- Part 3: dry_run_scheduled_payouts() -- pure, non-mutating, bulk
-- eligibility preview over every current author_payout_settings
-- candidate.
--
-- CANDIDATE UNIVERSE (Section 7): author_payout_settings is the
-- canonical candidate universe for BULK scheduled evaluation -- one
-- row is one (author_id, currency) candidate; no settings row means
-- that author+currency is simply never scanned here (though Part 1's
-- helper remains safe to call directly for such a pair, reporting
-- ineligible_reason='no_settings', per its own comment).
--
-- INTRINSICALLY NON-MUTATING (Section 8): `language sql`, `stable`,
-- and its entire body is exactly one read-only SELECT joining
-- author_payout_settings against Part 1's own STABLE helper -- there is
-- no INSERT/UPDATE/DELETE token anywhere in this function's text, and
-- it never calls reserve_author_payout() or any other mutating RPC.
-- This is not "dry run implemented as call-then-rollback" (explicitly
-- rejected by the task) -- it is structurally incapable of writing
-- anything, the same way author_ledger_balance()/
-- get_author_financial_summary() are structurally incapable of it.
--
-- DRY RUN IS ADVISORY ONLY (Section 9): this function reports a
-- point-in-time preview. A later refund, ledger adjustment, competing
-- payout reservation, or threshold change can change what
-- reserve_author_payout() actually does for the same author+currency
-- by the time it is next called. Dry run is never a financial promise
-- -- any future caller-facing surface built on top of this function
-- must carry that same caveat forward in its own copy.
--
-- Does NOT create, require, or accept a payout_run_id (Section 32) --
-- a dry run has nothing to attach one to, since it mutates nothing. It
-- also does not compute or return a suggested run_key/target month:
-- doing so here would duplicate Part 4's own run-key derivation logic
-- for no operational benefit (this function's per-row output already
-- carries no run identity to begin with) -- deferred to whatever
-- future caller wants to pair a dry-run preview with a specific target
-- month, not owned by this function.
--
-- SECURITY: identical posture to Part 1 -- SECURITY DEFINER,
-- search_path='', service_role-only EXECUTE, never PUBLIC/anon/
-- authenticated, never finance.view merely by permission.
-- ============================================================

create or replace function public.dry_run_scheduled_payouts()
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
language sql
security definer
set search_path = ''
stable
as $$
  select e.*
  from public.author_payout_settings aps
  cross join lateral public.author_payout_eligibility(aps.author_id, aps.currency) e;
$$;

revoke all on function public.dry_run_scheduled_payouts() from public, anon, authenticated;
grant execute on function public.dry_run_scheduled_payouts() to service_role;

-- ============================================================
-- Part 4: start_scheduled_payout_run() -- idempotent create-or-fetch of
-- exactly one payout_runs row per calendar month. The ONLY legal
-- INSERT path onto payout_runs (migration 051's service_role
-- SELECT-only boundary on this table is left completely untouched --
-- see this Part's own closing comment).
--
-- TARGET MONTH, NOT now() (Section 13): identity is derived from an
-- explicit p_target_month date parameter, never from the invocation's
-- own current time. This deliberately supports a retroactive/missed
-- run: an operator or future scheduler can call this with
-- p_target_month = '2026-10-01' in November (or later) and still
-- correctly create/resume the OCTOBER run, never a November one.
--
-- VALIDATION (Section 14): p_target_month MUST be the first day of a
-- month -- rejected (raise exception), never silently normalized/
-- truncated. Silently accepting '2026-10-17' as "meaning October"
-- would let a caller's typo or off-by-a-few-days mistake produce a
-- run identity the caller never actually intended; making this
-- explicit forces scheduler/operator intent to be unambiguous at the
-- call site, which is a stronger, cheaper safety property than a more
-- forgiving normalization would provide.
--
-- FUTURE-MONTH REJECTION (Section 31): p_target_month may not be later
-- than the current Europe/Tirane calendar month. There is no
-- legitimate reason to create December's payout run in October; this
-- closes an easy operator-mistake vector at essentially zero cost.
-- Computed via `(now() at time zone 'Europe/Tirane')` truncated to the
-- month, then compared as a plain date -- timezone-safe for the same
-- reason LEDGER-1E-D-A's own run-key design is DST-safe: only the
-- resulting calendar DATE is ever compared, never a specific instant,
-- so a DST transition can never make this comparison ambiguous.
--
-- RUN KEY DERIVED INTERNALLY, NEVER CALLER-SUPPLIED (Section 16): the
-- caller passes a DATE, never a run_key string. run_key is always
-- computed here as 'monthly:' || to_char(p_target_month, 'YYYY-MM')
-- (e.g. 'monthly:2026-10') -- structurally impossible for a caller to
-- inject an arbitrary/malformed/collidable key.
--
-- IDEMPOTENCY / CONCURRENCY-SAFE (Section 17/19): a plain
-- `insert ... on conflict (run_type, run_key) where run_key is not
-- null do nothing`, followed by an unconditional re-select of whatever
-- row now exists for that (run_type, run_key) -- exactly the same
-- "attempt insert, then always read back the canonical row" pattern
-- already proven safe for author_payouts' own active-reservation race
-- (though here the unique index itself resolves the race without ever
-- needing an exception handler, since ON CONFLICT DO NOTHING cannot
-- raise). The losing concurrent caller never sees an error and never
-- creates a second row -- it simply reads back the winner's row,
-- indistinguishable from having created it itself except via the
-- returned is_new flag.
--
-- THIS FUNCTION NEVER UPDATES AN EXISTING ROW (Section 19/20): once a
-- payout_runs row exists for a given (run_type, run_key), calling this
-- function again for the same target month ALWAYS returns that exact
-- row completely unmodified, regardless of its current status --
-- 'running' is returned as-is (enabling retry/resume, Section 19),
-- 'completed' is returned as-is (a completed run is CLOSED, Section 20
-- -- it is never reopened merely because a new candidate becomes
-- eligible after completion; that new candidate waits for the next
-- monthly run_key). This single "never mutate an existing row" rule is
-- what makes both of those Section requirements true simultaneously
-- with no special-casing by status anywhere in this function's body --
-- with exactly one exception, immediately below.
--
-- EXISTING 'failed' ROW IS REJECTED, NOT RETURNED (hardening pass):
-- unlike 'running'/'completed', an existing row whose status is
-- 'failed' is never silently returned as-is. This function has no way
-- to create a 'failed' row itself (nothing in this migration ever
-- writes that status -- see Part 5's own comment), so a 'failed' row
-- can only exist here from some future out-of-band recovery process
-- not yet designed. Silently resuming/reopening it by returning
-- is_new=false, as the ordinary "never mutate" rule would otherwise
-- do, would let a scheduler quietly treat a known-bad run as normal
-- and continue reserving payouts against it. Instead this function
-- RAISES a deterministic exception and leaves the existing row
-- completely untouched -- no mutation, no new row, no silent
-- resume -- forcing any recovery to be an explicit, deliberate,
-- separate operation.
--
-- NO CANDIDATE SNAPSHOT (Section 21, restated here at the point where
-- it matters operationally): because this function performs no
-- candidate enumeration at all, and because dry_run_scheduled_payouts()/
-- a future scheduler loop always re-reads CURRENT
-- author_payout_settings rows, a retry against a still-'running' run
-- naturally picks up any settings row added since the run started --
-- deliberately, not accidentally. A settings row added AFTER this
-- month's run reaches 'completed' waits for next month's run_key, by
-- the "closed" rule above. No payout_run_items table exists or is
-- needed to make this true.
-- ============================================================

create or replace function public.start_scheduled_payout_run(
  p_target_month date
)
returns table (
  payout_run_id uuid,
  payout_run_key text,
  payout_run_scheduled_for date,
  payout_run_status text,
  payout_run_started_at timestamptz,
  payout_run_completed_at timestamptz,
  is_new boolean
)
language plpgsql
security definer
set search_path = ''
as $$
-- This function's OUT parameters are deliberately prefixed
-- (payout_run_id/payout_run_key/payout_run_scheduled_for/
-- payout_run_status/payout_run_started_at/payout_run_completed_at)
-- so none of them collides with payout_runs' own column names
-- (id/run_key/scheduled_for/status/started_at/completed_at). This
-- makes every bare column reference in this function's body --
-- including the INSERT ... ON CONFLICT target list below, whose
-- column list Postgres syntax REQUIRES to be bare/unqualified (there
-- is no table-alias syntax available inside a conflict target list at
-- all, unlike an ordinary WHERE clause) -- unambiguous by
-- construction, with no PL/pgSQL variable-resolution directive
-- (`#variable_conflict`) required anywhere.
declare
  v_run_key text;
  v_current_month_start date;
  v_inserted_id uuid;
  v_existing public.payout_runs%rowtype;
begin
  if p_target_month is null then
    raise exception 'start_scheduled_payout_run: p_target_month is required';
  end if;

  if p_target_month <> date_trunc('month', p_target_month)::date then
    raise exception
      'start_scheduled_payout_run: p_target_month must be the first day of a month, got %',
      p_target_month;
  end if;

  v_current_month_start := date_trunc('month', (now() at time zone 'Europe/Tirane'))::date;
  if p_target_month > v_current_month_start then
    raise exception
      'start_scheduled_payout_run: p_target_month % is in the future (current Europe/Tirane month is %)',
      p_target_month, v_current_month_start;
  end if;

  v_run_key := 'monthly:' || to_char(p_target_month, 'YYYY-MM');

  insert into public.payout_runs (run_type, run_key, scheduled_for, status, started_at)
  values ('scheduled', v_run_key, p_target_month, 'running', now())
  on conflict (run_type, run_key) where run_key is not null do nothing
  returning payout_runs.id into v_inserted_id;

  select pr.* into v_existing
  from public.payout_runs pr
  where pr.run_type = 'scheduled' and pr.run_key = v_run_key;

  if v_existing.status = 'failed' then
    raise exception
      'start_scheduled_payout_run: scheduled payout run % (target month %) is failed and requires explicit recovery',
      v_run_key, p_target_month;
  end if;

  payout_run_id := v_existing.id;
  payout_run_key := v_existing.run_key;
  payout_run_scheduled_for := v_existing.scheduled_for;
  payout_run_status := v_existing.status;
  payout_run_started_at := v_existing.started_at;
  payout_run_completed_at := v_existing.completed_at;
  is_new := (v_inserted_id is not null);
  return next;
end;
$$;

revoke all on function public.start_scheduled_payout_run(date) from public, anon, authenticated;
grant execute on function public.start_scheduled_payout_run(date) to service_role;

-- ============================================================
-- Part 5: complete_scheduled_payout_run() -- the ONLY legal UPDATE
-- path onto payout_runs.
--
-- ALLOWED TRANSITION: running -> completed only. Idempotent: calling
-- again on an already-completed run returns it unmodified (same row,
-- same completed_at -- never reset). Any other current status (e.g.
-- 'pending', or a hypothetical future 'failed') is rejected with an
-- exception -- this migration does not implement a
-- fail_scheduled_payout_run() RPC at all (Section 25: restart
-- semantics for a genuinely failed run are not yet designed; a run
-- that a caller does not explicitly complete simply stays 'running'
-- and is safely resumable by calling start_scheduled_payout_run() with
-- the same target month again -- see Part 4's own "never updates an
-- existing row" comment). The 'failed' value remains legal in
-- payout_runs.status's own CHECK (migration 051) purely for potential
-- future use; nothing in this migration ever writes it.
--
-- COMPLETION SEMANTICS (Section 23, restated precisely because this is
-- the one place it becomes a concrete contract): 'completed' means a
-- full scheduler evaluation pass finished successfully without any
-- unexpected candidate-processing error -- it means every candidate as
-- of that pass was EVALUATED (and, where eligible, RESERVED) at least
-- once. It does NOT mean authors were paid, and it does NOT mean any
-- author_payouts row reached 'paid' -- those rows may remain 'pending'
-- indefinitely until a future provider-execution phase exists. A
-- future scheduler route must call this function ONLY after its own
-- candidate loop finished without an unexpected system/DB error
-- (Section 24) -- an individual candidate's ordinary "not eligible"
-- result, or a losing concurrency race caught by
-- reserve_author_payout()'s own existing exception handler, are NOT
-- errors and must NOT block completion; only a genuinely unexpected
-- failure partway through should leave the run 'running' for a future
-- retry to resume, rather than being marked complete over a pass that
-- never actually finished evaluating every candidate.
--
-- NO AUTO-DERIVATION (Section 27): no trigger or DB-side heuristic
-- attempts to guess whether an application loop finished evaluating
-- every candidate -- completion is exclusively caller-driven, exactly
-- once, after a successful full pass. This is acceptable specifically
-- because money safety never depends on payout_runs.status at all --
-- it depends entirely on the active-reservation uniqueness invariant
-- and reserve_author_payout()'s own constraint-aware idempotency,
-- both completely unrelated to whatever this table's own bookkeeping
-- status says.
--
-- NO SIDE EFFECTS: never touches author_payouts, never writes a
-- ledger entry, never calls any payout mutation RPC -- this function's
-- entire effect is exactly one UPDATE of payout_runs.status/
-- completed_at for one specific row.
-- ============================================================

create or replace function public.complete_scheduled_payout_run(
  p_run_id uuid
)
returns table (
  payout_run_id uuid,
  payout_run_key text,
  payout_run_status text,
  payout_run_completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
-- Same renaming rationale as start_scheduled_payout_run() above: this
-- function's OUT parameters are prefixed (payout_run_id/
-- payout_run_key/payout_run_status/payout_run_completed_at) so none
-- collides with payout_runs' own id/run_key/status/completed_at
-- columns, making every bare reference below -- including the
-- UPDATE's WHERE clause and RETURNING INTO target list -- unambiguous
-- by construction, with no `#variable_conflict` directive needed.
declare
  v_existing public.payout_runs%rowtype;
begin
  select pr.* into v_existing
  from public.payout_runs pr
  where pr.id = p_run_id
  for update;

  if not found then
    raise exception 'complete_scheduled_payout_run: run % not found', p_run_id;
  end if;

  if v_existing.status = 'completed' then
    payout_run_id := v_existing.id;
    payout_run_key := v_existing.run_key;
    payout_run_status := v_existing.status;
    payout_run_completed_at := v_existing.completed_at;
    return next;
    return;
  end if;

  if v_existing.status <> 'running' then
    raise exception
      'complete_scheduled_payout_run: run % is not running (current status %)',
      p_run_id, v_existing.status;
  end if;

  update public.payout_runs as pr
  set status = 'completed', completed_at = now()
  where pr.id = p_run_id
  returning pr.id, pr.run_key, pr.status, pr.completed_at
  into payout_run_id, payout_run_key, payout_run_status, payout_run_completed_at;

  return next;
end;
$$;

revoke all on function public.complete_scheduled_payout_run(uuid) from public, anon, authenticated;
grant execute on function public.complete_scheduled_payout_run(uuid) to service_role;

-- ============================================================
-- Part 6: production rollout compatibility. Every object this
-- migration adds is new (author_payout_eligibility,
-- dry_run_scheduled_payouts, start_scheduled_payout_run,
-- complete_scheduled_payout_run) except reserve_author_payout(),
-- whose EXTERNAL signature/semantics/concurrency behavior are proven
-- unchanged above and re-proven by this migration's own full test
-- suite plus a re-run of 051's own two-connection contention script.
-- Migrations 048, 049, 050, 051, and 052 remain byte-unchanged. No new
-- table, no new column. payout_runs' service_role grant boundary from
-- migration 051 (SELECT only, no direct INSERT/UPDATE/DELETE) is
-- completely untouched -- Part 4/5's two new SECURITY DEFINER
-- functions are the only legal mutation path onto that table, exactly
-- mirroring the same posture already established for author_payouts
-- itself. author_payout_settings, author_ledger_entries,
-- author_ledger_balance(), get_author_financial_summary(),
-- list_author_financial_activity(), get_author_payout_overview(), and
-- list_author_payout_history() are all completely untouched. No
-- Stripe code path is touched, called, or affected by anything in this
-- migration. No scheduler HTTP route, no cron configuration, no
-- feature switch, no provider adapter, and no real money movement
-- exist anywhere in this file.
-- ============================================================
