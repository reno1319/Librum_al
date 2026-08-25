-- Committed SQL regression suite for migration 038 (LAUNCH-1: purchase
-- history retention alignment -- purchases.reader_id becomes nullable,
-- ON DELETE SET NULL instead of CASCADE). See the Purchase History
-- Retention Alignment audit/design report for the full reasoning.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed. Two equivalent ways to run this, matching the
-- convention established by 037_narrow_lost_dispute_rpc_privileges.
-- test.sql:
--
-- (a) Fresh schema.sql (already includes migration 038's final state):
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/038_detach_purchases_reader_on_profile_deletion.test.sql
--
-- (b) The current through-037 schema with migration 038 applied on top:
--   createdb librum_test_038
--   psql -d librum_test_038 -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test_038 -f <through-037 schema snapshot>
--   psql -d librum_test_038 -v ON_ERROR_STOP=1 -f supabase/migrations/038_detach_purchases_reader_on_profile_deletion.sql
--   psql -d librum_test_038 -v ON_ERROR_STOP=1 -f supabase/tests/038_detach_purchases_reader_on_profile_deletion.test.sql
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs. Deleting an auth.users row (Part 4 onward) is done
-- directly at the SQL level, standing in for admin.auth.admin.
-- deleteUser() -- the actual application call -- which ultimately
-- performs the same DELETE FROM auth.users cascade this stub schema
-- also models (see 00_stub_supabase_platform.sql's own auth.users
-- definition and public.profiles' own ON DELETE CASCADE to it).

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
-- Part 1: FK shape itself -- catalog-level proof, independent of any
-- fixture, that the migration produced exactly the intended DDL.
-- ============================================================
do $$
declare
  v_def text;
  v_nullable boolean;
begin
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.purchases'::regclass
    and contype = 'f'
    and conname = 'purchases_reader_id_fkey';

  perform pg_temp.assert(
    v_def = 'FOREIGN KEY (reader_id) REFERENCES profiles(id) ON DELETE SET NULL',
    format('part1: purchases_reader_id_fkey must be ON DELETE SET NULL, got: %s', v_def)
  );

  select not attnotnull into v_nullable
  from pg_attribute
  where attrelid = 'public.purchases'::regclass and attname = 'reader_id';

  perform pg_temp.assert(v_nullable, 'part1: purchases.reader_id must be nullable');

  -- book_id must remain untouched: still NOT NULL, still RESTRICT.
  perform pg_temp.assert(
    (select attnotnull from pg_attribute
     where attrelid = 'public.purchases'::regclass and attname = 'book_id'),
    'part1: purchases.book_id must remain NOT NULL -- this migration must not touch it'
  );
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.purchases'::regclass and contype = 'f' and conname = 'purchases_book_id_fkey';
  perform pg_temp.assert(
    v_def = 'FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT',
    format('part1: purchases_book_id_fkey must remain ON DELETE RESTRICT, got: %s', v_def)
  );

  -- unique(book_id, reader_id) must be untouched.
  perform pg_temp.assert(
    exists (
      select 1 from pg_constraint
      where conrelid = 'public.purchases'::regclass
        and contype = 'u'
        and conname = 'purchases_book_id_reader_id_key'
    ),
    'part1: unique(book_id, reader_id) must remain exactly as it was'
  );
end $$;

-- ============================================================
-- Part 2: functional fixtures -- one author, two readers who each buy
-- the SAME book (to exercise Part 6's NULL-distinctness assertion),
-- plus a second, unrelated book/author pairing for the author-
-- accounting assertion (Part 7) and a third-party read-access check
-- (Part 5).
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000101', 'p038-author@test', '{"role":"author","display_name":"Author"}'),
  ('a0000000-0000-0000-0000-000000000102', 'p038-reader-one@test', '{"role":"reader","display_name":"Reader One"}'),
  ('a0000000-0000-0000-0000-000000000103', 'p038-reader-two@test', '{"role":"reader","display_name":"Reader Two"}'),
  ('a0000000-0000-0000-0000-000000000104', 'p038-bystander@test', '{"role":"reader","display_name":"Bystander"}');

insert into public.books (id, author_id, title, price_cents, status) values
  ('b0000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000101', 'P038 Shared Book', 500, 'published');

insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents) values
  ('c0000000-0000-0000-0000-000000000101', 'b0000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000102', 'cs_p038_one', 'pi_p038_one', 400),
  ('c0000000-0000-0000-0000-000000000102', 'b0000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000103', 'cs_p038_two', 'pi_p038_two', 500);

-- ============================================================
-- Part 3: pre-deletion sanity -- both purchases are owned by their
-- respective readers before either account is deleted, so the later
-- "no longer owned" assertions are proven against a real prior-true
-- state, not a vacuous one.
-- ============================================================
do $$
declare
  v_owns boolean;
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000102', true);
  set local role authenticated;
  select public.user_owns_book('b0000000-0000-0000-0000-000000000101') into v_owns;
  reset role;
  perform pg_temp.assert(v_owns, 'part3: reader one must own the book before their account is deleted');

  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000103', true);
  set local role authenticated;
  select public.user_owns_book('b0000000-0000-0000-0000-000000000101') into v_owns;
  reset role;
  perform pg_temp.assert(v_owns, 'part3: reader two must own the book before their account is deleted');
end $$;

-- ============================================================
-- Part 4: the actual deletion -- both readers' identities are removed,
-- standing in for admin.auth.admin.deleteUser() -> the ON DELETE
-- CASCADE from auth.users into public.profiles -> the ON DELETE SET
-- NULL from public.profiles into public.purchases.reader_id this
-- migration adds.
-- ============================================================
delete from auth.users where id = 'a0000000-0000-0000-0000-000000000102';
delete from auth.users where id = 'a0000000-0000-0000-0000-000000000103';

-- ============================================================
-- Part 5: both purchase rows survive, detached, with every other
-- column byte-identical to what was inserted in Part 2.
-- ============================================================
do $$
declare
  v_row record;
begin
  select * into v_row from public.purchases where id = 'c0000000-0000-0000-0000-000000000101';
  perform pg_temp.assert(v_row.id is not null, 'part5: reader one''s purchase row must still exist');
  perform pg_temp.assert(v_row.reader_id is null, 'part5: reader one''s purchase.reader_id must now be NULL');
  perform pg_temp.assert(v_row.book_id = 'b0000000-0000-0000-0000-000000000101', 'part5: book_id must be unchanged');
  perform pg_temp.assert(v_row.stripe_checkout_session_id = 'cs_p038_one', 'part5: stripe_checkout_session_id must be unchanged');
  perform pg_temp.assert(v_row.stripe_payment_intent_id = 'pi_p038_one', 'part5: stripe_payment_intent_id must be unchanged');
  perform pg_temp.assert(v_row.amount_cents = 400, 'part5: amount_cents must be unchanged');
  perform pg_temp.assert(v_row.refunded_at is null, 'part5: refunded_at must be unchanged (still null)');
  perform pg_temp.assert(v_row.discount_code_id is null, 'part5: discount_code_id must be unchanged (still null in this fixture)');
  perform pg_temp.assert(v_row.bundle_id is null, 'part5: bundle_id must be unchanged (still null in this fixture)');

  select * into v_row from public.purchases where id = 'c0000000-0000-0000-0000-000000000102';
  perform pg_temp.assert(v_row.id is not null, 'part5: reader two''s purchase row must still exist');
  perform pg_temp.assert(v_row.reader_id is null, 'part5: reader two''s purchase.reader_id must now be NULL');
  perform pg_temp.assert(v_row.stripe_payment_intent_id = 'pi_p038_two', 'part5: reader two''s stripe_payment_intent_id must be unchanged');
  perform pg_temp.assert(v_row.amount_cents = 500, 'part5: reader two''s amount_cents must be unchanged');
end $$;

-- ============================================================
-- Part 6: unique(book_id, reader_id) tolerates two NULL-reader_id rows
-- for the SAME book -- NULL is distinct from NULL under ordinary SQL
-- unique-constraint semantics, so both detached historical rows from
-- Part 4/5 legitimately coexist. This assertion is itself proof: if the
-- constraint had rejected the second detachment, Part 4's second DELETE
-- would already have failed above and this test would never reach here.
-- ============================================================
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.purchases
  where book_id = 'b0000000-0000-0000-0000-000000000101' and reader_id is null;

  perform pg_temp.assert(v_count = 2,
    format('part6: expected exactly 2 detached purchase rows for the shared book, got %s', v_count));
end $$;

-- ============================================================
-- Part 7: entitlement cannot resurrect. Neither original reader (now
-- gone entirely) nor an unrelated bystander nor a freshly-created
-- profile (standing in for "someone signs up again with the same
-- email" -- see this file's header comment on why a fresh UUID, not
-- email reuse, is the correct thing to prove: Supabase Auth issues a
-- new auth.users.id per signup regardless of email, so UUID identity,
-- not email, is the actual ownership key user_owns_book() and RLS both
-- key on) can own the book through either detached row.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000105', 'p038-reader-one@test', '{"role":"reader","display_name":"Reader One (recreated)"}');

do $$
declare
  v_owns boolean;
begin
  -- Unrelated bystander, never touched either purchase.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000104', true);
  set local role authenticated;
  select public.user_owns_book('b0000000-0000-0000-0000-000000000101') into v_owns;
  reset role;
  perform pg_temp.assert(not v_owns, 'part7: an unrelated bystander must not own the book');

  -- A brand-new profile that happens to reuse reader one's email --
  -- a genuinely different auth.users.id, so it must not inherit
  -- reader one's now-detached purchase.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000105', true);
  set local role authenticated;
  select public.user_owns_book('b0000000-0000-0000-0000-000000000101') into v_owns;
  reset role;
  perform pg_temp.assert(not v_owns,
    'part7: a freshly-created profile reusing a deleted reader''s email must NOT inherit their detached purchase -- UUID identity, not email, is the ownership key');
end $$;

-- ============================================================
-- Part 8: RLS -- an unrelated authenticated user cannot SELECT a
-- detached row through the reader-scoped policy ("auth.uid() =
-- reader_id"), proving NULL-safety directly against live RLS, not just
-- the predicate in isolation.
-- ============================================================
do $$
declare
  v_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000104', true);
  set local role authenticated;
  select count(*) into v_count
  from public.purchases
  where id in ('c0000000-0000-0000-0000-000000000101', 'c0000000-0000-0000-0000-000000000102');
  reset role;

  perform pg_temp.assert(v_count = 0,
    format('part8: an unrelated authenticated user must see zero of the two detached rows via reader-scoped RLS, saw %s', v_count));
end $$;

-- ============================================================
-- Part 9: author-side accounting -- the author still sees BOTH
-- detached rows through the author-scoped RLS policy, which joins
-- through books.author_id and never references reader_id at all. This
-- is the mechanism that actually preserves the retained accounting
-- history this migration exists to protect.
-- ============================================================
do $$
declare
  v_count integer;
  v_total integer;
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000101', true);
  set local role authenticated;
  select count(*), coalesce(sum(amount_cents), 0) into v_count, v_total
  from public.purchases
  where id in ('c0000000-0000-0000-0000-000000000101', 'c0000000-0000-0000-0000-000000000102');
  reset role;

  perform pg_temp.assert(v_count = 2,
    format('part9: the author must still see both detached purchase rows for their own book, saw %s', v_count));
  perform pg_temp.assert(v_total = 900,
    format('part9: the author''s retained revenue total for this book must be unchanged (400 + 500 = 900), got %s', v_total));
end $$;

select 'ALL PASSED: 038_detach_purchases_reader_on_profile_deletion.test.sql' as result;

rollback;
