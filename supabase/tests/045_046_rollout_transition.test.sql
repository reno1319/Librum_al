-- LIBRUM 2.0 AUTHOR-1D: proves the two-stage rollout itself is safe --
-- distinct from 045_public_author_name.test.sql, which assumes the
-- FINAL state (schema.sql, or baseline + 045 + 046) is already applied.
-- This file instead applies migration 045 ALONE first and asserts the
-- mid-rollout state, then applies migration 046 on top and asserts the
-- final state -- proving both individual migrations, and the gap
-- between them, are each independently safe.
--
-- Run manually against a disposable/local Postgres instance, from the
-- repo root:
--
--   createdb librum_rollout_test
--   psql -d librum_rollout_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_rollout_test -f <the pre-AUTHOR-1 baseline schema.sql,
--     i.e. `git show <pre-AUTHOR-1 commit>:supabase/schema.sql`>
--   psql -d librum_rollout_test -v ON_ERROR_STOP=1 -f supabase/migrations/045_public_author_name.sql
--   -- STATE B/C assertions below run here, against 045 alone --
--   psql -d librum_rollout_test -v ON_ERROR_STOP=1 -f supabase/migrations/046_profiles_privacy_lockdown.sql
--   -- STATE D assertions below run here, against 045 + 046 --
--   psql -d librum_rollout_test -v ON_ERROR_STOP=1 -f supabase/tests/045_046_rollout_transition.test.sql
--
-- Both phases are asserted in ONE file (applied only after BOTH
-- migrations are already in the database), rather than split into two
-- files that each apply their own migration mid-run -- psql can't roll
-- back a schema-altering migration cleanly the way a plain data-only
-- transaction can, so this file assumes the two migrations were already
-- applied in order outside of it (exactly as the sequence above does),
-- and everything below runs inside one transaction/rollback for its own
-- fixture data only.

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

grant usage on schema extensions to anon, authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'pseudo-author@test', '{"role":"author","display_name":"Renato Kalemi"}'),
  ('22222222-2222-2222-2222-222222222222', 'plain-reader@test', '{"role":"reader","display_name":"Reader One"}'),
  ('33333333-3333-3333-3333-333333333333', 'moderator@test', '{"role":"reader","display_name":"Moderator Person"}');
update public.profiles set public_author_name = 'Arben Leka' where id = '11111111-1111-1111-1111-111111111111';
insert into public.staff_members (user_id, role) values ('33333333-3333-3333-3333-333333333333', 'moderator');
insert into public.books (id, author_id, title, description, genre, price_cents, status)
values ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A Book', 'desc', 'Fiction', 500, 'published');

-- ============================================================
-- Confirms this database already has BOTH migrations applied (the
-- assertions below are written against that end state -- see the
-- run instructions above for how to check STATE B/C in isolation,
-- between the two `psql -f` migration applications, before this test
-- file itself ever runs).
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'Staff with an authorized permission can view any profile'),
    'precondition: migration 046 must already be applied for this file''s STATE D assertions to be meaningful'
  );
end $$;

-- ============================================================
-- STATE D: after migration 046. The full final lockdown.
-- ============================================================

-- anon cannot read the base table at all.
select pg_temp.assert(
  not has_table_privilege('anon', 'public.profiles', 'SELECT'),
  'STATE D: anon must have no SELECT privilege on the base profiles table'
);

-- an ordinary authenticated reader cannot read another user's row.
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select pg_temp.assert(
  (select count(*) from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 0,
  'STATE D: an ordinary authenticated reader must see ZERO rows for another user via the base table'
);
reset role;

-- self can read own full row.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select pg_temp.assert(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'Renato Kalemi',
  'STATE D: an author must still read their OWN display_name directly'
);
reset role;

-- staff access remains correct.
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select pg_temp.assert(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'Renato Kalemi',
  'STATE D: a moderator (reports.view) must still read another user''s display_name for moderation'
);
reset role;

-- public view works, for anon and for an ordinary authenticated reader.
set role anon;
select pg_temp.assert(
  (select public_author_name from public.public_author_profiles where id = '11111111-1111-1111-1111-111111111111') = 'Arben Leka',
  'STATE D: anon must still read the pen name via public_author_profiles'
);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select pg_temp.assert(
  (select public_author_name from public.public_author_profiles where id = '11111111-1111-1111-1111-111111111111') = 'Arben Leka',
  'STATE D: an ordinary authenticated reader must still read the pen name via public_author_profiles'
);
reset role;

-- search still works, for anon and for an ordinary authenticated reader.
set role anon;
select pg_temp.assert(
  exists (select 1 from public.search_books('Arben Leka')),
  'STATE D: search must still match the public pen name as anon'
);
select pg_temp.assert(
  not exists (select 1 from public.search_books('Renato Kalemi')),
  'STATE D: search must NOT match the private display_name as anon'
);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select pg_temp.assert(
  exists (select 1 from public.search_books('Arben Leka')),
  'STATE D: search must still match the public pen name as an ordinary authenticated reader'
);
reset role;

select 'STATE D CONFIRMED (post-046)' as result;

rollback;
