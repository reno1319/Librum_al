-- Committed SQL regression suite for migration 036 (LAUNCH-1 P1-8:
-- lost-dispute author-transfer recovery -- durable transfer-reversal
-- state on payment_disputes and the reconciliation index).
--
-- LAUNCH-1 P2-2 correction: this file's original Part 5 functionally
-- and privilege-tested lost_disputed_payment_intents(), the batched
-- Sales-dashboard helper migration 036 introduced. Migration 037
-- (supabase/migrations/037_narrow_lost_dispute_rpc_privileges.sql)
-- drops that function outright -- its arbitrary-payment-intent-id
-- signature was an unnecessary privilege surface, replaced by the
-- zero-argument, auth.uid()-scoped author_lost_disputed_payment_
-- intents(). Migration 036's own SQL is intentionally NOT rewritten
-- (it is a true historical record of what that migration did, and it
-- did grant `authenticated` on that function at the time); this test
-- file's Part 5 is removed instead, since asserting a capability
-- against a function that no longer exists cannot mean anything once
-- migration 037 is applied. The equivalent -- and now stricter --
-- functional and privilege coverage lives in
-- supabase/tests/037_narrow_lost_dispute_rpc_privileges.test.sql.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed. Two equivalent ways to run this:
--
-- (a) Fresh schema.sql (already includes migration 036's final state):
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/036_lost_dispute_transfer_recovery.test.sql
--
-- (b) The current through-035 schema with migration 036 applied on top:
--   createdb librum_test_036
--   psql -d librum_test_036 -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test_036 -f <through-035 schema snapshot>
--   psql -d librum_test_036 -v ON_ERROR_STOP=1 -f supabase/migrations/036_lost_dispute_transfer_recovery.sql
--   psql -d librum_test_036 -v ON_ERROR_STOP=1 -f supabase/tests/036_lost_dispute_transfer_recovery.test.sql
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs -- except the ACL assertions, which read committed
-- privilege state.

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- ============================================================
-- Part 1: table-level ACL for the new columns -- unchanged from
-- migration 035's own posture (no new grants added by this migration),
-- re-verified here so a regression on this migration specifically
-- would be caught, not merely assumed inherited from 035's own suite.
-- ============================================================
do $$
begin
  perform pg_temp.assert(not has_table_privilege('anon', 'public.payment_disputes', 'SELECT'),
    'part1: anon must still have no SELECT on payment_disputes after adding the reversal columns');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.payment_disputes', 'SELECT'),
    'part1: authenticated must still have no SELECT on payment_disputes after adding the reversal columns');
  perform pg_temp.assert(has_table_privilege('service_role', 'public.payment_disputes', 'UPDATE'),
    'part1: service_role must retain UPDATE on payment_disputes (the reconciliation route and the webhook both need it)');
end $$;

-- ============================================================
-- Part 2: column defaults on a brand-new row -- mirrors exactly what
-- processDisputeEvent's own upsert leaves Postgres to fill in (it never
-- sets transfer_reversal_* itself -- see route.ts's own documentation
-- for why overwriting these on every dispute-status refresh would be
-- wrong).
-- ============================================================
do $$
declare
  v_row record;
begin
  insert into public.payment_disputes (
    stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents
  ) values (
    'dp_part2_defaults', 'pi_part2_defaults', 'needs_response', 'fraudulent', 500
  );

  select * into v_row from public.payment_disputes where stripe_dispute_id = 'dp_part2_defaults';

  perform pg_temp.assert(v_row.transfer_reversal_status = 'not_attempted',
    'part2: transfer_reversal_status must default to not_attempted');
  perform pg_temp.assert(v_row.transfer_reversal_attempt_count = 0,
    'part2: transfer_reversal_attempt_count must default to 0');
  perform pg_temp.assert(v_row.stripe_transfer_id is null, 'part2: stripe_transfer_id must default to null');
  perform pg_temp.assert(v_row.stripe_transfer_reversal_id is null,
    'part2: stripe_transfer_reversal_id must default to null');
  perform pg_temp.assert(v_row.transfer_reversal_amount_cents is null,
    'part2: transfer_reversal_amount_cents must default to null');
  perform pg_temp.assert(v_row.transfer_reversal_attempted_at is null,
    'part2: transfer_reversal_attempted_at must default to null');
  perform pg_temp.assert(v_row.transfer_reversal_succeeded_at is null,
    'part2: transfer_reversal_succeeded_at must default to null');
  perform pg_temp.assert(v_row.transfer_reversal_failure_code is null,
    'part2: transfer_reversal_failure_code must default to null');
  perform pg_temp.assert(v_row.transfer_reversal_failure_message is null,
    'part2: transfer_reversal_failure_message must default to null');
end $$;

