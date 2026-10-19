-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for AUTHOR-VIEW-REQUIRE-BOOK-1
-- (supabase/migrations/20261019154308_public_author_profiles_require_book.sql):
-- public.public_author_profiles lists an author only once they have at
-- least one book, of any status, while its columns, owner, privileges
-- and security_invoker setting stay exactly as they were.
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
-- Part 1: who is listed, as each calling role.
-- ============================================================
create temp table expected_ids (id uuid);
insert into expected_ids values
  ('e0730000-0000-4000-8000-00000000000b'),
  ('e0730000-0000-4000-8000-00000000000c');
grant select on expected_ids to anon, authenticated;

set role anon;
select pg_temp.assert(
  (select array_agg(id order by id) from public.public_author_profiles where id::text like 'e0730000-%')
    = (select array_agg(id order by id) from expected_ids),
  'part1 (anon): exactly the authors with a draft or a published book are listed');
select pg_temp.assert(
  not exists (select 1 from public.public_author_profiles where public_author_name = 'P073 Signup Name A'),
  'part1 (anon): a book-less author''s signup name is not readable');
select pg_temp.assert(
  not exists (select 1 from public.public_author_profiles where id = 'e0730000-0000-4000-8000-0000000000ff'),
  'part1 (anon): an author who never confirmed their email and has no book is not listed');
select pg_temp.assert(
  not exists (select 1 from public.public_author_profiles where id = 'e0730000-0000-4000-8000-0000000000aa'),
  'part1 (anon): a reader is never listed, even with a book row');
select pg_temp.assert(
  (select public_author_name from public.public_author_profiles where id = 'e0730000-0000-4000-8000-00000000000b') = 'P073 Pen B',
  'part1 (anon): a draft-only author''s pen name is readable');
reset role;

-- authenticated as a different user, and as the book-less author themself
set role authenticated;
select set_config('request.jwt.claim.sub', 'e0730000-0000-4000-8000-0000000000aa', true);
select pg_temp.assert(
  (select array_agg(id order by id) from public.public_author_profiles where id::text like 'e0730000-%')
    = (select array_agg(id order by id) from expected_ids),
  'part1 (authenticated reader): the same two authors are listed');
select set_config('request.jwt.claim.sub', 'e0730000-0000-4000-8000-00000000000a', true);
select pg_temp.assert(
  not exists (select 1 from public.public_author_profiles where id = 'e0730000-0000-4000-8000-00000000000a'),
  'part1 (authenticated, self): a book-less author is not listed even to themself');
select set_config('request.jwt.claim.sub', '', true);
reset role;

-- ============================================================
-- Part 2: the row appears with the first book and goes with the last.
-- ============================================================
insert into public.books (id, author_id, title) values
  ('e0730001-0000-4000-8000-00000000000a', 'e0730000-0000-4000-8000-00000000000a', 'P073 A first draft');
set role anon;
select pg_temp.assert(
  exists (select 1 from public.public_author_profiles where id = 'e0730000-0000-4000-8000-00000000000a'),
  'part2: an author is listed as soon as they create a first draft');
reset role;

delete from public.books where id = 'e0730001-0000-4000-8000-00000000000b';
set role anon;
select pg_temp.assert(
  not exists (select 1 from public.public_author_profiles where id = 'e0730000-0000-4000-8000-00000000000b'),
  'part2: an author whose only book is deleted is no longer listed');
reset role;

-- ============================================================
-- Part 3: everything else about the view is unchanged.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'public_author_profiles')
      = array['id', 'public_author_name', 'bio', 'avatar_path'],
    'part3: exactly the same four columns, in the same order');
  perform pg_temp.assert(
    (select reloptions from pg_class where oid = 'public.public_author_profiles'::regclass) is null,
    'part3: no reloptions -- security_invoker stays unset (the view still runs as its owner)');
  perform pg_temp.assert(
    (select relowner from pg_class where oid = 'public.public_author_profiles'::regclass)
      = (select relowner from pg_class where oid = 'public.profiles'::regclass),
    'part3: the view is owned by the same role as public.profiles');
  perform pg_temp.assert(
    (select array_agg(a.privilege_type::text order by a.privilege_type)
       from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.oid = 'public.public_author_profiles'::regclass and a.grantee = 'anon'::regrole) = array['SELECT']
    and (select array_agg(a.privilege_type::text order by a.privilege_type)
       from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.oid = 'public.public_author_profiles'::regclass and a.grantee = 'authenticated'::regrole) = array['SELECT'],
    'part3: anon and authenticated hold SELECT and nothing else on the view');
  perform pg_temp.assert(
    not exists (select 1 from pg_class c cross join lateral aclexplode(c.relacl) a
                 where c.oid = 'public.public_author_profiles'::regclass and a.grantee = 0),
    'part3: PUBLIC holds nothing on the view');
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.profiles', 'SELECT')
    and not has_table_privilege('anon', 'public.books', 'INSERT'),
    'part3: the base tables'' anon grants are untouched');
end $$;

set role anon;
do $$
begin
  begin
    update public.public_author_profiles set bio = bio where false;
    perform pg_temp.assert(false, 'part3 (anon): UPDATE against the view must be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.public_author_profiles where false;
    perform pg_temp.assert(false, 'part3 (anon): DELETE against the view must be permission-denied');
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- search_books() reads the view as the calling role: an author of a
-- published book is still found by pen name.
select pg_temp.assert(
  exists (select 1 from public.search_books('P073 Pen C') s where s.book_id = 'e0730001-0000-4000-8000-00000000000c'),
  'part3 (anon): search_books() still finds a published book by its author''s pen name');
reset role;

select 'ALL PASSED: 073_public_author_profiles_require_book.test.sql' as result;

rollback;
