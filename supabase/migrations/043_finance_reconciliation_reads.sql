-- LIBRUM 2.0 ADMIN-1D PART B: finance/reconciliation READ PRIMITIVES only.
-- No Stripe call is made anywhere in this file. No mutation of
-- refund_issuance_attempts, payment_disputes, book_checkout_intents, or
-- bundle_checkout_snapshots is introduced -- every function below is
-- `stable`/read-only over existing tables. This file adds exactly one
-- new permission (finance.view) and six new SECURITY DEFINER functions
-- (one private helper, five public read RPCs). No new table, no new
-- column, no new index -- see each Part's own comment for why the
-- existing schema/indexes already suffice.
--
-- ADMIN-1D PART A (the audit that preceded this) found that /admin has
-- zero visibility into stale-approved refunds, refund_issuance_attempts
-- state, disputes, transfer reversals, or orphaned checkout intents --
-- this file builds the secure data layer a future /admin/finance UI
-- (ADMIN-1D Part C) will read from. No UI, no recovery action, no
-- FIN-OPS-1 mutation, and no relaxation of the existing refund-issuance
-- ownership invariant is introduced here -- see this file's own Part 7
-- comment for why the actor-takeover problem is explicitly deferred to
-- ADMIN-1D Part D.
--
-- ORDERING INVARIANT (same discipline every prior migration in this
-- series already establishes): every function this file's statements
-- reference must already be defined earlier in this same file, OR in an
-- earlier, already-applied migration. staff_has_permission(),
-- refund_requests, refund_issuance_attempts, payment_disputes,
-- book_checkout_intents, bundle_checkout_snapshots, purchases, and
-- profiles all already exist (migrations 002/003/017/025/027/029/032/
-- 035/036/040/042) -- this file only extends staff_has_permission() and
-- adds new, purely additive read functions.
--
-- Migrations 002 through 042 are immutable (already production-applied)
-- and are not modified by this file in any way.

-- ============================================================
-- Part 1: finance.view -- extends staff_has_permission()'s existing
-- 'admin' branch only, identical treatment to how ADMIN-1C Part B added
-- audit.view. owner is unconditionally true already (no change needed);
-- moderator/support/editor get no new branch, so
-- staff_has_permission('finance.view') already returns false for them by
-- construction, exactly like every other permission they don't hold.
-- This is a CREATE OR REPLACE on staff_has_permission()'s existing,
-- unchanged signature -- its own revoke-all-then-grant-execute-to-
-- authenticated block (migration 040) is preserved automatically and is
-- not repeated here, the same convention migration 042 itself already
-- used when it added audit.view this same way.
--
-- Deliberately NOT added here (ADMIN-1D Part B's own explicit scope
-- boundary): finance.reconcile, finance.recover_orphaned,
-- finance.export. Part B/C are read-only; introducing a mutation
-- permission before any mutation design is reviewed and approved would
-- grant a capability with nothing behind it yet, and risks the matrix
-- drifting out of sync with what actually exists -- add each mutation
-- permission in the same change that adds the RPC it guards, in a later
-- part.
-- ============================================================

