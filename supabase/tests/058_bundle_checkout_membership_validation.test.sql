-- Committed SQL regression suite for migration 058 (PHASE-2C:
-- bundle-membership-integrity -- checkout-time defense in
-- create_bundle_checkout_snapshot()).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- NOT run against a live Supabase project for this change (out of
-- scope -- see PHASE-2C's own restrictions: no Supabase access, no
-- remote migration). Intended to be run manually against a
-- disposable/local Postgres instance, AFTER applying supabase/schema.sql
-- (which already includes migration 058's final state), from the repo
-- root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/058_bundle_checkout_membership_validation.test.sql
--
-- Everything below runs inside one transaction and is rolled back at the
-- end, so this file is fully repeatable with no manual cleanup between
-- runs.
--
-- Fixtures for the "wrong-author membership" case (Part 5) are inserted
-- DIRECTLY into public.bundle_books, bypassing RLS -- the same
-- convention every other test file in this directory already uses for
-- its own fixtures. This is deliberate here, not incidental: the "Authors
-- can add books to their own bundles" RLS insert policy would normally
-- prevent an author from adding another author's book to their bundle
-- through the app, but create_bundle_checkout_snapshot() (a SECURITY
-- DEFINER function that bypasses RLS entirely once invoked) must defend
-- against this membership existing regardless of how it got there -- a
-- direct fixture insert is the correct way to construct that state
-- safely for a test, without needing a second, unrelated RLS bypass to
-- reproduce it.

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
-- Part 0: fixtures.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0580000-0000-0000-0000-000000000001', 'p058-author-a@test', now(), '{"role":"author","display_name":"P058 Author A"}'),
  ('e0580000-0000-0000-0000-000000000002', 'p058-author-x@test', now(), '{"role":"author","display_name":"P058 Author X"}'),
  ('e0580000-0000-0000-0000-000000000003', 'p058-reader@test', now(), '{"role":"reader","display_name":"P058 Reader"}');

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  -- Bundle "Valid Two": both members valid.
  ('d0580000-0000-0000-0000-000000000001', 'e0580000-0000-0000-0000-000000000001', 'P058 Valid Two - Book A', '', '', '', 400, 'published'),
  ('d0580000-0000-0000-0000-000000000002', 'e0580000-0000-0000-0000-000000000001', 'P058 Valid Two - Book B', '', '', '', 600, 'published'),
  -- Bundle "Valid Three": all three members valid.
  ('d0580000-0000-0000-0000-000000000003', 'e0580000-0000-0000-0000-000000000001', 'P058 Valid Three - Book A', '', '', '', 300, 'published'),
  ('d0580000-0000-0000-0000-000000000004', 'e0580000-0000-0000-0000-000000000001', 'P058 Valid Three - Book B', '', '', '', 300, 'published'),
  ('d0580000-0000-0000-0000-000000000005', 'e0580000-0000-0000-0000-000000000001', 'P058 Valid Three - Book C', '', '', '', 400, 'published'),
  -- Bundle "One Unpublished Of Three": 2 published + 1 draft, same author.
  ('d0580000-0000-0000-0000-000000000006', 'e0580000-0000-0000-0000-000000000001', 'P058 Drift - Book A', '', '', '', 200, 'published'),
  ('d0580000-0000-0000-0000-000000000007', 'e0580000-0000-0000-0000-000000000001', 'P058 Drift - Book B', '', '', '', 200, 'published'),
  ('d0580000-0000-0000-0000-000000000008', 'e0580000-0000-0000-0000-000000000001', 'P058 Drift - Book C (unpublished)', '', '', '', 200, 'draft'),
  -- Bundle "Too Few": a single member.
  ('d0580000-0000-0000-0000-000000000009', 'e0580000-0000-0000-0000-000000000001', 'P058 Too Few - Only Book', '', '', '', 500, 'published'),
  -- Bundle "Wrong Author": one book genuinely owned by author A, one
  -- owned by author X but inserted into author A's bundle_books anyway.
  ('d0580000-0000-0000-0000-000000000010', 'e0580000-0000-0000-0000-000000000001', 'P058 Wrong Author - Own Book', '', '', '', 300, 'published'),
  ('d0580000-0000-0000-0000-000000000011', 'e0580000-0000-0000-0000-000000000002', 'P058 Wrong Author - Someone Elses Book', '', '', '', 300, 'published');

insert into public.bundles (id, author_id, title, description, price_cents, status) values
  ('a0580000-0000-0000-0000-000000000001', 'e0580000-0000-0000-0000-000000000001', 'P058 Valid Two', '', 1000, 'published'),
  ('a0580000-0000-0000-0000-000000000002', 'e0580000-0000-0000-0000-000000000001', 'P058 Valid Three', '', 1000, 'published'),
  ('a0580000-0000-0000-0000-000000000003', 'e0580000-0000-0000-0000-000000000001', 'P058 One Unpublished Of Three', '', 600, 'published'),
  ('a0580000-0000-0000-0000-000000000004', 'e0580000-0000-0000-0000-000000000001', 'P058 Too Few', '', 500, 'published'),
  ('a0580000-0000-0000-0000-000000000005', 'e0580000-0000-0000-0000-000000000001', 'P058 Wrong Author', '', 600, 'published');

insert into public.bundle_books (bundle_id, book_id) values
  ('a0580000-0000-0000-0000-000000000001', 'd0580000-0000-0000-0000-000000000001'),
  ('a0580000-0000-0000-0000-000000000001', 'd0580000-0000-0000-0000-000000000002'),
  ('a0580000-0000-0000-0000-000000000002', 'd0580000-0000-0000-0000-000000000003'),
  ('a0580000-0000-0000-0000-000000000002', 'd0580000-0000-0000-0000-000000000004'),
  ('a0580000-0000-0000-0000-000000000002', 'd0580000-0000-0000-0000-000000000005'),
  ('a0580000-0000-0000-0000-000000000003', 'd0580000-0000-0000-0000-000000000006'),
  ('a0580000-0000-0000-0000-000000000003', 'd0580000-0000-0000-0000-000000000007'),
  ('a0580000-0000-0000-0000-000000000003', 'd0580000-0000-0000-0000-000000000008'),
  ('a0580000-0000-0000-0000-000000000004', 'd0580000-0000-0000-0000-000000000009'),
  ('a0580000-0000-0000-0000-000000000005', 'd0580000-0000-0000-0000-000000000010'),
  ('a0580000-0000-0000-0000-000000000005', 'd0580000-0000-0000-0000-000000000011');

-- ============================================================
-- Part 1: a fully valid 2-member bundle can create a snapshot.
-- ============================================================
do $$
declare
  v_snapshot record;
  v_item_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'e0580000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_snapshot
  from public.create_bundle_checkout_snapshot('a0580000-0000-0000-0000-000000000001'::uuid);
  reset role;

  perform pg_temp.assert(v_snapshot.snapshot_id is not null, 'part1: a valid 2-member bundle must produce a snapshot');

  select jsonb_array_length(items) into v_item_count
  from public.bundle_checkout_snapshots where id = v_snapshot.snapshot_id;
  perform pg_temp.assert(v_item_count = 2, 'part1: the frozen snapshot must contain exactly the 2 valid books');
end $$;

-- ============================================================
-- Part 2: a fully valid 3-member bundle can create a snapshot.
-- ============================================================
do $$
declare
  v_snapshot record;
  v_item_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'e0580000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_snapshot
  from public.create_bundle_checkout_snapshot('a0580000-0000-0000-0000-000000000002'::uuid);
  reset role;

  perform pg_temp.assert(v_snapshot.snapshot_id is not null, 'part2: a valid 3-member bundle must produce a snapshot');

  select jsonb_array_length(items) into v_item_count
  from public.bundle_checkout_snapshots where id = v_snapshot.snapshot_id;
  perform pg_temp.assert(v_item_count = 3, 'part2: the frozen snapshot must contain all 3 valid books');
end $$;

-- ============================================================
-- Part 3: a bundle with 1 of 3 members invalid (unpublished) must
-- reject the WHOLE checkout -- proving the total-vs-valid comparison,
-- not a "filter, then check >= 2" check. The 2 still-valid members must
-- NEVER be silently checked out as a smaller, valid subset.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0580000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.create_bundle_checkout_snapshot('a0580000-0000-0000-0000-000000000003'::uuid);
    perform pg_temp.assert(false, 'part3: a bundle with 1 of 3 members invalid must reject the whole checkout');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'bundle does not have enough valid books to check out',
      format('part3: unexpected error: %s', sqlerrm)
    );
  end;
  reset role;

  perform pg_temp.assert(
    not exists (
      select 1 from public.bundle_checkout_snapshots
      where bundle_id = 'a0580000-0000-0000-0000-000000000003'
    ),
    'part3: no snapshot of any size may be created for this bundle -- not even a smaller, 2-item one'
  );
