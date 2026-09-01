-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LIBRUM 2.0 ADMIN-1C PART B: the audit-visibility primitives
-- deferred by ADMIN-1C Part A -- a new `audit.view` permission, a
-- controlled listing RPC, audit-event insertion for the two existing
-- report/refund review RPCs, and a durable, actor-attributed record of
-- every staff-triggered Stripe refund issuance ATTEMPT (not merely its
-- eventual, best-effort audit event). See the ADMIN-1C Part A audit
-- report for the general design reasoning, and this file's own Part 3
-- comment for the specific financial-durability correction this version
-- makes over the first draft.
--
-- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION (this version):
-- three further, narrowly-scoped invariants over the PRE-FINALIZE
-- durability-correction draft -- (1) a database-backed uniqueness
-- constraint so exactly one attempt row may ever claim a given real
-- Stripe refund object, enforced with a controlled failure in
-- complete_refund_issuance_attempt() rather than a silent duplicate; (2)
-- a fourth attempt status, 'unknown', distinguishing a Stripe API/
-- transport exception (ambiguous -- Stripe may have already accepted the
-- idempotent request) from a confirmed immediate failed/canceled
-- response (known); (3) refund_issuance_attempts.refund_request_id
-- changed from `on delete cascade` to `on delete restrict`, since this
-- table is financial evidence that must not silently disappear if its
-- parent row is ever deleted. See Part 3's own comment for the full
-- three-layer uniqueness model and Part 6 for the status-mapping
-- reasoning.
--
-- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION (this version): the
-- 'unknown' status added by the FINAL FINANCIAL INVARIANT CORRECTION
-- above was, as first shipped, a dead end -- complete_refund_issuance_
-- attempt()/fail_refund_issuance_attempt() only ever accepted 'initiated'
-- as a starting state, so a genuine retry after an ambiguous Stripe throw
-- (which reuses the SAME idempotency key and therefore resolves back to
-- the SAME durable attempt row) could never actually record its outcome.
-- Both RPCs now also accept 'unknown' as a starting state (guarded
-- `where status in ('initiated', 'unknown')`), giving the full state
-- machine documented on the table itself: initiated/unknown may each
-- transition to submitted, failed, or (fail only) unknown again;
-- submitted and failed remain strictly terminal. A known operational gap
-- (an 'unknown' attempt whose actor later becomes unavailable) is
-- explicitly tracked, not built, as FIN-OPS-1 -- see complete_refund_
-- issuance_attempt()'s own ownership-invariant comment.
--
-- ORDERING INVARIANT (same discipline migrations 040/041 already
-- establish): every function this file's statements reference must
-- already be defined earlier in this same file, OR in an earlier,
-- already-applied migration. staff_has_permission(), review_book_report(),
-- review_refund_request(), and admin_audit_log itself all already exist
-- (migrations 029/039/040/041) -- this file only extends/replaces them.
-- This file's own statement order: staff_has_permission() extended for
-- audit.view -> list_admin_audit_events() -> refund_issuance_attempts
-- (table) -> begin_refund_issuance_attempt() -> complete_refund_
-- issuance_attempt() -> fail_refund_issuance_attempt() ->
-- review_book_report() (audit insert added) -> review_refund_request()
-- (audit insert added) -> indexes.
--
-- Migrations 040 and 041 are immutable (already production-applied) and
-- are not modified by this file in any way.

