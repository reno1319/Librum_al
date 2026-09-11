-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for migration
-- 20260911154752_restrict_public_author_profiles_grants.sql.
--
-- Not run automatically by any CI/build step in this repo (there is no
-- existing SQL test framework or Postgres-in-CI setup here) -- run it
-- manually against a disposable/local Postgres instance, AFTER applying
-- supabase/schema.sql (or the full migration chain through this one),
-- from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/migrations/20260911154752_restrict_public_author_profiles_grants.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/20260911154752_restrict_public_author_profiles_grants.test.sql
--
-- This suite asserts exactly the boundary a live-database security audit
-- found and this migration closes: anon/authenticated must keep SELECT
-- on public.public_author_profiles (public cross-user author-attribution
-- reads must keep working, and direct anonymous access to the base
-- public.profiles table must remain blocked -- both already covered by
-- migration 045/046's own test suite, re-affirmed here only as a
-- non-regression check), while losing every write privilege the view
-- was never meant to carry (INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER, MAINTAIN). It does not re-test the view's column
-- projection or role='author' filter from scratch (045_public_author_
-- name.test.sql Part 5 already owns that); it re-asserts them here only
-- as a boundary check that this migration didn't accidentally touch.
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable against the same database
-- with no manual cleanup between runs.

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
-- Fixture: one author, matching this migration's own audit evidence
-- (row-count parity between the base table and the view).
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'pen-name-author@test', '{"role":"author","display_name":"Real Account Name"}');
update public.profiles set public_author_name = 'Public Pen Name'
  where id = '11111111-1111-1111-1111-111111111111';

-- ============================================================
-- Part 1: read privileges preserved -- anon and authenticated must
-- retain SELECT on the view; direct anonymous access to the base table
-- must remain blocked. This is the exact non-regression boundary this
-- migration must never cross (it revokes write privileges only).
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    has_table_privilege('anon', 'public.public_author_profiles', 'SELECT'),
    'part1: anon must retain SELECT on public_author_profiles'
  );
  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.public_author_profiles', 'SELECT'),
    'part1: authenticated must retain SELECT on public_author_profiles'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.profiles', 'SELECT'),
    'part1: anon must have NO SELECT privilege at all on the base profiles table'
  );
end $$;

-- ============================================================
-- Part 2: write privileges revoked -- the actual finding this migration
-- closes. Every one of these must now be false for both roles.
-- ============================================================
do $$
declare
  r text;
  priv text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      perform pg_temp.assert(
        not has_table_privilege(r, 'public.public_author_profiles', priv),
        format('part2: %s must NOT have %s on public_author_profiles', r, priv)
      );
    end loop;
  end loop;
end $$;

-- ============================================================
-- Part 3: no residual write path -- PUBLIC, role membership, and
-- column-level grants must not reintroduce anything the table-level
-- revoke above removed.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    not exists (
      select 1
      from pg_class c
      cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = 'public'::regnamespace
        and c.relname = 'public_author_profiles'
        and a.grantee = 0 -- PUBLIC pseudo-entry
    ),
    'part3: PUBLIC must not independently hold any privilege on public_author_profiles'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from pg_auth_members m
      join pg_roles r on r.oid = m.member
      where r.rolname in ('anon', 'authenticated')
    ),
    'part3: anon/authenticated must not be members of any other role that could reintroduce write access'
  );
  perform pg_temp.assert(
    not exists (
      select 1
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace
        and c.relname = 'public_author_profiles'
        and a.attnum > 0 and not a.attisdropped
        and a.attacl is not null
    ),
    'part3: no column-level ACL on public_author_profiles should exist'
  );
end $$;

-- ============================================================
-- Part 4: the actual empirical write-path probe -- WHERE false
-- guarantees zero rows are ever matched, so this is fully safe even if
-- it were somehow permitted; it must now fail with a permission error
-- for both roles, for both UPDATE and DELETE.
-- ============================================================
set role anon;
do $$
begin
  begin
    update public.public_author_profiles set bio = bio where false;
    perform pg_temp.assert(false, 'part4 (anon): UPDATE against the view must now be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.public_author_profiles where false;
    perform pg_temp.assert(false, 'part4 (anon): DELETE against the view must now be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
do $$
begin
  begin
    update public.public_author_profiles set bio = bio where false;
    perform pg_temp.assert(false, 'part4 (authenticated): UPDATE against the view must now be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.public_author_profiles where false;
    perform pg_temp.assert(false, 'part4 (authenticated): DELETE against the view must now be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

-- ============================================================
-- Part 5: public read behavior is completely unaffected -- exercised as
-- the actual querying role, not the connecting superuser.
-- ============================================================
set role anon;
select pg_temp.assert(
  (select count(*) from public.public_author_profiles) >= 1,
  'part5 (anon): SELECT count(*) through the view must still succeed'
);
select pg_temp.assert(
  (select public_author_name from public.public_author_profiles where id = '11111111-1111-1111-1111-111111111111') = 'Public Pen Name',
  'part5 (anon): must still read the pen name via the view'
);
reset role;

-- ============================================================
-- Part 6: unchanged boundary checks -- column projection, author-only
-- filter, and row-count parity between the base table and the view.
-- Not new coverage (045_public_author_name.test.sql Part 5 already
-- owns this) -- reasserted only to prove this migration didn't touch
-- either.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select array_agg(column_name order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'public_author_profiles')
      = array['id', 'public_author_name', 'bio', 'avatar_path'],
    'part6: public_author_profiles must expose exactly these four columns, in this order'
  );
  perform pg_temp.assert(
    (select count(*) from public.profiles where role = 'author')
      = (select count(*) from public.public_author_profiles),
    'part6: the view row count must equal the count of author rows in the base table'
  );
end $$;

select 'ALL PASSED: 20260911154752_restrict_public_author_profiles_grants.test.sql' as result;

rollback;
