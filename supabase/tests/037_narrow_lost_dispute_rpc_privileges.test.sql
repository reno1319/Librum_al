-- Committed SQL regression suite for migration 037 (LAUNCH-1 P2-2:
-- lost-dispute RPC privilege hardening -- removes the arbitrary
-- payment-intent dispute oracle from `authenticated`, replacing
-- lost_disputed_payment_intents(text[]) with the zero-argument,
-- auth.uid()-scoped author_lost_disputed_payment_intents(), and
-- revoking payment_intent_has_lost_dispute(text)'s unused authenticated
-- grant). See the P2-2 audit/design report for the full reasoning.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed. Two equivalent ways to run this:
--
-- (a) Fresh schema.sql (already includes migration 037's final state):
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/037_narrow_lost_dispute_rpc_privileges.test.sql
--
-- (b) The current through-036 schema with migration 037 applied on top:
--   createdb librum_test_037
--   psql -d librum_test_037 -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test_037 -f <through-036 schema snapshot>
--   psql -d librum_test_037 -v ON_ERROR_STOP=1 -f supabase/migrations/037_narrow_lost_dispute_rpc_privileges.sql
--   psql -d librum_test_037 -v ON_ERROR_STOP=1 -f supabase/tests/037_narrow_lost_dispute_rpc_privileges.test.sql
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
-- Part 1: payment_intent_has_lost_dispute(text) -- direct-call denial.
-- Its only legitimate callers are other SECURITY DEFINER functions'
-- own bodies (Part 5 below re-verifies those still work); no session
-- role may call it directly any more.
-- ============================================================
do $$
begin
  set local role authenticated;
  begin
    perform public.payment_intent_has_lost_dispute('pi_anything');
    perform pg_temp.assert(false,
      'part1: authenticated must not be able to call payment_intent_has_lost_dispute directly');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    perform public.payment_intent_has_lost_dispute('pi_anything');
    perform pg_temp.assert(false,
      'part1: anon must not be able to call payment_intent_has_lost_dispute directly');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

-- ============================================================
-- Part 2: lost_disputed_payment_intents(text[]) no longer exists at
-- all -- checked against the catalog directly, not by attempting (and
-- catching a failure from) a call to a name that may not even resolve.
-- ============================================================
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'lost_disputed_payment_intents';

  perform pg_temp.assert(v_count = 0,
    'part2: lost_disputed_payment_intents must not exist in the schema at all');
end $$;

-- ============================================================
-- Part 3: author_lost_disputed_payment_intents() -- signature and
-- direct-call authorization. Zero arguments (pronargs = 0) is itself
-- the guarantee that no caller can supply an arbitrary foreign
-- payment_intent_id -- there is no parameter to supply one through.
-- ============================================================
do $$
declare
  v_pronargs integer;
begin
  select p.pronargs into v_pronargs
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'author_lost_disputed_payment_intents';

  perform pg_temp.assert(v_pronargs = 0,
    'part3: author_lost_disputed_payment_intents must take zero arguments -- no parameter for a caller to supply an arbitrary payment_intent_id through');
end $$;

do $$
begin
  set local role anon;
  begin
    perform public.author_lost_disputed_payment_intents();
    perform pg_temp.assert(false,
      'part3: anon must not be able to call author_lost_disputed_payment_intents');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

-- ============================================================
-- Part 4: functional fixtures -- two authors (A owns two books, one
-- with a lost-disputed purchase and a lost-disputed fulfilled bundle
-- snapshot, one with a clean purchase and an unfulfilled bundle
-- snapshot whose own payment intent is ALSO lost-disputed but must
-- still be excluded), one unrelated author B with his own lost-
-- disputed purchase, one reader, and one author C with no sales at
-- all.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000001', 'p037-author-a@test', '{"role":"author","display_name":"Author A"}'),
  ('a0000000-0000-0000-0000-000000000002', 'p037-author-b@test', '{"role":"author","display_name":"Author B"}'),
  ('a0000000-0000-0000-0000-000000000003', 'p037-reader@test', '{"role":"reader","display_name":"Reader"}'),
  ('a0000000-0000-0000-0000-000000000004', 'p037-author-c@test', '{"role":"author","display_name":"Author C"}');

insert into public.books (id, author_id, title, price_cents, status) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'A''s Lost-Disputed Book', 500, 'published'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'A''s Clean Book', 500, 'published'),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'B''s Lost-Disputed Book', 500, 'published');

insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003', 'cs_p037_a_lost', 'pi_p037_a_lost', 500),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'cs_p037_a_clean', 'pi_p037_a_clean', 500),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'cs_p037_b_lost', 'pi_p037_b_lost', 500);