-- ============================================================
-- Part 1: audit.view -- extends staff_has_permission()'s existing
-- 'admin' branch only. owner is unconditionally true already (no change
-- needed); moderator/support/editor get no new branch, so
-- staff_has_permission('audit.view') already returns false for them by
-- construction, exactly like every other permission they don't hold.
-- This is a CREATE OR REPLACE on staff_has_permission()'s existing,
-- unchanged signature -- its own revoke-all-then-grant-execute-to-
-- authenticated block (migration 040) is preserved automatically and is
-- not repeated here, same convention migration 040 itself already used
-- when it modified review_book_report()/review_refund_request().
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
            'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view'
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
-- Part 2: list_admin_audit_events() -- the ONLY read path for
-- admin_audit_log. Direct SELECT remains denied to anon/authenticated
-- (migration 041's own `revoke all ... from anon, authenticated` already
-- covers this; nothing here grants it back). No RLS SELECT policy is
-- added for the same reason ADMIN-1C Part A recommended against one --
-- this table has no client-facing read path other than this controlled,
-- filtered, paginated RPC.
--
-- Joins ONLY public.profiles, for actor_display_name -- never
-- auth.users, never book_reports/refund_requests/staff_members for
-- target labeling (Part A's own "do not design a huge polymorphic join"
-- recommendation). LEFT JOIN, not JOIN: actor_id is nullable
-- (ON DELETE SET NULL, migration 041) for an actor whose profile has
-- since been deleted -- a LEFT JOIN preserves that audit row (with
-- actor_display_name = null) rather than silently dropping it from the
-- list.
--
-- Validation ordering matches every other RPC in this schema: auth ->
-- permission -> parameter validation -> query. A non-staff caller never
-- reaches the filter-validation logic at all.
--
-- Action/target_type filters are allow-listed, not free text -- Part A's
-- own explicit design choice, re-confirmed here: an unrecognized filter
-- value is a stable, controlled `raise exception`, matching this
-- schema's own established convention for rejecting an invalid enum-like
-- parameter (e.g. add_staff_member_by_email()'s `if new_role not in
-- (...) then raise exception 'invalid role'`) -- never a silently-empty
-- result, which would be indistinguishable from "no rows matched" and
-- could mask a caller-side bug (e.g. a typo'd action string) as an
-- empty audit log.
--
-- Cursor semantics: null/null means "first page". A malformed PARTIAL
-- cursor (exactly one of the pair supplied) is rejected outright --
-- silently treating it as either "first page" or "apply only half the
-- key" would produce ambiguous, unreviewed pagination behavior.
--
-- p_limit is clamped, never trusted verbatim: NULL defaults to 25,
-- anything below 1 is raised to 1, anything above 100 is capped to 100.
--
-- ADMIN-1C PART B PRE-FINALIZE CORRECTION: the action allow-list below
-- uses 'refund.review_rejected', not the earlier draft's
-- 'refund.review_denied' -- the actual domain status refund_requests.
-- status transitions to is 'rejected' (migration 029's own CHECK
-- constraint), so the audit action string now names that exactly,
-- matching review_book_report()'s own 'dismissed'/'report.dismissed'
-- naming discipline (the audit action always mirrors the real status
-- value, never a softer synonym for it).
create or replace function public.list_admin_audit_events(
  p_action text default null,
  p_actor_id uuid default null,
  p_target_type text default null,
  p_created_after timestamptz default null,
  p_created_before timestamptz default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  actor_id uuid,
  actor_display_name text,
  action text,
  target_type text,
  target_id uuid,
  metadata jsonb,
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

  if not public.staff_has_permission('audit.view') then
    raise exception 'not authorized';
  end if;

  if p_action is not null and p_action not in (
    'staff.added', 'staff.role_changed', 'staff.removed',
    'report.resolved', 'report.dismissed',
    'refund.review_approved', 'refund.review_rejected',
    'refund.issuance_submitted'
  ) then
    raise exception 'invalid action filter';
  end if;

  if p_target_type is not null and p_target_type not in (
    'staff_members', 'book_reports', 'refund_requests'
  ) then
    raise exception 'invalid target_type filter';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  if p_created_after is not null and p_created_before is not null
     and p_created_after >= p_created_before then
    raise exception 'invalid date range';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      aal.id,
      aal.actor_id,
      p.display_name as actor_display_name,
      aal.action,
      aal.target_type,
      aal.target_id,
      aal.metadata,
      aal.created_at
    from public.admin_audit_log aal
    left join public.profiles p on p.id = aal.actor_id
    where (p_action is null or aal.action = p_action)
      and (p_actor_id is null or aal.actor_id = p_actor_id)
      and (p_target_type is null or aal.target_type = p_target_type)
      and (p_created_after is null or aal.created_at >= p_created_after)
      and (p_created_before is null or aal.created_at < p_created_before)
      and (
        p_cursor_created_at is null
        or (aal.created_at, aal.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by aal.created_at desc, aal.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from public;
revoke all on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from anon;
revoke all on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- Part 3: refund_issuance_attempts -- PRE-FINALIZE FINANCIAL DURABILITY
-- CORRECTION. This is the actual fix, not a cosmetic addition.
--
-- The first draft of this migration wrote the refund.issuance_submitted
-- audit event ONLY after stripe.refunds.create() had already resolved
-- successfully -- correct for never logging a false success, but it left
-- a real durability gap: if Stripe accepts the refund and then the
-- application process dies, or the post-Stripe audit-write call itself
-- fails, Librum is left with NO durable record of which human staff
-- member initiated that external financial side effect at all. The
-- Stripe idempotency key already prevents a DUPLICATE Stripe operation,
-- but duplicate-prevention is a different property from durability --
-- neither the idempotency key nor the (already-committed, unrelated)
-- admin_audit_log partial unique index on stripe_refund_id can recover
-- "who clicked this" if the write recording that fact never lands.
--
-- The fix: a narrow, durable, actor-attributed row is committed to THIS
-- table BEFORE the Stripe call is ever made (begin_refund_issuance_
-- attempt() below), carrying exactly the deterministic idempotency key
-- that will also be sent to Stripe. If everything downstream succeeds,
-- complete_refund_issuance_attempt() transitions it to 'submitted' and
-- writes the admin_audit_log event, atomically, in one transaction. If
-- Stripe returns an immediate failed/canceled status,
-- fail_refund_issuance_attempt() marks it 'failed'. If Stripe THROWS
-- (a transport/API exception), the same function marks it 'unknown', not
-- 'failed' -- see the status-model comment on the table below, and Part 6
-- for why this distinction is load-bearing, not cosmetic. If the
-- completion call itself fails after a genuine Stripe success, the row is
-- left exactly as it was ('initiated') -- not silently discarded, not
-- fabricated as complete -- so a human can reconcile using attempt id,
-- refund_request_id, actor_id, idempotency_key, and created_at, exactly
-- the fields Part B's own correction brief requires to remain
-- inspectable.
--
-- This is deliberately OPERATIONAL/RECOVERY state, not a second audit
-- log: it is never read through list_admin_audit_events(), carries no
-- browser-facing display concept, and (unlike admin_audit_log) its rows
-- are actively UPDATED as an attempt progresses -- admin_audit_log
-- itself remains append-only and untouched by this table's existence.
--
-- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION: refund_request_id
-- is now `on delete restrict`, not the earlier draft's `on delete
-- cascade`. This table is financial operational/recovery EVIDENCE -- a
-- record of who initiated a real external Stripe call and with which
-- idempotency key -- and must not silently vanish merely because its
-- parent refund_requests row is later deleted. Nothing in this schema
-- currently deletes refund_requests rows in ordinary operation (they are
-- only ever transitioned between statuses), so RESTRICT costs nothing in
-- practice and only prevents an accidental future deletion from quietly
-- erasing evidence that a real refund attempt happened. (Historical note:
-- refund_request_items' own `on delete cascade` precedent, migration 029,
-- was correct for ITS purpose -- pure line-item detail with no
-- independent evidentiary value -- but does not apply here.)
--
-- actor_id: on delete set null, identical treatment to admin_audit_log.
-- actor_id and staff_members.created_by -- a historical/operational
-- reference, not a live grant; the row must survive the actor's own
-- account being deleted later. Unchanged by this correction.
--
-- No email, payment-method, card, billing, raw Stripe payload, secret,
-- or other customer PII column exists here or anywhere in this table --
-- only the fields explicitly required for attribution and reconciliation.
--
-- STRIPE-REFUND IDENTITY: ADMIN-1C PART B FINAL FINANCIAL INVARIANT
-- CORRECTION adds a second uniqueness guarantee below (see the
-- stripe_refund_id partial unique index, after the table DDL): exactly
-- ONE attempt row may ever claim a given non-null stripe_refund_id. The
-- earlier draft only enforced this at the audit-log layer (a partial
-- unique index on admin_audit_log.metadata->>'stripe_refund_id') --
-- correct for preventing a duplicate AUDIT ROW, but it said nothing about
-- whether two DIFFERENT attempt rows could both durably claim to own the
-- same real external Stripe refund object, which is the actual identity
-- fact that matters for reconciliation. Three distinct uniqueness layers
-- now exist, deliberately kept separate because they guard three
-- distinct things:
--   1. ATTEMPT-IDENTITY uniqueness (idempotency_key, below) -- the same
--      deterministic key always resolves to the same attempt ROW.
--   2. EXTERNAL STRIPE-REFUND IDENTITY uniqueness (stripe_refund_id,
--      below) -- a given real Stripe refund object may be CLAIMED
--      (transitioned to 'submitted') by at most one attempt row.
--   3. AUDIT-EVENT uniqueness (admin_audit_log's own partial unique
--      index, Part 9) -- at most one refund.issuance_submitted row may
--      ever reference a given stripe_refund_id, now a tertiary backstop
--      behind both of the above.
-- ============================================================

create table public.refund_issuance_attempts (
  id uuid primary key default gen_random_uuid(),
  refund_request_id uuid not null references public.refund_requests(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete set null,
  idempotency_key text not null,
  stripe_refund_id text,
  stripe_status text,
  -- Status model: exactly FOUR states -- ADMIN-1C PART B FINAL FINANCIAL
  -- INVARIANT CORRECTION adds 'unknown', distinguishing a CONFIRMED
  -- outcome from an AMBIGUOUS one, matching exactly what this flow can
  -- actually observe --
  --   'initiated' -- begin_refund_issuance_attempt() has durably
  --     recorded that a staff member is about to call Stripe with this
  --     exact idempotency key. This is the row that exists BEFORE the
  --     external call, and is what makes recovery possible if nothing
  --     after this point ever lands.
  --   'submitted' -- complete_refund_issuance_attempt() has confirmed
  --     Stripe accepted the refund (a non-terminal-failure resolved
  --     status) and recorded stripe_refund_id/stripe_status. Terminal,
  --     successful, CONFIRMED.
  --   'failed' -- fail_refund_issuance_attempt() has recorded that Stripe
  --     returned an immediate failed/canceled status for THIS specific
  --     attempt -- a resolved API response Librum actually received and
  --     can act on. Terminal, unsuccessful, CONFIRMED.
  --   'unknown' -- fail_refund_issuance_attempt() has recorded that the
  --     stripe.refunds.create() call THREW (a transport/API exception)
  --     rather than resolving. This is deliberately NOT 'failed': a
  --     thrown exception can occur AFTER Stripe has already accepted an
  --     idempotent request but BEFORE Librum received the response (a
  --     timeout, a dropped connection, a 5xx after the fact) -- Librum
  --     genuinely does not know whether a real Stripe refund now exists
  --     for this idempotency key. Recording 'failed' here would overstate
  --     what is known and could wrongly suggest it's safe to disregard;
  --     'unknown' instead flags the row for reconciliation using the SAME
  --     Stripe idempotency-key/live-refund lookup logic
  --     (determineRefundAttempt(), issue-refund.ts) that already gates
  --     every retry -- see that function's own comment for why an
  --     'unknown' LOCAL status never by itself authorizes a fresh
  --     external Stripe call. NOT terminal, deliberately -- unlike
  --     'submitted'/'failed', an 'unknown' row is a RECOVERABLE dead
  --     end, not a permanent one: see the ADMIN-1C PART B UNKNOWN-STATE
  --     RECOVERY CORRECTION note below.
  --
  -- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION: the complete
  -- state machine, exactly as enforced by complete_refund_issuance_
  -- attempt()'s and fail_refund_issuance_attempt()'s own guarded UPDATEs
  -- (`where status in (...)`) --
  --   initiated -> submitted | failed | unknown
  --   unknown   -> submitted | failed | unknown
  --   submitted -> (terminal -- no further transitions, ever)
  --   failed    -> (terminal -- no further transitions, ever)
  -- A genuine retry after 'unknown' reuses the SAME durable row (the SAME
  -- deterministic idempotency key resolves back to it via
  -- begin_refund_issuance_attempt()'s own idempotency_key uniqueness) --
  -- unlike a genuine retry after 'failed', which always uses a NEW
  -- deterministic key (buildRetryIdempotencyKey(), issue-refund.ts) and
  -- therefore always creates a genuinely NEW row. This is the correct,
  -- deliberate asymmetry: 'failed' means Stripe gave a definitive answer
  -- for that specific attempt, so a retry is a NEW attempt; 'unknown'
  -- means Stripe never gave an answer for THIS attempt at all, so a
  -- retry using the identical idempotency key is still resolving the
  -- SAME original attempt -- reusing the row (rather than minting a new
  -- one) is what keeps the durable actor/timestamp attribution intact
  -- across the eventual resolution, and is exactly what Stripe's own
  -- idempotency-key contract already assumes ("the same key always means
  -- the same operation").
  -- Explicitly NOT a replacement for refund_requests.status/refunded_at,
  -- which remains the Stripe webhook's sole, unchanged, authoritative
  -- source for whether a refund actually SETTLED (see
  -- src/app/api/webhooks/stripe/route.ts's processChargeRefund) --
  -- 'submitted' here means only "Stripe accepted the attempt," the exact
  -- same distinction issue-refund.ts's own REFUND_SUBMITTED_SUCCESS_MESSAGE
  -- has always drawn for the admin-facing UI.
  status text not null default 'initiated'
    check (status in ('initiated', 'submitted', 'failed', 'unknown')),
  -- A short, safe, non-sensitive code only -- never the raw Stripe error
  -- message (which can be arbitrarily detailed/unbounded and is already
  -- logged server-side via console.error at the TypeScript call site,
  -- same posture as STRIPE_REFUND_ERROR_MESSAGE's own existing
  -- "never surfaced, only console.error'd" treatment of raw Stripe
  -- exceptions). The vocabulary itself is unchanged by this correction --
  -- 'stripe_error' still means "the create() call threw" -- what changed
  -- is which STATUS that reason now maps to (see
  -- fail_refund_issuance_attempt() below): 'stripe_error' -> 'unknown'
  -- (ambiguous), 'immediate_failed'/'immediate_canceled' -> 'failed'
  -- (confirmed).
  failure_reason text
    check (failure_reason is null or failure_reason in ('stripe_error', 'immediate_failed', 'immediate_canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Attempt-identity idempotency (uniqueness layer 1 of 3 -- see this
-- table's own header comment above for the full three-layer model):
-- the SAME deterministic idempotency key must resolve to the SAME
-- durable attempt row, however many times begin_refund_issuance_
-- attempt() is called for it (a double-click, a retried Server Action,
-- two concurrent admin tabs). Global uniqueness on idempotency_key
-- alone is correct and sufficient here -- the key already embeds the
-- refund_request_id by construction (buildRefundIdempotencyKey()/
-- buildRetryIdempotencyKey(), issue-refund.ts), so two DIFFERENT refund
-- requests can never collide on this constraint.
create unique index refund_issuance_attempts_idempotency_key_idx
  on public.refund_issuance_attempts (idempotency_key);

-- External Stripe-refund identity (uniqueness layer 2 of 3): at most one
-- attempt row may ever CLAIM a given real, non-null Stripe refund object.
-- Partial (where stripe_refund_id is not null) because every row starts
-- with a null stripe_refund_id (set only by complete_refund_issuance_
-- attempt() once Stripe has actually responded) -- a plain non-partial
-- unique index would incorrectly treat every not-yet-submitted row as
-- colliding on NULL (though Postgres itself already treats multiple NULLs
-- as non-equal for uniqueness purposes, the partial form is kept anyway
-- to make the intent -- "only claimed rows are constrained" -- explicit
-- and to avoid the index ever indexing the common not-yet-claimed case at
-- all). Enforced at the exact point of claim inside
-- complete_refund_issuance_attempt() -- see that function's own comment
-- for the controlled-failure behavior when a second attempt collides.
create unique index refund_issuance_attempts_stripe_refund_id_idx
  on public.refund_issuance_attempts (stripe_refund_id)
  where stripe_refund_id is not null;

-- Operational/reconciliation lookup: "every attempt for this refund
-- request," the exact query a human would run to investigate the
-- post-Stripe-DB-failure condition Part 9 of the correction brief
-- describes.
create index refund_issuance_attempts_refund_request_id_idx
  on public.refund_issuance_attempts (refund_request_id);

alter table public.refund_issuance_attempts enable row level security;

-- Same locked-down posture as admin_audit_log: no SELECT/INSERT/UPDATE/
-- DELETE grant to anon or authenticated, RLS enabled with zero policies
-- (belt-and-suspenders -- even a role that somehow held a table grant
-- would see/affect nothing). All access is through the three narrow
-- SECURITY DEFINER RPCs below. No /admin UI reads this table in
-- ADMIN-1C at all.
revoke all on public.refund_issuance_attempts from anon, authenticated;

-- ============================================================
-- Part 4: begin_refund_issuance_attempt() -- MUST be called, and MUST
-- durably commit, before the caller ever invokes stripe.refunds.create().
-- This ordering is enforced at the TypeScript call site
-- (executeApprovedRefund(), src/app/admin/(protected)/refunds/
-- issue-refund.ts), not here -- this function has no way to prevent a
-- caller from ignoring its own return value, but it is the ONLY
-- supported path that produces a valid attempt id, and the completion/
-- fail RPCs below both require one that actually exists.
--
-- refund_requests.status must currently be 'approved' -- same business
-- gate executeApprovedRefund() itself already independently re-checks
-- via its own read; this RPC re-derives it a second time rather than
-- trusting the caller, matching this schema's universal "never trust
-- client-supplied state" discipline.
--
-- Idempotency/concurrency: `on conflict (idempotency_key) do nothing`
-- against the unique index above, falling back to SELECTing the
-- already-existing row's id when the insert is a no-op. Two concurrent
-- calls with the SAME key (a double-click, two admin tabs, a retried
-- Server Action) therefore always resolve to the SAME attempt identity
-- -- exactly the same guarantee Stripe's own idempotency-key contract
-- provides for the external call this attempt row precedes. A GENUINE
-- retry after a failed/canceled Stripe attempt uses a NEW deterministic
-- key (buildRetryIdempotencyKey(), issue-refund.ts) and therefore always
-- creates a genuinely NEW row here -- this table never blocks a
-- legitimate second attempt, only collapses duplicate identities for
-- the identical one.
-- ============================================================

create or replace function public.begin_refund_issuance_attempt(
  p_refund_request_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_status text;
  v_attempt_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  select status into v_status from public.refund_requests where id = p_refund_request_id;
  if v_status is null then
    raise exception 'refund request not found';
  end if;
  if v_status <> 'approved' then
    raise exception 'refund request is not approved';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'invalid idempotency key';
  end if;

  insert into public.refund_issuance_attempts (refund_request_id, actor_id, idempotency_key, status)
  values (p_refund_request_id, v_actor_id, p_idempotency_key, 'initiated')
  on conflict (idempotency_key) do nothing
  returning id into v_attempt_id;

  if v_attempt_id is null then
    select id into v_attempt_id
    from public.refund_issuance_attempts
    where idempotency_key = p_idempotency_key;
  end if;

  return v_attempt_id;
end;
$$;

revoke all on function public.begin_refund_issuance_attempt(uuid, text) from public;
revoke all on function public.begin_refund_issuance_attempt(uuid, text) from anon;
revoke all on function public.begin_refund_issuance_attempt(uuid, text) from authenticated;
grant execute on function public.begin_refund_issuance_attempt(uuid, text) to authenticated;

-- ============================================================
-- Part 5: complete_refund_issuance_attempt() -- called only after a
-- GENUINE new Stripe refund attempt has resolved without throwing, with
-- a non-terminal-failure status (see issue-refund.ts's own call site for
-- the exact condition this must follow -- unchanged from the first
-- draft's own equivalent condition, just relocated onto this attempt-
-- scoped function).
--
-- Ownership invariant: the caller must be the SAME actor who began the
-- attempt (attempt.actor_id = auth.uid()) -- chosen specifically because
-- the entire point of this table is per-actor accountability for one
-- specific button click; there is no legitimate scenario in the current
-- product where a different staff member should be able to complete
-- someone else's in-flight attempt, and allowing it would let one
-- staff member's action get attributed to another's audit trail. Kept
-- unchanged for V1 by ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION's
-- own explicit instruction -- retry-from-'unknown' recovery already works
-- under this same restriction, since the normal path is the SAME staff
-- member re-clicking "Issue refund" after a transient failure, not a
-- different one resolving it on their behalf.
--
-- DEFERRED (explicitly out of scope for this correction, NOT built here):
-- an 'unknown' attempt whose initiating actor later becomes unavailable
-- (removed as staff, account deleted) has no recovery path under this
-- ownership invariant -- actor_id on delete set null (see the table's own
-- header comment) means attempt.actor_id could become NULL, and
-- `v_attempt_actor_id is distinct from v_actor_id` would then reject
-- EVERY caller, including an owner, from ever completing or failing that
-- row. This is a genuine, currently-unhandled operational gap -- tracked
-- as FIN-OPS-1 (Refund issuance reconciliation): a future, explicitly
-- privileged (e.g. owner-only, or a dedicated new permission) mechanism
-- to resolve an orphaned 'unknown' attempt would be required to close it.
-- No such mechanism exists yet, and none is added by this correction.
--
-- Transition: 'initiated' -> 'submitted' OR 'unknown' -> 'submitted',
-- exactly once -- guarded by `where status in ('initiated', 'unknown')`
-- on the UPDATE, identical in spirit to review_book_report()/
-- review_refund_request()'s own `where status = '...'` concurrency
-- guards. A repeat completion call for an already-'submitted' attempt
-- (e.g. a retried Server Action after the first call actually succeeded
-- but the caller never saw the response) is a safe, silent no-op --
-- v_updated_id stays null and the function simply returns, writing no
-- second audit row. An already-'failed' attempt is likewise never
-- reopened -- neither 'submitted' nor 'failed' appears in the guard's
-- `in (...)` list, so both terminal states are structurally protected
-- from this UPDATE ever touching them again, with no separate check
-- needed.
--
-- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION: 'unknown' is now
-- accepted as a second valid starting state, alongside 'initiated'. Root
-- issue this fixes: a Stripe transport/API exception moves an attempt to
-- 'unknown' (see fail_refund_issuance_attempt() below) precisely because
-- Librum could not confirm what happened -- but a SUBSEQUENT retry using
-- the SAME deterministic idempotency key (begin_refund_issuance_attempt()
-- resolves it back to this exact same durable row, never a new one) can
-- absolutely produce a definitive resolved Stripe response. Without this
-- change, 'unknown' would be a dead end: this RPC's own guard would
-- reject the completion of a row it is EXACTLY the recovery mechanism
-- for. The full state machine (see the table's own header comment, and
-- fail_refund_issuance_attempt()'s below, for the complete picture):
--   initiated -> submitted | failed | unknown
--   unknown   -> submitted | failed | unknown
--   submitted -> (terminal, no further transitions)
--   failed    -> (terminal, no further transitions)
--
-- Atomicity: the attempt UPDATE and the admin_audit_log INSERT are one
-- PL/pgSQL function body, one transaction -- they succeed or fail
-- together, the same "succeed together or fail together" guarantee
-- review_book_report()/review_refund_request() themselves already have.
--
-- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION: this function now
-- ALSO enforces uniqueness layer 2 (external Stripe-refund identity, see
-- the table's own header comment) -- the UPDATE that stamps
-- stripe_refund_id onto this attempt is wrapped in its own exception
-- handler for unique_violation against refund_issuance_attempts_
-- stripe_refund_id_idx. If a DIFFERENT attempt has already claimed this
-- exact stripe_refund_id (a scenario that should never arise given each
-- attempt's own idempotency_key uniqueness, but is not assumed away),
-- this function raises a controlled, clearly-worded exception rather than
-- silently letting the collision through -- the calling attempt is left
-- exactly as it was (still 'initiated'), never falsely marked
-- 'submitted', and no audit row is written for it. This is a genuine
-- collision-rejection, not a harmless duplicate: at most one attempt may
-- ever own a given real Stripe refund object.
--
-- The admin_audit_log INSERT is separately wrapped in its own exception
-- handler for unique_violation against the pre-existing partial unique
-- index on metadata->>'stripe_refund_id' -- see that index's own comment
-- (Part 9 below) for why this is now a TERTIARY backstop, behind both the
-- attempt table's own 'initiated'/'unknown' UPDATE guard (primary,
-- duplicate-completion prevention) and the stripe_refund_id claim check
-- immediately above (secondary, cross-attempt collision prevention).
-- ============================================================

create or replace function public.complete_refund_issuance_attempt(
  p_attempt_id uuid,
  p_stripe_refund_id text,
  p_stripe_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_attempt_actor_id uuid;
  v_refund_request_id uuid;
  v_updated_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  select actor_id, refund_request_id into v_attempt_actor_id, v_refund_request_id
  from public.refund_issuance_attempts
  where id = p_attempt_id;

  if v_refund_request_id is null then
    raise exception 'refund issuance attempt not found';
  end if;

  if v_attempt_actor_id is distinct from v_actor_id then
    raise exception 'not authorized';
  end if;

  if p_stripe_refund_id is null or length(trim(p_stripe_refund_id)) = 0 then
    raise exception 'invalid stripe refund id';
  end if;

  if p_stripe_status is null or p_stripe_status not in ('pending', 'requires_action', 'succeeded') then
    raise exception 'invalid stripe status';
  end if;

  begin
    update public.refund_issuance_attempts
    set status = 'submitted',
        stripe_refund_id = p_stripe_refund_id,
        stripe_status = p_stripe_status,
        updated_at = pg_catalog.now()
    where id = p_attempt_id
      and status in ('initiated', 'unknown')
    returning id into v_updated_id;
  exception when unique_violation then
    -- Uniqueness layer 2 (external Stripe-refund identity) tripped: a
    -- DIFFERENT attempt already owns this exact stripe_refund_id. This
    -- attempt is left untouched (still whatever it was -- 'initiated' or
    -- 'unknown') -- controlled failure, not a silent no-op and not a
    -- falsely-claimed 'submitted'.
    raise exception 'stripe refund id already claimed by another attempt';
  end;

  if v_updated_id is null then
    -- Already submitted -- safe no-op, see this function's own header
    -- comment. Never re-raise, never write a second audit row.
    return;
  end if;

  begin
    insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
    values (
      v_actor_id,
      'refund.issuance_submitted',
      'refund_requests',
      v_refund_request_id,
      jsonb_build_object('stripe_refund_id', p_stripe_refund_id, 'stripe_status', p_stripe_status)
    );
  exception when unique_violation then
    null;
  end;
end;
$$;

revoke all on function public.complete_refund_issuance_attempt(uuid, text, text) from public;
revoke all on function public.complete_refund_issuance_attempt(uuid, text, text) from anon;
revoke all on function public.complete_refund_issuance_attempt(uuid, text, text) from authenticated;
grant execute on function public.complete_refund_issuance_attempt(uuid, text, text) to authenticated;

-- ============================================================
-- Part 6: fail_refund_issuance_attempt() -- called when Stripe throws, or
-- returns an immediate failed/canceled status, for a specific attempt.
-- Best-effort operational bookkeeping, not a business invariant: never
-- writes an admin_audit_log row (neither a failure nor an ambiguous
-- outcome is a "staff decision" event in the sense the rest of this
-- table records), and a repeat/racing call against an already-terminal
-- ('submitted' or 'failed') attempt is a silent no-op rather than an
-- error -- the caller's own outcome to the admin is already decided by
-- this point (a safe, generic stripe_error message), and this call must
-- never introduce a SECOND failure mode on top of the real one.
--
-- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION: this function no
-- longer maps every call to status = 'failed' unconditionally. A thrown
-- stripe.refunds.create() call (p_failure_reason = 'stripe_error') proves
-- only that Librum did not receive a resolved response -- NOT that Stripe
-- never processed the request. Reporting 'failed' for that case would
-- overstate what is known, since the underlying idempotent request may
-- have already succeeded on Stripe's side. p_failure_reason is therefore
-- mapped to the resulting status:
--   'immediate_failed'   -> status = 'failed'   (a resolved API response
--                            Librum actually observed: CONFIRMED failure)
--   'immediate_canceled' -> status = 'failed'   (same: CONFIRMED)
--   'stripe_error'        -> status = 'unknown'  (no resolved response:
--                            AMBIGUOUS, not confirmed either way)
--   null                  -> status = 'unknown'  (the safest default when
--                            no specific reason is even supplied)
-- The failure_reason CODE itself is unchanged/preserved verbatim in every
-- case -- only the resulting STATUS differs. See the table's own header
-- comment for the full status vocabulary and why 'unknown' rows are
-- reconciled via Stripe's own live-refund lookup, never assumed safe to
-- retry over merely because the local row says 'unknown'.
--
-- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION: 'unknown' is now
-- also a valid STARTING state for this function, not only a possible
-- resulting one -- the guarded UPDATE below matches
-- `status in ('initiated', 'unknown')`, identical in spirit to
-- complete_refund_issuance_attempt()'s own recovery guard (see that
-- function's own comment for the full root-cause reasoning: without this,
-- 'unknown' would be a dead end no retry could ever resolve). This makes
-- three recovery paths possible from an 'unknown' row, all exercised by
-- this function alone:
--   unknown -> failed   (a retry's Stripe call now resolves definitively
--                         to immediate_failed/immediate_canceled)
--   unknown -> unknown  (a retry's Stripe call throws AGAIN -- still no
--                         resolved response; failure_reason is
--                         overwritten with the latest observation, but
--                         the status itself does not change)
-- (the third path, unknown -> submitted, is complete_refund_issuance_
-- attempt()'s own, not this function's.) A 'submitted' or 'failed'
-- attempt is NEVER matched by this guard -- both terminal states are
-- structurally protected from ever being downgraded back to 'unknown' by
-- a stray or racing fail call, with no separate check required.
--
-- Same ownership invariant as complete_refund_issuance_attempt() above,
-- for the same reason.
-- ============================================================

create or replace function public.fail_refund_issuance_attempt(
  p_attempt_id uuid,
  p_failure_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_attempt_actor_id uuid;
  v_target_status text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  select actor_id into v_attempt_actor_id
  from public.refund_issuance_attempts
  where id = p_attempt_id;

  if not found then
    raise exception 'refund issuance attempt not found';
  end if;

  if v_attempt_actor_id is distinct from v_actor_id then
    raise exception 'not authorized';
  end if;

  if p_failure_reason is not null
     and p_failure_reason not in ('stripe_error', 'immediate_failed', 'immediate_canceled') then
    raise exception 'invalid failure reason';
  end if;

  -- KNOWN FAILURE vs. UNKNOWN EXTERNAL OUTCOME -- see this function's own
  -- header comment. Only a resolved API response Librum actually observed
  -- (immediate_failed/immediate_canceled) counts as a confirmed failure;
  -- a thrown call (stripe_error) or no reason at all is ambiguous.
  v_target_status := case p_failure_reason
    when 'immediate_failed' then 'failed'
    when 'immediate_canceled' then 'failed'
    else 'unknown'
  end;

  update public.refund_issuance_attempts
  set status = v_target_status,
      failure_reason = p_failure_reason,
      updated_at = pg_catalog.now()
  where id = p_attempt_id
    and status in ('initiated', 'unknown');
  -- Deliberately no check on whether this UPDATE matched a row -- if the
  -- attempt already reached 'submitted' or 'failed' by the time this
  -- runs (a race with a concurrent completion call, extremely unlikely
  -- in practice but not impossible), leaving it as-is is correct: this
  -- function's caller has already decided to report a failure to the
  -- admin based on its OWN observation of the Stripe call, and must
  -- never raise here on top of that.
end;
$$;

revoke all on function public.fail_refund_issuance_attempt(uuid, text) from public;
revoke all on function public.fail_refund_issuance_attempt(uuid, text) from anon;
revoke all on function public.fail_refund_issuance_attempt(uuid, text) from authenticated;
grant execute on function public.fail_refund_issuance_attempt(uuid, text) to authenticated;

-- ============================================================
-- Part 7: audit-event insertion for review_book_report(). CREATE OR
-- REPLACE on its existing, unchanged signature -- authorization/business
-- logic is byte-for-byte identical to migration 040's own version; only
-- one insert statement is added, immediately after the UPDATE's own
-- success check and before the function returns, inside the same
-- implicit transaction. A failed/stale/no-op review (the UPDATE matches
-- zero rows, or an earlier validation already raised) never reaches the
-- insert at all. Grants are preserved automatically by CREATE OR REPLACE
-- on an unchanged signature and are not repeated here, matching
-- migration 040's own precedent when it performed this exact kind of
-- edit to this same function.
-- ============================================================

create or replace function public.review_book_report(
  p_id uuid,
  p_decision text,
  p_admin_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_updated_id uuid;
  v_notes_added boolean;
begin
  v_admin_id := auth.uid();
  if v_admin_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('resolved', 'dismissed') then
    raise exception 'p_decision must be ''resolved'' or ''dismissed''';
  end if;

  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  v_notes_added := nullif(trim(coalesce(p_admin_notes, '')), '') is not null;

  update public.book_reports
  set status = p_decision,
      reviewed_at = pg_catalog.now(),
      reviewed_by = v_admin_id,
      admin_notes = nullif(trim(coalesce(p_admin_notes, '')), '')
  where id = p_id
    and status = 'open'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no reviewable report found for this id';
  end if;

  -- ADMIN-1C Part B: audit event. Only old_status/new_status/notes_added
  -- -- never the report reason, reporter identity, or admin_notes text
  -- itself (Part A's own explicit "do not duplicate full report text or
  -- long staff notes" principle).
  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_admin_id,
    case p_decision when 'resolved' then 'report.resolved' else 'report.dismissed' end,
    'book_reports',
    p_id,
    jsonb_build_object('old_status', 'open', 'new_status', p_decision, 'notes_added', v_notes_added)
  );
end;
$$;

-- ============================================================
-- Part 8: audit-event insertion for review_refund_request(). Same
-- treatment as Part 7. This is the internal STAFF DECISION (approve/
-- reject) only -- it never touches Stripe. The separate external
-- side-effect event (refund.issuance_submitted) is recorded by
-- complete_refund_issuance_attempt() above, from a different call site,
-- at a different (later, possibly never-reached) moment.
--
-- ADMIN-1C PART B PRE-FINALIZE CORRECTION: the audit action for a
-- rejection is now 'refund.review_rejected', matching
-- refund_requests.status's own actual value ('rejected', migration
-- 029's CHECK constraint) -- the first draft used 'refund.review_denied',
-- a softer synonym that didn't match the real domain status anywhere
-- else in this schema.
-- ============================================================

create or replace function public.review_refund_request(
  p_id uuid,
  p_decision text,
  p_admin_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_updated_id uuid;
  v_notes_added boolean;
begin
  v_admin_id := auth.uid();
  if v_admin_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'p_decision must be ''approved'' or ''rejected''';
  end if;

  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  v_notes_added := nullif(trim(coalesce(p_admin_notes, '')), '') is not null;

  update public.refund_requests
  set status = p_decision,
      reviewed_at = pg_catalog.now(),
      reviewed_by = v_admin_id,
      admin_notes = nullif(trim(coalesce(p_admin_notes, '')), '')
  where id = p_id
    and status = 'requested'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no reviewable refund request found for this id';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_admin_id,
    case p_decision when 'approved' then 'refund.review_approved' else 'refund.review_rejected' end,
    'refund_requests',
    p_id,
    jsonb_build_object('old_status', 'requested', 'new_status', p_decision, 'notes_added', v_notes_added)
  );
end;
$$;

-- ============================================================
-- Part 9: indexes.
--
-- admin_audit_log (created_at desc, id desc): supports keyset
-- pagination -- every list_admin_audit_events() call, filtered or not,
-- orders and paginates on this exact pair. Unchanged, retained.
--
-- admin_audit_log (action, created_at desc): RE-EVALUATED per the
-- correction brief. Retained: `action` is one of the four required V1
-- filters (ADMIN-1C Part A's own filter design), so this directly
-- supports a stated, real query shape (an action-filtered, newest-first
-- listing) rather than a speculative one -- without it, that filtered
-- query would need a full-table sort at any real row count. Not removed.
--
-- admin_audit_log ((metadata ->> 'stripe_refund_id')) partial unique,
-- where action = 'refund.issuance_submitted': RETAINED as a TERTIARY
-- backstop (see complete_refund_issuance_attempt()'s own comment). Three
-- distinct uniqueness layers now exist, guarding three distinct things,
-- from primary to tertiary:
--   1. PRIMARY: complete_refund_issuance_attempt()'s own `where status =
--      'initiated'` UPDATE guard (attempt-level idempotency) -- prevents
--      a repeat completion of the SAME attempt from writing a second
--      audit row.
--   2. SECONDARY: refund_issuance_attempts_stripe_refund_id_idx (Part 3
--      above) -- prevents a DIFFERENT attempt from claiming a
--      stripe_refund_id another attempt already owns, enforced at the
--      point of claim with a controlled exception, not a silent no-op.
--   3. TERTIARY: this index -- guards the audit table's OWN row
--      uniqueness directly, in case layers 1/2 were ever somehow
--      bypassed (e.g. a future direct SQL patch). Costs nothing to keep
--      as defense-in-depth at the audit-table layer specifically.
-- These are deliberately three DISTINCT layers: attempt-identity
-- idempotency (Part 3's unique index on idempotency_key) is a FOURTH,
-- separate concept again (which attempt ROW a given CLICK resolves to,
-- not which Stripe refund a given ATTEMPT may claim).
--
-- refund_issuance_attempts indexes: see Part 3 above (idempotency_key
-- unique, stripe_refund_id unique where not null, refund_request_id for
-- reconciliation lookups) -- not repeated here.
-- ============================================================

create index admin_audit_log_created_at_id_idx
  on public.admin_audit_log (created_at desc, id desc);

create index admin_audit_log_action_created_at_idx
  on public.admin_audit_log (action, created_at desc);

create unique index admin_audit_log_refund_issuance_stripe_id_idx
  on public.admin_audit_log ((metadata ->> 'stripe_refund_id'))
  where action = 'refund.issuance_submitted';