end $$;

-- ============================================================
-- Part 4: fewer than 2 total membership rows is rejected outright.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0580000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.create_bundle_checkout_snapshot('a0580000-0000-0000-0000-000000000004'::uuid);
    perform pg_temp.assert(false, 'part4: a bundle with only 1 membership row must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'bundle does not have enough valid books to check out',
      format('part4: unexpected error: %s', sqlerrm)
    );
  end;
  reset role;

  perform pg_temp.assert(
    not exists (
      select 1 from public.bundle_checkout_snapshots
      where bundle_id = 'a0580000-0000-0000-0000-000000000004'
    ),
    'part4: no snapshot may be created for a too-few-members bundle'
  );
end $$;

-- ============================================================
-- Part 5: a membership row whose book belongs to a DIFFERENT author
-- than the bundle's own author is invalid, and its presence (even
-- alongside one genuinely valid member) rejects the whole checkout.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0580000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.create_bundle_checkout_snapshot('a0580000-0000-0000-0000-000000000005'::uuid);
    perform pg_temp.assert(false, 'part5: a bundle with a wrong-author member must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'bundle does not have enough valid books to check out',
      format('part5: unexpected error: %s', sqlerrm)
    );
  end;
  reset role;

  perform pg_temp.assert(
    not exists (
      select 1 from public.bundle_checkout_snapshots
      where bundle_id = 'a0580000-0000-0000-0000-000000000005'
    ),
    'part5: no snapshot may be created for a bundle with a wrong-author member'
  );
end $$;

rollback;
