-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for AUTHOR-VIEW-REQUIRE-BOOK-1
-- (supabase/migrations/20261019154308_public_author_profiles_require_book.sql):
-- public.public_author_profiles lists an author only once they have at
-- least one book, of any status, while its columns, owner, privileges
-- and security_invoker setting stay exactly as they were.
--
-- PEN-NAMES-2 (C5, migration 20261019222600) dropped
-- public_author_profiles. The rule this suite pinned -- an author's
-- public name is not readable until they have a book -- now holds for
-- the pen name: public_pen_names lists a pen name only while a book,
-- series or bundle carries it, and an account's display name is never
-- public. Every assertion below states that replacement rule.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/073_public_author_profiles_require_book.test.sql
--
-- It must also pass against the other build path -- the base schema.sql
-- plus the migration -- and
-- 073_public_author_profiles_require_book_catalog_equivalence.sh proves
-- those two paths agree. Against the BASE schema alone it must FAIL at
-- part1 (the book-less author is listed): the negative control.
--
-- Everything runs in one transaction and is rolled back.

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
-- Fixture, through the signup trigger (handle_new_user):
--   A  author, confirmed, no book
--   U  author, never confirmed their email, no book
--   B  author with one draft book only
--   C  author with one published book
--   R  reader who (as the table owner) is given a book -- the role
--      filter must still hide them
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0730000-0000-4000-8000-00000000000a', 'p073-a@test', now(), '{"role":"author","display_name":"P073 Signup Name A"}'),
  ('e0730000-0000-4000-8000-00000000000b', 'p073-b@test', now(), '{"role":"author","display_name":"P073 Pen B"}'),
  ('e0730000-0000-4000-8000-00000000000c', 'p073-c@test', now(), '{"role":"author","display_name":"P073 Pen C"}'),
  ('e0730000-0000-4000-8000-0000000000aa', 'p073-r@test', now(), '{"role":"reader","display_name":"P073 Reader"}');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e0730000-0000-4000-8000-0000000000ff', 'p073-u@test', '{"role":"author","display_name":"P073 Unconfirmed"}');

-- PEN-NAMES-1 (migration 20261019184512): every book carries a pen
-- name, and a reader has no default one, so R (as the table owner) is
-- given one first; the view must still hide R.
insert into public.pen_names (author_id, name, is_default) values
  ('e0730000-0000-4000-8000-0000000000aa', 'P073 R pen', true);

insert into public.books (id, author_id, title, status, price_cents, price_all, published_at) values
  ('e0730001-0000-4000-8000-00000000000b', 'e0730000-0000-4000-8000-00000000000b', 'P073 B draft', 'draft', 0, 199, null),
  ('e0730001-0000-4000-8000-00000000000c', 'e0730000-0000-4000-8000-00000000000c', 'P073 Zgjuar', 'published', 0, 199, now()),
  ('e0730001-0000-4000-8000-0000000000aa', 'e0730000-0000-4000-8000-0000000000aa', 'P073 R book', 'draft', 0, 199, null);

do $$
begin
  perform pg_temp.assert(
    (select count(*) from public.profiles where id::text like 'e0730000-%' and role = 'author'
       and public_author_name is not null) = 4
    and (select role from public.profiles where id = 'e0730000-0000-4000-8000-0000000000aa') = 'reader',
    'part0: the signup trigger created four authors with a public name and one reader');
end $$;

-- ============================================================
-- Part 1: whose public name is listed, as each calling role.
-- PEN-NAMES-2: through public_pen_names (pen names that carry a book).
-- ============================================================
create temp table expected_names (name text);
insert into expected_names values ('P073 Pen B'), ('P073 Pen C'), ('P073 R pen');
grant select on expected_names to anon, authenticated;

set role anon;
select pg_temp.assert(
  (select array_agg(name order by name) from public.public_pen_names where name like 'P073 %')
    = (select array_agg(name order by name) from expected_names),
  'part1 (anon, PEN-NAMES-2): exactly the pen names that carry a draft or published book are listed');
select pg_temp.assert(
  not exists (select 1 from public.public_pen_names where name = 'P073 Signup Name A'),
  'part1 (anon, PEN-NAMES-2): a book-less author''s signup (default pen) name is not readable');
select pg_temp.assert(
  not exists (select 1 from public.public_pen_names where name = 'P073 Unconfirmed'),
  'part1 (anon, PEN-NAMES-2): an author who never confirmed their email and has no book is not listed');
