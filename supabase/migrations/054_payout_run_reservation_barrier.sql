-- LIBRUM 2.0 LEDGER-1E-D-D.1: closed-run reservation barrier.
--
-- Migration 053 is already LIVE production history and is NOT modified
-- here in any way. This migration touches exactly ONE existing
-- function -- reserve_author_payout() -- adding a narrow, additive
-- concurrency guard. No table, no column, no trigger, no index is
-- added or changed.
--
-- ============================================================
-- THE GAP (confirmed by direct local reproduction against the current
-- production-live migration 053 definition, not assumed):
--
-- reserve_author_payout(p_author_id, p_currency, p_payout_run_id) never
-- reads public.payout_runs at all. p_payout_run_id is used ONLY as a
-- plain value written into author_payouts.payout_run_id -- there is no
-- SELECT, no status check, no lock against that table anywhere in its
-- body. The only guard against a bogus id is author_payouts'
-- pre-existing FK (migration 051: `payout_run_id uuid references
-- public.payout_runs(id) on delete restrict`), which only checks
-- EXISTENCE, never status.
--
-- Reproduced directly: start a run, complete it, then call
-- reserve_author_payout(eligible_author, currency, that_now_completed_
-- run_id) -- it inserts a brand-new 'pending' author_payouts row
-- referencing the completed run, with zero rejection.
--
-- WHY THIS MATTERS (LEDGER-1E-D-D's own application scheduler,
-- deliberately built with NO in-memory lock/mutex, per its own Section
-- 25/46): two overlapping route invocations can legitimately both be
-- mid-pass against the SAME still-'running' month. If invocation A
-- reaches complete_scheduled_payout_run() while invocation B is still
-- iterating its own (now-stale) eligible-candidate list from an
-- earlier dry_run_scheduled_payouts() scan, B's subsequent
-- reserve_author_payout() calls must never be able to attach a fresh
-- reservation to a run B's own database state now says is closed. This
-- must be a DATABASE invariant -- the application has no lock to rely
-- on.
-- ============================================================
--
-- ============================================================
-- THE FIX: a row lock, not a bare read.
--
-- A plain `select status from payout_runs where id = ...` followed
-- later by an INSERT is NOT sufficient -- a concurrent
-- complete_scheduled_payout_run() could commit its UPDATE in the
-- window between that SELECT and this function's own INSERT, and the
-- race described above would still exist unchanged.
--
-- Instead: when p_payout_run_id is not null, reserve_author_payout()
-- now does `select status from public.payout_runs where id =
-- p_payout_run_id for share` -- a FOR SHARE row lock, held for the
-- remainder of this function's own transaction (a single RPC call is a
-- single Postgres transaction under PostgREST/supabase-js, exactly
-- like every other RPC in this schema).
--
-- complete_scheduled_payout_run() (migration 053, UNCHANGED here)
-- already does `select ... from public.payout_runs pr where pr.id =
-- p_run_id for update` before its own UPDATE. FOR SHARE and FOR UPDATE
-- are mutually conflicting Postgres row-lock modes on the SAME row --
-- this is the exact, standard Postgres pattern for serializing a
-- "many readers must not race one writer" relationship, requiring no
-- new lock primitive, no advisory lock, and no schema change.
--
-- This produces EXACTLY the two legal outcomes (verified below by a
-- genuine two-connection contention script, not merely reasoned about):
--
--   OUTCOME A: reserve's FOR SHARE is granted first (run still
--   'running' at that instant) -- its transaction proceeds to insert
--   the reservation and commits. complete's FOR UPDATE, attempted
--   concurrently, BLOCKS until reserve's transaction ends, then
--   proceeds normally against the still-'running' row (reserve never
--   mutates payout_runs), completing the run afterward.
--
--   OUTCOME B: complete's FOR UPDATE is granted first -- its UPDATE
--   commits, the run becomes 'completed'. reserve's FOR SHARE, which
--   was blocked waiting for that same row, is granted only AFTER
--   complete's transaction ends, and therefore reads the ALREADY-
--   'completed' status -- reserve then returns zero rows, inserting
--   nothing.
--
-- NEVER: a run becomes 'completed' and a new reservation is inserted
-- against it afterward. That specific ordering is now structurally
-- impossible, not merely unlikely.
-- ============================================================
--
-- ============================================================
-- BEHAVIOR WHEN p_payout_run_id IS NOT NULL (Section 6/9/10):
--
--   - No such run exists at all: raise a deterministic exception
--     immediately, before eligibility is ever computed or any
--     financial logic runs -- never a bare foreign_key_violation
--     surfacing only after an unrelated eligibility computation.
--   - Run exists but is NOT 'running' (completed, failed, or any other
--     non-'running' value): return zero rows -- the exact same
--     deterministic "not eligible right now" outcome every other
--     ineligibility case already produces. NEVER reopens the run,
--     NEVER changes its status, NEVER raises for this case specifically
--     -- an overlapping scheduler invocation reaching an
--     already-closed run is an expected, benign race, not a system
--     failure. (A 'failed' run reaching this path at all would already
--     be unusual -- start_scheduled_payout_run() rejects starting a new
--     pass against a failed run -- but if it is ever reached here, it
--     is treated identically to 'completed': no reservation, no
--     mutation, no special-cased exception.)
--   - Run exists and IS 'running': proceeds exactly as before,
--     unchanged eligibility computation and unchanged INSERT/
--     unique_violation handling.
--
-- BEHAVIOR WHEN p_payout_run_id IS NULL (Section 12): completely
-- unchanged -- the entire new run-validation block above is skipped
-- structurally (the `if p_payout_run_id is not null then ... end if;`
-- guard), so every non-scheduler/manual/future-provider caller that
-- has never supplied a run id sees byte-identical behavior to
-- migration 053's own version. This migration does not make every
-- reservation require a scheduled run.
-- ============================================================
--
-- ============================================================
-- WHAT IS DELIBERATELY UNCHANGED:
--   - author_payout_eligibility() (Part 1 of migration 053): zero
--     changes. Threshold logic, active-reservation blocker, full-
--     payoutable (never clamped) reservation amount, multi-currency
--     isolation -- all untouched.
--   - The active-reservation partial unique index
--     (author_payouts_one_active_per_author_currency_idx, migration
--     051) and reserve_author_payout()'s own constraint-specific
--     unique_violation/GET STACKED DIAGNOSTICS handling: copied
--     verbatim, unchanged.
--   - complete_scheduled_payout_run(): NOT modified by this migration
--     at all. Its own pre-existing `for update` lock (migration 053) is
--     already the correct conflicting lock mode -- adding anything to
--     this function would be unnecessary machinery for a property its
--     existing code already provides once reserve_author_payout() is
--     the one that changes. running->completed, completed->completed
--     idempotent, failed rejected, unknown id rejected: all preserved.
--   - reserve_author_payout()'s own EXTERNAL contract: same 3-argument
--     signature (p_author_id uuid, p_currency text, p_payout_run_id uuid
--     default null), same RETURNS TABLE (payout_id, amount_minor,
--     currency) shape, same SECURITY DEFINER/search_path=''/
--     service_role-only grants.
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
  v_run_status text;