create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
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
            'finance.view'
          )
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
-- Part 2: refund_reconciliation_rows() -- a PRIVATE helper (no EXECUTE
-- grant to authenticated at all, same posture as payment_intent_has_
-- lost_dispute() from migration 035/037), so the exact same
-- classification logic is computed in exactly one place and reused by
-- both list_refund_reconciliation_states() (Part 3, paginated/filtered)
-- and get_finance_summary_counts() (Part 8, aggregated) -- never
-- duplicated between them.
--
-- CRITICAL CORRECTNESS NOTE (ADMIN-1D Part A's own finding, carried
-- forward verbatim): 'initiated' does NOT mean "Stripe was never
-- called." The durability ordering begin_refund_issuance_attempt()
-- establishes is: (1) a durable 'initiated' row is committed, (2) THEN
-- stripe.refunds.create() may run, (3) THEN the local completion/failure
-- RPC records the outcome. A row still showing 'initiated' can mean the
-- process died before step 2, during step 2, or even AFTER Stripe
-- accepted the refund but before step 3 ever ran -- Librum genuinely
-- cannot distinguish these from the local row alone. This file therefore
-- never encodes "initiated = never called Stripe" anywhere -- a stale
-- 'initiated' row is classified as 'approved_attempt_stale_initiated'
-- (ambiguous, needs human reconciliation, exactly like an 'unknown' row
-- -- NOT as "safe to just retry, nothing happened yet").
--
-- APPROVED, NEVER ATTEMPTED: needs_attention = true IMMEDIATELY, no
-- grace period. ADMIN-1D PART B FINAL PRE-COMMIT CLASSIFICATION
-- CORRECTION removed an earlier draft's invented 24-hour threshold here.
-- Once staff has explicitly approved a refund request, issuing it is the
-- one remaining step of an administrative workflow Librum itself already
-- decided to complete -- there is no legitimate reason to wait a full
-- day before treating an unattempted approval as something a
-- reconciliation view should surface. This is NOT a claim that the
-- refund is broken, late, or overdue -- see describeRefundOperationalState
-- in finance-logic.ts, whose label for this exact state is "Approved —
-- awaiting issuance," never "Failed"/"Overdue"/"Broken". needs_attention
-- here means "this is the kind of thing an exception queue should list,"
-- not "something has gone wrong."
--
-- STALE-INITIATED THRESHOLD: 5 minutes -- a Librum OPERATIONAL TRIAGE
-- HEURISTIC for a synchronous begin -> stripe.refunds.create() ->
-- complete/fail flow (executeApprovedRefund(), issue-refund.ts), not a
-- database invariant derived from any hosting provider's current
-- execution-timeout configuration. No deployment/platform assumption is
-- part of this threshold's correctness -- it exists purely to give staff
-- a practical operational signal ("this attempt has been sitting
-- unresolved long enough to be worth a look") without claiming to prove
-- anything about what actually happened to the underlying Stripe call.
-- 5 minutes is deliberately generous relative to how quickly this flow
-- ordinarily completes, so an attempt genuinely still in progress is
-- essentially never flagged mid-flight, while a row still 'initiated'
-- after that long is worth surfacing for human reconciliation -- not
-- because SQL claims to know the request has definitely terminated, only
-- because it has been ambiguous for longer than is operationally normal.
-- Not user-configurable in V1, per this file's own explicit scope
-- boundary -- hardcoded here, in exactly one place; TypeScript never
-- needs to know this value at all (it only ever formats the label SQL
-- already computed, never recomputes staleness itself).
--
-- SUBMITTED-AWAITING-FINALIZATION THRESHOLD: 1 hour -- likewise a
-- Librum operational triage heuristic for ordinary webhook-finalization
-- latency (refund.updated/charge.refunded settling refund_requests.
-- status = 'refunded'), NOT a Stripe-guaranteed delivery SLA and not a
-- claim that Stripe has failed. Measured from the ATTEMPT'S OWN
-- updated_at (the actual transition-to-'submitted' timestamp complete_
-- refund_issuance_attempt() writes), not its created_at (which can be
-- much earlier if the same row started as 'unknown' and only resolved to
-- 'submitted' on a later retry). A refund is not "broken" merely for
-- passing this threshold -- it means the ordinary settlement window has
-- elapsed without confirmation, which is worth a look, not an alarm.
-- ============================================================

create or replace function public.refund_reconciliation_rows()
returns table (
  refund_request_id uuid,
  reader_id uuid,
  amount_cents integer,
  refund_request_status text,
  requested_at timestamptz,
  reviewed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  latest_attempt_created_at timestamptz,
  latest_attempt_updated_at timestamptz,
  stripe_refund_id text,
  stripe_status text,
  operational_state text,
  needs_attention boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  with latest_attempts as (
    select distinct on (refund_issuance_attempts.refund_request_id)
      refund_issuance_attempts.id,
      refund_issuance_attempts.refund_request_id,
      refund_issuance_attempts.status,
      refund_issuance_attempts.stripe_refund_id,
      refund_issuance_attempts.stripe_status,
      refund_issuance_attempts.created_at,
      refund_issuance_attempts.updated_at
    from public.refund_issuance_attempts
    order by
      refund_issuance_attempts.refund_request_id,
      refund_issuance_attempts.created_at desc,
      refund_issuance_attempts.id desc
  )
  select
    rr.id as refund_request_id,
    rr.reader_id,
    rr.amount_cents,
    rr.status as refund_request_status,
    rr.requested_at,
    rr.reviewed_at,
    la.id as latest_attempt_id,
    la.status as latest_attempt_status,
    la.created_at as latest_attempt_created_at,
    la.updated_at as latest_attempt_updated_at,
    la.stripe_refund_id,
    la.stripe_status,
    case
      when rr.status = 'requested' then 'requested'
      when rr.status = 'rejected' then 'rejected'
      when rr.status = 'refunded' then 'refunded'
      when rr.status = 'cancelled' then 'cancelled'
      when rr.status = 'approved' and la.id is null then 'approved_unattempted'
      -- Strict '>' here, paired with needs_attention's own '<=' below, so
      -- the two never disagree at the exact boundary instant: an attempt
      -- exactly 5 minutes old is classified stale in BOTH fields, never
      -- "fresh" in one and "needs attention" in the other.
      when rr.status = 'approved' and la.status = 'initiated'
        and la.created_at > (now() - interval '5 minutes') then 'approved_attempt_initiated'
      when rr.status = 'approved' and la.status = 'initiated' then 'approved_attempt_stale_initiated'
      when rr.status = 'approved' and la.status = 'unknown' then 'approved_attempt_unknown'
      when rr.status = 'approved' and la.status = 'failed' then 'approved_attempt_failed'
      when rr.status = 'approved' and la.status = 'submitted' then 'approved_attempt_submitted'
      -- Unreachable given refund_requests.status's and refund_issuance_
      -- attempts.status's own CHECK constraints -- kept as an explicit,
      -- visible fallback rather than silently returning null, matching
      -- this schema's universal fail-loud-not-silent discipline.
      else 'unclassified'
    end as operational_state,
    case
      -- No grace period: an approved, never-attempted request needs
      -- attention immediately -- see this function's own header comment
      -- (ADMIN-1D PART B FINAL PRE-COMMIT CLASSIFICATION CORRECTION) for
      -- why an invented waiting period was removed here.
      when rr.status = 'approved' and la.id is null then true
      when rr.status = 'approved' and la.status = 'initiated'
        and la.created_at <= (now() - interval '5 minutes') then true
      when rr.status = 'approved' and la.status = 'unknown' then true
      when rr.status = 'approved' and la.status = 'failed' then true
      when rr.status = 'approved' and la.status = 'submitted'
        and la.updated_at <= (now() - interval '1 hour') then true
      else false
    end as needs_attention
  from public.refund_requests rr
  left join latest_attempts la on la.refund_request_id = rr.id;
$$;

revoke all on function public.refund_reconciliation_rows() from public;
revoke all on function public.refund_reconciliation_rows() from anon;
revoke all on function public.refund_reconciliation_rows() from authenticated;
-- No grant to authenticated at all, deliberately -- this is an internal
-- composition helper, never a direct application RPC call. Every
-- legitimate caller is another SECURITY DEFINER function in this same
-- file, which keeps working via the shared function-owner's own implicit
-- EXECUTE privilege, unaffected by this revoke -- the exact same pattern
-- payment_intent_has_lost_dispute() already established (migrations
-- 035/037).

-- ============================================================
-- Part 3: list_refund_reconciliation_states() -- the ONE finance-view
-- read path for refund operational state. Deliberately the COMPLETE
-- refund-status list (requested/rejected/refunded/cancelled included,
-- not just the approved-and-stuck exceptions), filterable down to a
-- needs_attention-only view -- chosen over a narrower "exceptions only"
-- RPC specifically so a future /admin/finance and a future /admin/
-- refunds integration can both call this ONE function with different
-- filters, rather than each growing its own independent copy of the
-- operational_state classification logic. p_operational_state and
-- p_needs_attention are independent, composable filters (both may be
-- supplied, either, or neither).
--
-- Keyset pagination on (requested_at desc, refund_request_id desc),
-- mirroring list_admin_audit_events()'s own established cursor
-- contract exactly (ADMIN-1C Part B) -- no OFFSET anywhere. p_limit
-- clamped identically: null -> 25, below 1 -> 1, above 100 -> 100.
-- ============================================================

create or replace function public.list_refund_reconciliation_states(
  p_operational_state text default null,
  p_needs_attention boolean default null,
  p_cursor_requested_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  refund_request_id uuid,
  reader_id uuid,
  reader_display_name text,
  amount_cents integer,
  refund_request_status text,
  requested_at timestamptz,
  reviewed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  latest_attempt_created_at timestamptz,
  latest_attempt_updated_at timestamptz,
  stripe_refund_id text,
  stripe_status text,
  operational_state text,
  needs_attention boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  if p_operational_state is not null and p_operational_state not in (
    'requested', 'rejected', 'refunded', 'cancelled',
    'approved_unattempted', 'approved_attempt_initiated',
    'approved_attempt_stale_initiated', 'approved_attempt_unknown',
    'approved_attempt_failed', 'approved_attempt_submitted'
  ) then
    raise exception 'invalid operational_state filter';
  end if;

  if (p_cursor_requested_at is null) <> (p_cursor_id is null) then
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
      r.refund_request_id,
      r.reader_id,
      p.display_name as reader_display_name,
      r.amount_cents,
      r.refund_request_status,
      r.requested_at,
      r.reviewed_at,
      r.latest_attempt_id,
      r.latest_attempt_status,
      r.latest_attempt_created_at,
      r.latest_attempt_updated_at,
      r.stripe_refund_id,
      r.stripe_status,
      r.operational_state,
      r.needs_attention
    from public.refund_reconciliation_rows() r
    left join public.profiles p on p.id = r.reader_id
    where (p_operational_state is null or r.operational_state = p_operational_state)
      and (p_needs_attention is null or r.needs_attention = p_needs_attention)
      and (
        p_cursor_requested_at is null
        or (r.requested_at, r.refund_request_id) < (p_cursor_requested_at, p_cursor_id)
      )
    order by r.requested_at desc, r.refund_request_id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from public;
revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from anon;
revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- Part 4: list_finance_disputes() -- read-only projection of
-- payment_disputes. Deliberately does NOT expose transfer_reversal_
-- failure_message: that column can hold a raw, unbounded Stripe SDK
-- error string (`stripeError.message ?? String(error)`, see
-- failTransferReversalAttempt() call site in src/app/api/webhooks/
-- stripe/route.ts) -- exactly the "unbounded/raw Stripe error" this
-- file's own design brief prohibits surfacing. transfer_reversal_
-- failure_code IS exposed: it is Stripe's own short, bounded error-code
-- taxonomy (e.g. 'insufficient_funds'), not free text.
--
-- needs_attention does NOT claim knowledge of any Stripe evidence
-- deadline -- payment_disputes stores no evidence_due_by/needs_response
-- column (confirmed: not part of this table, migration 035/036), so no
-- such fact is fabricated here. needs_attention is exactly two safe,
-- source-grounded signals, OR'd together:
--   (a) status is not a recognized TERMINAL Stripe dispute status. The
--       terminal set is a small, explicit allow-list ('won', 'lost',
--       'warning_closed', 'charge_refunded') -- status carries NO check
--       constraint in this schema (migration 035's own comment: Stripe's
--       SDK types Dispute.status as an open string union, deliberately
--       unconstrained here). Failing CLOSED (an unrecognized future
--       Stripe status counts as non-terminal, i.e. needs_attention)
--       matches this schema's universal "never silently treat an
--       unrecognized value as safe" discipline.
--   (b) status = 'lost' and transfer_reversal_status = 'failed', OR
--       transfer_reversal_status = 'attempting' and stale by the SAME
--       10-minute threshold the existing reconciliation route already
--       uses (STALE_ATTEMPTING_THRESHOLD_MS = 10 * 60 * 1000, src/app/
--       api/internal/reconcile-transfer-reversals/route.ts) -- reused
--       verbatim, not reinvented, so this RPC's notion of "stale
--       attempting" never drifts from the cron's own.
--
-- reader_id/reader_display_name are best-effort DISPLAY context, not an
-- authoritative join: a dispute's stripe_payment_intent_id is not
-- guaranteed to resolve to exactly one purchases/bundle_checkout_
-- snapshots row (a bundle fans out to several purchases rows sharing one
-- PI, and a book can later be repurchased, which overwrites its
-- purchases row's own stripe_payment_intent_id -- see this file's own
-- Part 7 comment for the full reasoning behind why that makes an
-- absence non-authoritative). Resolved bundle-first (bundle_checkout_
-- snapshots.stripe_payment_intent_id IS unique, a true 1:1 match). Falls
-- back to the most recent matching purchases row otherwise, deterministic
-- via LATERAL ... ORDER BY created_at desc, id desc LIMIT 1. A dispute
-- whose PI matches no row at all (context genuinely unavailable) simply
-- returns reader_id/reader_display_name as null -- never fabricated.
-- ============================================================

create or replace function public.list_finance_disputes(
  p_needs_attention boolean default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  stripe_dispute_id text,
  stripe_payment_intent_id text,
  reader_id uuid,
  reader_display_name text,
  status text,
  reason text,
  amount_cents integer,
  created_at timestamptz,
  updated_at timestamptz,
  transfer_reversal_status text,
  stripe_transfer_reversal_id text,
  transfer_reversal_attempt_count integer,
  transfer_reversal_attempted_at timestamptz,
  transfer_reversal_succeeded_at timestamptz,
  transfer_reversal_failure_code text,
  needs_attention boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

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
      pd.id,
      pd.stripe_dispute_id,
      pd.stripe_payment_intent_id,
      coalesce(bundle_ctx.reader_id, purchase_ctx.reader_id) as reader_id,
      coalesce(bundle_ctx.reader_display_name, purchase_ctx.reader_display_name) as reader_display_name,
      pd.status,
      pd.reason,
      pd.amount_cents,
      pd.created_at,
      pd.updated_at,
      pd.transfer_reversal_status,
      pd.stripe_transfer_reversal_id,
      pd.transfer_reversal_attempt_count,
      pd.transfer_reversal_attempted_at,
      pd.transfer_reversal_succeeded_at,
      pd.transfer_reversal_failure_code,
      (
        pd.status not in ('won', 'lost', 'warning_closed', 'charge_refunded')
        or (
          pd.status = 'lost'
          and (
            pd.transfer_reversal_status = 'failed'
            or (
              pd.transfer_reversal_status = 'attempting'
              and pd.transfer_reversal_attempted_at <= (now() - interval '10 minutes')
            )
          )
        )
      ) as needs_attention
    from public.payment_disputes pd
    left join lateral (
      select bcs.reader_id, pr.display_name as reader_display_name
      from public.bundle_checkout_snapshots bcs
      left join public.profiles pr on pr.id = bcs.reader_id
      where bcs.stripe_payment_intent_id = pd.stripe_payment_intent_id
      limit 1
    ) bundle_ctx on true
    left join lateral (
      select pu.reader_id, pr2.display_name as reader_display_name
      from public.purchases pu
      left join public.profiles pr2 on pr2.id = pu.reader_id
      where pu.stripe_payment_intent_id = pd.stripe_payment_intent_id
      order by pu.created_at desc, pu.id desc
      limit 1
    ) purchase_ctx on true
    where (
      p_needs_attention is null
      or (
        pd.status not in ('won', 'lost', 'warning_closed', 'charge_refunded')
        or (
          pd.status = 'lost'
          and (
            pd.transfer_reversal_status = 'failed'
            or (
              pd.transfer_reversal_status = 'attempting'
              and pd.transfer_reversal_attempted_at <= (now() - interval '10 minutes')
            )
          )
        )
      ) = p_needs_attention
    )
    and (
      p_cursor_created_at is null
      or (pd.created_at, pd.id) < (p_cursor_created_at, p_cursor_id)
    )
    order by pd.created_at desc, pd.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from public;
revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from anon;
revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- Part 5: list_finance_checkout_exceptions() -- single-book checkout
-- reconciliation only. Exactly the existing book_checkout_intents_
-- needs_reconciliation_idx partial index (completed_at) where fulfilled_
-- at is null and completed_at is not null, migration 032 -- these rows
-- are, BY CONSTRUCTION of that table's own CHECK-constraint state
-- machine, Stripe-confirmed-paid transactions that did not grant
-- entitlement, each carrying an authoritative reconciliation_reason.
--
-- book_title is read from book_checkout_intents.book_title itself (a
-- column frozen at checkout time), never joined live against books --
-- this is deliberate: a 'book_or_reader_deleted' reconciliation_reason
-- means the live books row may no longer exist at all, and the frozen
-- column is exactly what survives that case.
--
-- NO BUNDLE EQUIVALENT IS BUILT HERE -- see this file's own Part 7
-- comment for why: bundle_checkout_snapshots has no completed_at-
-- equivalent column, so "Stripe confirmed payment but Librum failed to
-- fulfill" cannot be safely distinguished from "the reader never paid
-- at all" for a bundle checkout with the CURRENT schema. Per this
-- migration's own scope discipline (report a real limitation rather
-- than invent an unproven classifier), that gap is documented, not
-- papered over with a lower-confidence heuristic mixed into the same
-- "exception" list as these high-confidence rows.
-- ============================================================

create or replace function public.list_finance_checkout_exceptions(
  p_cursor_completed_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  intent_id uuid,
  book_id uuid,
  book_title text,
  reader_id uuid,
  reader_display_name text,
  price_cents_at_checkout integer,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  completed_at timestamptz,
  reconciliation_reason text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  if (p_cursor_completed_at is null) <> (p_cursor_id is null) then
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
      bci.id as intent_id,
      bci.book_id,
      bci.book_title,
      bci.reader_id,
      p.display_name as reader_display_name,
      bci.price_cents_at_checkout,
      bci.stripe_checkout_session_id,
      bci.stripe_payment_intent_id,
      bci.completed_at,
      bci.reconciliation_reason,
      bci.created_at
    from public.book_checkout_intents bci
    left join public.profiles p on p.id = bci.reader_id
    where bci.completed_at is not null
      and bci.fulfilled_at is null
      and (
        p_cursor_completed_at is null
        or (bci.completed_at, bci.id) < (p_cursor_completed_at, p_cursor_id)
      )
    order by bci.completed_at desc, bci.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from public;
revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from anon;
revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- Part 6: list_finance_refund_entitlement_mismatches() -- three narrow,
-- SAFE-DIRECTION-ONLY consistency checks, each an EXISTS-based positive
-- signal, never inferred from an absence of rows. See this file's own
-- Part 7 comment for exactly why the absence direction is unsafe to
-- check (purchases.stripe_payment_intent_id gets silently overwritten
-- on a repurchase of the same book, so "zero matching purchases rows"
-- does not reliably mean anything by itself).
--
--   'refunded_request_active_purchase' -- refund_requests.status =
--     'refunded' (not a snapshot-based request) but a purchases row
--     matching its stripe_payment_intent_id still shows refunded_at is
--     null. A real drift: entitlement should have been revoked when the
--     request settled.
--   'refunded_request_active_bundle_snapshot' -- same idea, for a
--     snapshot-based request (refund_requests.bundle_checkout_snapshot_
--     id is not null): the linked bundle_checkout_snapshots.refunded_at
--     is still null despite the request itself reading 'refunded'.
--   'purchase_refunded_request_unresolved' -- a purchases row shows
--     refunded_at is not null, but a MATCHING refund_requests row (same
--     stripe_payment_intent_id) exists and its own status is not yet
--     'refunded'. Deliberately does NOT fire when zero refund_requests
--     rows exist for that PI at all -- a direct Stripe Dashboard refund
--     with no corresponding Librum refund_requests row is an explicitly
--     documented, legitimate, expected state (refund_requests.reviewed_
--     at's own column comment, migration 029), not a data gap.
--
-- No cursor/keyset pagination on this one, deliberately -- unlike the
-- other list RPCs above, this is a rare cross-consistency health check,
-- not a growing operational queue: in a healthy system every one of
-- these three conditions should return zero rows. A plain bounded LIMIT
-- (still clamped 1-100, still finance.view-gated) is proportionate; add
-- real keyset pagination later if actual volume ever demonstrates the
-- need.
-- ============================================================

create or replace function public.list_finance_refund_entitlement_mismatches(
  p_limit integer default 25
)
returns table (
  mismatch_type text,
  refund_request_id uuid,
  purchase_id uuid,
  bundle_checkout_snapshot_id uuid,
  reader_id uuid,
  reader_display_name text,
  stripe_payment_intent_id text,
  amount_cents integer
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    (
      select
        'refunded_request_active_purchase'::text as mismatch_type,
        rr.id as refund_request_id,
        pu.id as purchase_id,
        null::uuid as bundle_checkout_snapshot_id,
        rr.reader_id,
        p.display_name as reader_display_name,
        rr.stripe_payment_intent_id,
        rr.amount_cents
      from public.refund_requests rr
      join public.purchases pu on pu.stripe_payment_intent_id = rr.stripe_payment_intent_id
      left join public.profiles p on p.id = rr.reader_id
      where rr.status = 'refunded'
        and rr.bundle_checkout_snapshot_id is null
        and pu.refunded_at is null
    )
    union all
    (
      select
        'refunded_request_active_bundle_snapshot'::text,
        rr.id,
        null::uuid,
        bcs.id,
        rr.reader_id,
        p.display_name,
        rr.stripe_payment_intent_id,
        rr.amount_cents
      from public.refund_requests rr
      join public.bundle_checkout_snapshots bcs on bcs.id = rr.bundle_checkout_snapshot_id
      left join public.profiles p on p.id = rr.reader_id
      where rr.status = 'refunded'
        and rr.bundle_checkout_snapshot_id is not null
        and bcs.refunded_at is null
    )
    union all
    (
      select
        'purchase_refunded_request_unresolved'::text,
        rr.id,
        pu.id,
        null::uuid,
        pu.reader_id,
        p.display_name,
        pu.stripe_payment_intent_id,
        pu.amount_cents
      from public.purchases pu
      join public.refund_requests rr on rr.stripe_payment_intent_id = pu.stripe_payment_intent_id
      left join public.profiles p on p.id = pu.reader_id
      where pu.refunded_at is not null
        and rr.status <> 'refunded'
    )
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from public;
revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from anon;
revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from authenticated;
grant execute on function public.list_finance_refund_entitlement_mismatches(integer) to authenticated;

-- ============================================================
-- Part 7: NOT built in this file -- explicitly out of scope, recorded
-- here so the reasoning lives next to the code it constrains.
--
-- (a) Bundle checkout exception detection ("payment succeeded but not
--     fulfilled" for a bundle). bundle_checkout_snapshots has no
--     completed_at-equivalent column: fulfillBundleSnapshot() (the
--     webhook) sets fulfilled_at, total_amount_cents, and stripe_
--     payment_intent_id together, in the SAME compare-and-swap UPDATE
--     (guarded `where fulfilled_at is null`, src/app/api/webhooks/
--     stripe/route.ts). If that write never lands, stripe_payment_
--     intent_id stays null too -- there is no durable signal left behind
--     that distinguishes "Stripe actually confirmed this payment" from
--     "the reader never paid at all." Reporting this limitation, not
--     inventing a lower-confidence heuristic (e.g. "expired + a Stripe
--     session id was ever linked back") that would sit in the same
--     "exception" list as list_finance_checkout_exceptions()'s
--     genuinely proven rows above and quietly erode trust in it.
--
-- (b) Any repurchase-driven "orphaned purchase" detector. finalize_
--     book_checkout_intent()'s own upsert (`on conflict (book_id,
--     reader_id) do update`) overwrites stripe_checkout_session_id/
--     stripe_payment_intent_id/amount_cents on a repurchase of the same
--     book by the same reader -- so a HISTORICAL refunded transaction's
--     payment_intent_id can silently stop appearing in purchases at all
--     once that book is bought again. This means "zero purchases rows
--     match this payment_intent_id" is NOT a safe signal of anything by
--     itself (it can mean "legitimately no purchases row ever existed
--     here", e.g. the zero-eligible-item bundle case, OR "a later
--     repurchase overwrote the row this PI used to own"), which is
--     exactly why list_finance_refund_entitlement_mismatches() above
--     only ever fires on rows that DO exist and disagree -- never on an
--     absence.
--
-- (c) Any Stripe-mutating recovery action, including FIN-OPS-1 (an
--     'unknown'/'initiated' refund_issuance_attempts row whose actor_id
--     has gone null). This file adds ZERO new INSERT/UPDATE/DELETE
--     against refund_issuance_attempts, payment_disputes, book_
--     checkout_intents, or bundle_checkout_snapshots, and does not touch
--     begin_refund_issuance_attempt()/complete_refund_issuance_
--     attempt()/fail_refund_issuance_attempt()'s existing `attempt.
--     actor_id = auth.uid()` ownership check in any way. The broader
--     actor-takeover problem this file's own audit predecessor
--     (ADMIN-1D Part A) identified is real, but explicitly deferred to
--     ADMIN-1D Part D, and is BROADER than "actor_id is null" alone --
--     it also covers an actor who has been demoted, or who is simply a
--     different staff member than the one who began the attempt. No
--     code for any of that exists here.
-- ============================================================

-- ============================================================
-- Part 8: get_finance_summary_counts() -- one small, cheap summary RPC
-- for a future /admin/finance landing page. Deliberately counts only --
-- no monetary aggregate (no SUM(amount_cents) anywhere): none of these
-- counts have a concrete operational use for a dollar total, only for
-- "how many things need a human to look at them," per this file's own
-- design brief. Every predicate below exactly mirrors its corresponding
-- list RPC's own WHERE clause (Parts 3/4/5/6), so the count a caller
-- sees always agrees with what that list RPC would actually return for
-- the same filter -- and every one of those predicates is already
-- backed by an existing index or, for refund_reconciliation_rows()
-- itself, a table whose realistic size at this stage does not warrant a
-- new one (see this file's own header for the full per-RPC index
-- reasoning already given in Parts 3-6 above; not repeated per-column
-- here).
-- ============================================================

create or replace function public.get_finance_summary_counts()
returns table (
  refund_needs_attention_count integer,
  dispute_needs_attention_count integer,
  checkout_exception_count integer,
  refund_entitlement_mismatch_count integer
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  return query
    select
      (select count(*)::integer from public.refund_reconciliation_rows() r where r.needs_attention),
      (
        select count(*)::integer
        from public.payment_disputes pd
        where pd.status not in ('won', 'lost', 'warning_closed', 'charge_refunded')
          or (
            pd.status = 'lost'
            and (
              pd.transfer_reversal_status = 'failed'
              or (
                pd.transfer_reversal_status = 'attempting'
                and pd.transfer_reversal_attempted_at <= (now() - interval '10 minutes')
              )
            )
          )
      ),
      (
        select count(*)::integer
        from public.book_checkout_intents bci
        where bci.completed_at is not null and bci.fulfilled_at is null
      ),
      (
        select count(*)::integer
        from (
          select rr.id
          from public.refund_requests rr
          join public.purchases pu on pu.stripe_payment_intent_id = rr.stripe_payment_intent_id
          where rr.status = 'refunded' and rr.bundle_checkout_snapshot_id is null and pu.refunded_at is null
          union all
          select rr.id
          from public.refund_requests rr
          join public.bundle_checkout_snapshots bcs on bcs.id = rr.bundle_checkout_snapshot_id
          where rr.status = 'refunded' and rr.bundle_checkout_snapshot_id is not null and bcs.refunded_at is null
          union all
          select rr.id
          from public.purchases pu
          join public.refund_requests rr on rr.stripe_payment_intent_id = pu.stripe_payment_intent_id
          where pu.refunded_at is not null and rr.status <> 'refunded'
        ) mismatches
      );
end;
$$;

revoke all on function public.get_finance_summary_counts() from public;
revoke all on function public.get_finance_summary_counts() from anon;
revoke all on function public.get_finance_summary_counts() from authenticated;
grant execute on function public.get_finance_summary_counts() to authenticated;