select pg_temp.assert(
  not exists (select 1 from public.public_pen_names where name = 'P073 Reader'),
  'part1 (anon, PEN-NAMES-2): a reader''s account display name is never listed, even with a book row (only the pen name the book carries is)');
select pg_temp.assert(
  (select count(*) from public.public_pen_names where name = 'P073 Pen B') = 1,
  'part1 (anon, PEN-NAMES-2): a draft-only author''s pen name is readable');
reset role;

-- authenticated as a different user, and as the book-less author themself
set role authenticated;
select set_config('request.jwt.claim.sub', 'e0730000-0000-4000-8000-0000000000aa', true);
select pg_temp.assert(
  (select array_agg(name order by name) from public.public_pen_names where name like 'P073 %')
    = (select array_agg(name order by name) from expected_names),
  'part1 (authenticated reader, PEN-NAMES-2): the same pen names are listed');
select set_config('request.jwt.claim.sub', 'e0730000-0000-4000-8000-00000000000a', true);
select pg_temp.assert(
  not exists (select 1 from public.public_pen_names where name = 'P073 Signup Name A'),
  'part1 (authenticated, self, PEN-NAMES-2): a book-less author''s pen name is not listed even to themself');
select set_config('request.jwt.claim.sub', '', true);
reset role;

-- ============================================================
-- Part 2: the name appears with the first book and goes with the last.
-- ============================================================
insert into public.books (id, author_id, title) values
  ('e0730001-0000-4000-8000-00000000000a', 'e0730000-0000-4000-8000-00000000000a', 'P073 A first draft');
set role anon;
select pg_temp.assert(
  exists (select 1 from public.public_pen_names where name = 'P073 Signup Name A'),
  'part2 (PEN-NAMES-2): an author''s pen name is listed as soon as they create a first draft');
reset role;

delete from public.books where id = 'e0730001-0000-4000-8000-00000000000b';
set role anon;
select pg_temp.assert(
  not exists (select 1 from public.public_pen_names where name = 'P073 Pen B'),
  'part2 (PEN-NAMES-2): an author whose only book is deleted is no longer listed');
reset role;

-- ============================================================
-- Part 3: the old view is gone; the replacement exposes no account.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    to_regclass('public.public_author_profiles') is null,
    'part3 (PEN-NAMES-2): public_author_profiles no longer exists');
  perform pg_temp.assert(
    (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'public_pen_names')
      = array['id', 'name', 'bio', 'avatar_path', 'links'],
    'part3 (PEN-NAMES-2): public_pen_names has exactly id, name, bio, avatar_path, links -- no account id or display name');
  perform pg_temp.assert(
    (select array_agg(a.privilege_type::text order by a.privilege_type)
       from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.oid = 'public.public_pen_names'::regclass and a.grantee = 'anon'::regrole) = array['SELECT']
    and (select array_agg(a.privilege_type::text order by a.privilege_type)
       from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.oid = 'public.public_pen_names'::regclass and a.grantee = 'authenticated'::regrole) = array['SELECT'],
    'part3 (PEN-NAMES-2): anon and authenticated hold SELECT and nothing else on public_pen_names');
  perform pg_temp.assert(
    not exists (select 1 from pg_class c cross join lateral aclexplode(c.relacl) a
                 where c.oid = 'public.public_pen_names'::regclass and a.grantee = 0),
    'part3 (PEN-NAMES-2): PUBLIC holds nothing on public_pen_names');
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.profiles', 'SELECT')
    and not has_table_privilege('anon', 'public.books', 'INSERT')
    and not has_table_privilege('anon', 'public.books', 'SELECT'),
    'part3 (PEN-NAMES-2): anon has no SELECT on profiles or books and no INSERT on books');
end $$;

set role anon;
do $$
begin
  begin
    update public.public_pen_names set bio = bio where false;
    perform pg_temp.assert(false, 'part3 (anon): UPDATE against public_pen_names must be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.public_pen_names where false;
    perform pg_temp.assert(false, 'part3 (anon): DELETE against public_pen_names must be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- search_books() reads public_books as the calling role: a published
-- book is still found by its pen name.
select pg_temp.assert(
  exists (select 1 from public.search_books('P073 Pen C') s where s.book_id = 'e0730001-0000-4000-8000-00000000000c'),
  'part3 (anon): search_books() still finds a published book by its author''s pen name');
reset role;

select 'ALL PASSED: 073_public_author_profiles_require_book.test.sql' as result;

rollback;