insert into public.bundle_checkout_snapshots (
  stripe_checkout_session_id, bundle_title, author_id, reader_id,
  bundle_price_cents_at_checkout, total_amount_cents, items,
  protection_expires_at, fulfilled_at, stripe_payment_intent_id
) values (
  'cs_p037_a_bundle_fulfilled', 'A''s Fulfilled Bundle', 'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000003', 900, 900, '[]'::jsonb,
  now() + interval '23 hours', now(), 'pi_p037_a_bundle_lost'
), (
  'cs_p037_a_bundle_unfulfilled', 'A''s Unfulfilled Bundle', 'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000003', 900, null, '[]'::jsonb,
  now() + interval '23 hours', null, 'pi_p037_a_bundle_unfulfilled'
);

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents) values
  ('dp_p037_a_lost', 'pi_p037_a_lost', 'lost', 'fraudulent', 500),
  ('dp_p037_b_lost', 'pi_p037_b_lost', 'lost', 'fraudulent', 500),
  ('dp_p037_a_bundle_lost', 'pi_p037_a_bundle_lost', 'lost', 'fraudulent', 900),
  -- Deliberately also 'lost' -- proves exclusion comes from
  -- fulfilled_at is not null, not merely from an absent dispute row.
  ('dp_p037_a_bundle_unfulfilled', 'pi_p037_a_bundle_unfulfilled', 'lost', 'fraudulent', 900);

-- ============================================================
-- Part 5: author_lost_disputed_payment_intents() -- functional, as
-- each author (RLS/auth.uid()-scoped), not catalog introspection.
-- Covers items 4, 6, 7, 9, 10, 11 from the P2-2 implementation spec in
-- one pass per author.
-- ============================================================
do $$
declare
  v_result text[];
begin
  -- Author A: sees exactly A's own lost-disputed book purchase and A's
  -- own fulfilled bundle snapshot's lost-disputed payment intent --
  -- never B's unrelated one, never the unfulfilled bundle's payment
  -- intent (even though its own dispute is also 'lost'), never the
  -- clean purchase.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select array_agg(stripe_payment_intent_id order by stripe_payment_intent_id) into v_result
  from public.author_lost_disputed_payment_intents();
  reset role;
  perform pg_temp.assert(
    v_result = array['pi_p037_a_bundle_lost', 'pi_p037_a_lost'],
    format('part5: author A expected exactly {pi_p037_a_bundle_lost, pi_p037_a_lost}, got %s', v_result)
  );

  -- Author B: sees only B's own lost-disputed purchase, never A's.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select array_agg(stripe_payment_intent_id) into v_result
  from public.author_lost_disputed_payment_intents();
  reset role;
  perform pg_temp.assert(
    v_result = array['pi_p037_b_lost'],
    format('part5: author B expected exactly {pi_p037_b_lost}, got %s', v_result)
  );

  -- Author C: no purchases, no snapshots at all -- empty result, no
  -- error.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  select array_agg(stripe_payment_intent_id) into v_result
  from public.author_lost_disputed_payment_intents();
  reset role;
  perform pg_temp.assert(v_result is null,
    'part5: an author with no qualifying sales must get an empty result, not an error');
end $$;

-- ============================================================
-- Part 6: user_owns_book() still works through the now-internal
-- payment_intent_has_lost_dispute() helper -- proves the migration's
-- own claim (verified empirically against a disposable local Postgres
-- instance during the P2-2 design audit) that a SECURITY DEFINER
-- function's nested call to a fully-authenticated-revoked helper still
-- succeeds via the shared function owner's own implicit privilege.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  perform pg_temp.assert(
    public.user_owns_book('b0000000-0000-0000-0000-000000000001') = false,
    'part6: a purchase whose payment intent has a lost dispute must NOT count as owned (user_owns_book must still be able to call payment_intent_has_lost_dispute internally)'
  );
  perform pg_temp.assert(
    public.user_owns_book('b0000000-0000-0000-0000-000000000002') = true,
    'part6: a purchase with no dispute at all must still count as owned'
  );
  reset role;
end $$;

-- ============================================================
-- Part 7: create_book_checkout_intent()/finalize_book_checkout_intent()
-- -- the dispute-before-fulfillment guarantee still functions end to
-- end through the now-internal-only helper, and the ordinary
-- undisputed path is completely unaffected.
-- ============================================================
insert into public.books (id, author_id, title, price_cents, status) values
  ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'A''s Fresh Checkout Book', 700, 'published'),
  ('b0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'A''s Fresh Disputed-Intent Book', 700, 'published');

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents) values
  ('dp_p037_finalize_lost', 'pi_p037_finalize_lost', 'lost', 'fraudulent', 700);