begin
  if p_payout_run_id is not null then
    -- Closed-run reservation barrier (LEDGER-1E-D-D.1): FOR SHARE
    -- conflicts with complete_scheduled_payout_run()'s own FOR UPDATE
    -- on the same payout_runs row, serializing the two operations --
    -- see this migration's own header comment for the full two-outcome
    -- argument. The lock is held for the remainder of this
    -- transaction, i.e. until this RPC call commits or rolls back.
    select pr.status into v_run_status
    from public.payout_runs pr
    where pr.id = p_payout_run_id
    for share;

    if not found then
      raise exception 'reserve_author_payout: payout run % does not exist', p_payout_run_id;
    end if;

    if v_run_status <> 'running' then
      -- Deterministic, silent no-op -- never mutates payout_runs,
      -- never reopens it, never raises for this specific case. Same
      -- "zero rows" outcome as any other not-eligible-right-now
      -- result below.
      return;
    end if;
  end if;

  select * into v_eligibility
  from public.author_payout_eligibility(p_author_id, p_currency);

  if not v_eligibility.eligible then
    -- Not eligible right now, for any of the reasons
    -- author_payout_eligibility() distinguishes internally -- from
    -- this function's own external point of view this remains the
    -- same single, deterministic "zero rows" outcome it has always
    -- produced, exactly as migration 051 originally documented.
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
-- Production rollout compatibility: the only object this migration
-- touches is reserve_author_payout(), a create-or-replace of an
-- already-existing function -- same OID, same grants (reissued above,
-- unchanged), same external signature/RETURNS TABLE shape. No table,
-- column, index, or trigger is added or changed. Migrations 048-053
-- remain byte-unchanged. author_payout_eligibility(),
-- dry_run_scheduled_payouts(), start_scheduled_payout_run(), and
-- complete_scheduled_payout_run() are completely untouched. No Stripe
-- code path is touched, called, or affected. No scheduler HTTP route,
-- no cron configuration, no feature switch, no provider adapter, and no
-- real money movement exist anywhere in this file.
-- ============================================================