-- ============================================================
-- Part 3: CHECK constraints.
-- ============================================================
do $$
begin
  begin
    insert into public.payment_disputes (
      stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents, transfer_reversal_status
    ) values (
      'dp_part3_bad_status', 'pi_part3_bad_status', 'lost', 'fraudulent', 500, 'bogus_status'
    );
    perform pg_temp.assert(false, 'part3: an invalid transfer_reversal_status value must be rejected');
  exception when check_violation then
    null;
  end;

  begin
    insert into public.payment_disputes (
      stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents, transfer_reversal_amount_cents
    ) values (
      'dp_part3_negative_amount', 'pi_part3_negative_amount', 'lost', 'fraudulent', 500, -1
    );
    perform pg_temp.assert(false, 'part3: a negative transfer_reversal_amount_cents must be rejected');
  exception when check_violation then
    null;
  end;

  -- transfer_reversal_attempt_count participates in the Stripe
  -- reversal idempotency-key state machine (buildTransferReversal
  -- IdempotencyKey embeds it directly) -- its non-negative invariant is
  -- enforced structurally, the same posture as
  -- transfer_reversal_amount_cents above.
  begin
    insert into public.payment_disputes (
      stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents, transfer_reversal_attempt_count
    ) values (
      'dp_part3_negative_attempt_count', 'pi_part3_negative_attempt_count', 'lost', 'fraudulent', 500, -1
    );
    perform pg_temp.assert(false, 'part3: a negative transfer_reversal_attempt_count must be rejected');
  exception when check_violation then
    null;
  end;

  -- Valid non-negative attempt_count values (including zero and a
  -- realistic multi-retry count) must remain accepted.
  insert into public.payment_disputes (
    stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents, transfer_reversal_attempt_count
  ) values
    ('dp_part3_attempt_count_zero', 'pi_part3_attempt_count_zero', 'lost', 'fraudulent', 500, 0),
    ('dp_part3_attempt_count_positive', 'pi_part3_attempt_count_positive', 'lost', 'fraudulent', 500, 3);

  -- Every documented status value must be accepted (regression check --
  -- the CHECK constraint's own allowed list, restated here so a typo in
  -- the migration would be caught by more than eyeballing the two
  -- files agree).
  insert into public.payment_disputes (
    stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents, transfer_reversal_status
  ) values
    ('dp_part3_ok_1', 'pi_part3_ok_1', 'lost', 'fraudulent', 500, 'not_attempted'),
    ('dp_part3_ok_2', 'pi_part3_ok_2', 'lost', 'fraudulent', 500, 'attempting'),
    ('dp_part3_ok_3', 'pi_part3_ok_3', 'lost', 'fraudulent', 500, 'succeeded'),
    ('dp_part3_ok_4', 'pi_part3_ok_4', 'lost', 'fraudulent', 500, 'failed');
end $$;

-- ============================================================
-- Part 4: the reconciliation index exists with the approved definition
-- -- (transfer_reversal_status, transfer_reversal_attempted_at) where
-- status = 'lost' and transfer_reversal_status in ('attempting',
-- 'failed'). Checked via pg_indexes' own indexdef text rather than
-- merely to_regclass, so a regression to the WHERE clause or column
-- order specifically (not just "an index with this name exists") would
-- be caught.
-- ============================================================
do $$
declare
  v_indexdef text;
begin
  select indexdef into v_indexdef
  from pg_indexes
  where schemaname = 'public' and indexname = 'payment_disputes_needs_reversal_idx';

  perform pg_temp.assert(v_indexdef is not null, 'part4: payment_disputes_needs_reversal_idx must exist');
  perform pg_temp.assert(v_indexdef like '%transfer_reversal_status%transfer_reversal_attempted_at%',
    'part4: index must be composite on (transfer_reversal_status, transfer_reversal_attempted_at) in that order');
  perform pg_temp.assert(v_indexdef like '%WHERE%',
    'part4: index must be a partial index');
  perform pg_temp.assert(v_indexdef like '%status = ''lost''%' or v_indexdef like '%(status = ''lost''::text)%',
    'part4: index predicate must restrict to status = ''lost''');
end $$;

-- ============================================================
-- Part 5: REMOVED (LAUNCH-1 P2-2) -- previously functionally- and
-- privilege-tested lost_disputed_payment_intents(), including an
-- explicit assertion that `authenticated` could call it directly.
-- Migration 037 drops that function; the equivalent, now author-
-- scoped coverage lives in
-- supabase/tests/037_narrow_lost_dispute_rpc_privileges.test.sql
-- instead. See this file's own header comment for the full reasoning.
-- ============================================================

-- ============================================================
-- Part 6: a routine dispute-status upsert (the exact shape
-- processDisputeEvent itself performs) must never clobber existing
-- reversal-recovery state -- the single most important safety property
-- of putting these columns directly on payment_disputes rather than a
-- dedicated table (see the Migration 036 design report).
-- ============================================================
do $$
declare
  v_row record;
begin
  insert into public.payment_disputes (
    stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents,
    transfer_reversal_status, stripe_transfer_id, stripe_transfer_reversal_id,
    transfer_reversal_amount_cents, transfer_reversal_attempt_count, transfer_reversal_succeeded_at
  ) values (
    'dp_part6_upsert_safety', 'pi_part6_upsert_safety', 'lost', 'fraudulent', 500,
    'succeeded', 'tr_part6', 'trr_part6', 400, 1, now()
  );

  -- The exact upsert processDisputeEvent performs on a later
  -- charge.dispute.updated/closed delivery for the SAME dispute --
  -- only status/reason/amount_cents/updated_at are ever in its payload.
  insert into public.payment_disputes (
    stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents, updated_at
  ) values (
    'dp_part6_upsert_safety', 'pi_part6_upsert_safety', 'lost', 'fraudulent', 500, now()
  )
  on conflict (stripe_dispute_id) do update set
    status = excluded.status,
    reason = excluded.reason,
    amount_cents = excluded.amount_cents,
    updated_at = excluded.updated_at;

  select * into v_row from public.payment_disputes where stripe_dispute_id = 'dp_part6_upsert_safety';

  perform pg_temp.assert(v_row.transfer_reversal_status = 'succeeded',
    'part6: a routine dispute-status upsert must NOT reset an already-succeeded reversal');
  perform pg_temp.assert(v_row.stripe_transfer_reversal_id = 'trr_part6',
    'part6: a routine dispute-status upsert must NOT clear the recorded reversal id');
  perform pg_temp.assert(v_row.transfer_reversal_amount_cents = 400,
    'part6: a routine dispute-status upsert must NOT clear the recorded reversal amount');
end $$;

select 'ALL PASSED: 036_lost_dispute_transfer_recovery.test.sql' as result;

rollback;
