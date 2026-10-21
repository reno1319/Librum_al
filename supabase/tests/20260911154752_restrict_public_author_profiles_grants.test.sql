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
--   (PEN-NAMES-2: do not re-apply 20260911154752 on top of schema.sql
--   any more -- the view it revokes on no longer exists there.)
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
-- PEN-NAMES-2 (C5, migration 20261019222600) dropped
-- public_author_profiles. The boundary this suite pinned -- a public
-- view carries SELECT for anon/authenticated and no write privilege at
-- all -- now applies to every public view that replaced it:
-- public_pen_names (the author's public name), public_books,
-- public_series, public_bundles and public_reviews. Each assertion
-- below states that replacement rule.
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
-- Fixture: one author with one draft book, matching this migration's
-- own audit evidence (row-count parity between the base table and the
-- view). The draft is needed since AUTHOR-VIEW-REQUIRE-BOOK-1 (migration
-- 20261019154308): the view lists an author only once they have a book.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'pen-name-author@test', '{"role":"author","display_name":"Real Account Name"}');
update public.profiles set public_author_name = 'Public Pen Name'
  where id = '11111111-1111-1111-1111-111111111111';
insert into public.books (id, author_id, title) values
  ('b1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'A Draft');

-- ============================================================
-- Part 1: read privileges -- anon and authenticated hold SELECT on every
-- public view; the old view is gone; direct anonymous access to the base
-- profiles table stays blocked.
-- ============================================================
create temp table public_views (v text);
insert into public_views values
  ('public.public_pen_names'), ('public.public_books'), ('public.public_series'),
  ('public.public_bundles'), ('public.public_reviews');

do $$
declare
  v text;
begin
  perform pg_temp.assert(
    to_regclass('public.public_author_profiles') is null,
    'part1 (PEN-NAMES-2): public_author_profiles no longer exists'
  );
  for v in select pv.v from public_views pv loop
    perform pg_temp.assert(
      has_table_privilege('anon', v, 'SELECT') and has_table_privilege('authenticated', v, 'SELECT'),
      format('part1 (PEN-NAMES-2): anon and authenticated must hold SELECT on %s', v)
    );
  end loop;
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.profiles', 'SELECT'),
    'part1: anon must have NO SELECT privilege at all on the base profiles table'
  );
end $$;

-- ============================================================
-- Part 2: no write privilege on any public view, for either role.
-- ============================================================
do $$
declare
  r text;
  priv text;
  v text;
begin
  for v in select pv.v from public_views pv loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
        perform pg_temp.assert(
          not has_table_privilege(r, v, priv),
          format('part2 (PEN-NAMES-2): %s must NOT have %s on %s', r, priv, v)
        );
      end loop;
    end loop;
  end loop;
end $$;

-- ============================================================
-- Part 3: no residual write path -- PUBLIC, role membership, and
-- column-level grants must not reintroduce anything.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    not exists (
      select 1
      from pg_class c
      cross join lateral aclexplode(c.relacl) a
      where c.oid in (select pv.v::regclass from public_views pv)
        and a.grantee = 0 -- PUBLIC pseudo-entry
    ),
    'part3 (PEN-NAMES-2): PUBLIC must not independently hold any privilege on a public view'
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
      where a.attrelid in (select pv.v::regclass from public_views pv)
        and a.attnum > 0 and not a.attisdropped
        and a.attacl is not null
    ),
    'part3 (PEN-NAMES-2): no column-level ACL on any public view should exist'
  );
end $$;

-- ============================================================
-- Part 4: the empirical write-path probe -- WHERE false guarantees zero
-- rows are ever matched; it must fail with a permission error for both
-- roles, for both UPDATE and DELETE (public_pen_names and public_books).
-- ============================================================
set role anon;
do $$
begin
  begin
    update public.public_pen_names set bio = bio where false;
    perform pg_temp.assert(false, 'part4 (anon): UPDATE against public_pen_names must be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.public_books where false;
    perform pg_temp.assert(false, 'part4 (anon): DELETE against public_books must be permission-denied');
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
    update public.public_books set title = title where false;
    perform pg_temp.assert(false, 'part4 (authenticated): UPDATE against public_books must be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.public_pen_names where false;
    perform pg_temp.assert(false, 'part4 (authenticated): DELETE against public_pen_names must be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

-- ============================================================
-- Part 5: public read behavior -- exercised as the querying role.
-- ============================================================
set role anon;
select pg_temp.assert(
  (select count(*) from public.public_pen_names) >= 1,
  'part5 (anon): SELECT count(*) through public_pen_names must succeed'
);
select pg_temp.assert(
  exists (select 1 from public.public_pen_names where name = 'Public Pen Name')
  and not exists (select 1 from public.public_pen_names where name = 'Real Account Name'),
  'part5 (anon, PEN-NAMES-2): must read the pen name via public_pen_names, never the account name'
);
reset role;

-- ============================================================
-- Part 6: boundary checks -- column projection and row-count parity
-- between the pen names that carry a book, series or bundle and the view.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'public_pen_names')
      = array['id', 'name', 'bio', 'avatar_path', 'links'],
    'part6 (PEN-NAMES-2): public_pen_names must expose exactly these five columns, in this order'
  );
  perform pg_temp.assert(
    (select count(*) from public.pen_names pn
      where exists (select 1 from public.books b where b.pen_name_id = pn.id)
         or exists (select 1 from public.series s where s.pen_name_id = pn.id)
         or exists (select 1 from public.bundles bu where bu.pen_name_id = pn.id))
      = (select count(*) from public.public_pen_names),
    'part6 (PEN-NAMES-2): the view row count must equal the count of pen names that carry a book, series or bundle'
  );
end $$;

select 'ALL PASSED: 20260911154752_restrict_public_author_profiles_grants.test.sql' as result;

rollback;