do $$
declare
  v_intent record;
  v_outcome record;
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_intent
  from public.create_book_checkout_intent('b0000000-0000-0000-0000-000000000005'::uuid, null);
  reset role;

  select * into v_outcome
  from public.finalize_book_checkout_intent(
    v_intent.intent_id, 'cs_p037_finalize_lost', 'pi_p037_finalize_lost', v_intent.price_cents_at_checkout
  );
  perform pg_temp.assert(v_outcome.outcome = 'blocked_disputed_lost',
    format('part7: expected blocked_disputed_lost for a payment intent already lost-disputed before finalization, got %s', v_outcome.outcome));
end $$;

do $$
declare
  v_intent record;
  v_outcome record;
  v_owns boolean;
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_intent
  from public.create_book_checkout_intent('b0000000-0000-0000-0000-000000000004'::uuid, null);
  reset role;

  select * into v_outcome
  from public.finalize_book_checkout_intent(
    v_intent.intent_id, 'cs_p037_finalize_clean', 'pi_p037_finalize_clean', v_intent.price_cents_at_checkout
  );
  perform pg_temp.assert(v_outcome.outcome = 'eligible_fulfilled',
    format('part7: expected eligible_fulfilled for an ordinary, undisputed checkout, got %s', v_outcome.outcome));

  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select public.user_owns_book('b0000000-0000-0000-0000-000000000004') into v_owns;
  reset role;
  perform pg_temp.assert(v_owns, 'part7: the reader must own the book after an ordinary, undisputed fulfillment');
end $$;

-- ============================================================
-- Part 8: SET search_path = '' remains present on both functions.
-- ============================================================
do $$
declare
  proc record;
begin
  select p.proconfig, p.prosecdef
  into proc
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'payment_intent_has_lost_dispute';

  perform pg_temp.assert(proc.prosecdef, 'part8: payment_intent_has_lost_dispute must remain SECURITY DEFINER');
  perform pg_temp.assert(
    proc.proconfig @> array['search_path=""']::text[],
    format('part8: payment_intent_has_lost_dispute search_path must be empty, got: %s', proc.proconfig)
  );

  select p.proconfig, p.prosecdef
  into proc
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'author_lost_disputed_payment_intents';

  perform pg_temp.assert(proc.prosecdef, 'part8: author_lost_disputed_payment_intents must be SECURITY DEFINER');
  perform pg_temp.assert(
    proc.proconfig @> array['search_path=""']::text[],
    format('part8: author_lost_disputed_payment_intents search_path must be empty, got: %s', proc.proconfig)
  );
end $$;

-- ============================================================
-- Part 9: exact EXECUTE grant matrix.
-- ============================================================
do $$
begin
  -- payment_intent_has_lost_dispute(text): no direct caller at all.
  perform pg_temp.assert(not has_function_privilege('public', 'public.payment_intent_has_lost_dispute(text)', 'EXECUTE'),
    'part9: public must not have EXECUTE on payment_intent_has_lost_dispute');
  perform pg_temp.assert(not has_function_privilege('anon', 'public.payment_intent_has_lost_dispute(text)', 'EXECUTE'),
    'part9: anon must not have EXECUTE on payment_intent_has_lost_dispute');
  perform pg_temp.assert(not has_function_privilege('authenticated', 'public.payment_intent_has_lost_dispute(text)', 'EXECUTE'),
    'part9: authenticated must not have EXECUTE on payment_intent_has_lost_dispute');
  perform pg_temp.assert(not has_function_privilege('service_role', 'public.payment_intent_has_lost_dispute(text)', 'EXECUTE'),
    'part9: service_role must not have EXECUTE on payment_intent_has_lost_dispute -- no application caller uses it, and it is not compensated for the authenticated revoke');

  -- author_lost_disputed_payment_intents(): authenticated only.
  perform pg_temp.assert(not has_function_privilege('public', 'public.author_lost_disputed_payment_intents()', 'EXECUTE'),
    'part9: public must not have EXECUTE on author_lost_disputed_payment_intents');
  perform pg_temp.assert(not has_function_privilege('anon', 'public.author_lost_disputed_payment_intents()', 'EXECUTE'),
    'part9: anon must not have EXECUTE on author_lost_disputed_payment_intents');
  perform pg_temp.assert(has_function_privilege('authenticated', 'public.author_lost_disputed_payment_intents()', 'EXECUTE'),
    'part9: authenticated must have EXECUTE on author_lost_disputed_payment_intents -- this is the Sales dashboard''s own caller');
  perform pg_temp.assert(not has_function_privilege('service_role', 'public.author_lost_disputed_payment_intents()', 'EXECUTE'),
    'part9: service_role must not have EXECUTE on author_lost_disputed_payment_intents -- no service-role caller exists');
end $$;

select 'ALL PASSED: 037_narrow_lost_dispute_rpc_privileges.test.sql' as result;

rollback;
