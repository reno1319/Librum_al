-- Committed SQL regression suite for BUNDLE-DELETE-SAFETY-1
-- (src/app/(public)/dashboard/bundles/actions.ts deleteBundle): no
-- migration, no schema change. It pins the database behavior the action
-- relies on:
--
-- * the author's session deletes with the exact statement shape the
--   action sends -- `id` AND `author_id` predicates, `returning id` --
--   and gets back exactly its own bundle's id, for a draft and for a
--   published bundle, because the SELECT policy lets an author see their
--   own drafts;
-- * another author gets zero rows back and deletes nothing, whether the
--   action binds their own id (what deleteBundle does) or a forged one;
-- * anon cannot delete at all, and authenticated cannot delete
--   bundle_books directly, yet the ON DELETE CASCADE still removes the
--   deleted bundle's membership and nothing else;
-- * the ACLs deleteBundle depends on are exactly as described.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure. To reproduce, from the repo root, against a disposable
-- PostgreSQL 17 instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/070_bundle_owner_delete.test.sql
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs deleteBundle's statement as `p_role` with `auth.uid()` = `p_sub`
-- and returns the returned ids as 'id,id' ('<none>' for zero rows), or
-- '<sqlstate>:<message>' on error. Each call is its own subtransaction.
create function pg_temp.delete_returning(p_role text, p_sub text, p_bundle uuid, p_author uuid)
  returns text language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute format(
      'with d as (delete from public.bundles where id = %L and author_id = %L returning id) '
      || 'select coalesce(string_agg(id::text, '','' order by id), ''<none>'') from d',
      p_bundle, p_author)
      into v_out;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

-- Same, for an arbitrary statement; returns 'OK' or '<sqlstate>:<message>'.
create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_out text := 'OK';
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

create function pg_temp.table_acl(p_table regclass) returns text
  language sql stable as $$
  select coalesce(string_agg(grantee || ':' || privs, '|' order by grantee), '')
    from (
      select case when a.grantee = 0 then 'PUBLIC' else r.rolname end as grantee,
             string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
        from pg_class c
        cross join lateral aclexplode(c.relacl) a
        left join pg_roles r on r.oid = a.grantee
       where c.oid = p_table
         and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))
       group by 1
    ) s;
$$;

create function pg_temp.members(p_bundle uuid) returns text
  language sql stable as $$
  select coalesce(string_agg(book_id::text, ',' order by book_id), '<none>')
    from public.bundle_books where bundle_id = p_bundle;
$$;

-- ============================================================
-- Part 0: fixtures, written as the table owner.
-- Author A: published books a1, a2; a draft bundle "P070 disposable"
-- and a published "Fixture Bundle", both with members a1, a2.
-- Author B: published books b1, b2; a draft bundle with members b1, b2.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0700000-0000-4000-8000-00000000000a', 'p070-author-a@test', now(), '{"role":"author","display_name":"P070 A"}'),
  ('e0700000-0000-4000-8000-00000000000b', 'p070-author-b@test', now(), '{"role":"author","display_name":"P070 B"}');

update public.profiles set role = 'author'
  where id in ('e0700000-0000-4000-8000-00000000000a', 'e0700000-0000-4000-8000-00000000000b');

insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0701000-0000-4000-8000-0000000000a1', 'e0700000-0000-4000-8000-00000000000a', 'P070 A1', 'published', 199, now()),
  ('e0701000-0000-4000-8000-0000000000a2', 'e0700000-0000-4000-8000-00000000000a', 'P070 A2', 'published', 0,   now()),
  ('e0701000-0000-4000-8000-0000000000b1', 'e0700000-0000-4000-8000-00000000000b', 'P070 B1', 'published', 0,   now()),
  ('e0701000-0000-4000-8000-0000000000b2', 'e0700000-0000-4000-8000-00000000000b', 'P070 B2', 'published', 0,   now());

insert into public.bundles (id, author_id, title, status, price_all) values
  ('e0702000-0000-4000-8000-0000000000a1', 'e0700000-0000-4000-8000-00000000000a', 'P070 disposable', 'draft',     199),
  ('e0702000-0000-4000-8000-0000000000a2', 'e0700000-0000-4000-8000-00000000000a', 'Fixture Bundle',  'published', 0),
  ('e0702000-0000-4000-8000-0000000000b1', 'e0700000-0000-4000-8000-00000000000b', 'P070 B draft',    'draft',     0);

insert into public.bundle_books (bundle_id, book_id) values
  ('e0702000-0000-4000-8000-0000000000a1', 'e0701000-0000-4000-8000-0000000000a1'),
  ('e0702000-0000-4000-8000-0000000000a1', 'e0701000-0000-4000-8000-0000000000a2'),
  ('e0702000-0000-4000-8000-0000000000a2', 'e0701000-0000-4000-8000-0000000000a1'),
  ('e0702000-0000-4000-8000-0000000000a2', 'e0701000-0000-4000-8000-0000000000a2'),
  ('e0702000-0000-4000-8000-0000000000b1', 'e0701000-0000-4000-8000-0000000000b1'),
  ('e0702000-0000-4000-8000-0000000000b1', 'e0701000-0000-4000-8000-0000000000b2');

-- ============================================================
-- Part 1: the ACLs deleteBundle depends on.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select relrowsecurity from pg_class where oid = 'public.bundles'::regclass),
    'part1: bundles keeps RLS enabled');
  perform pg_temp.assert(
    pg_temp.table_acl('public.bundles') = 'anon:SELECT|authenticated:DELETE,SELECT',
    format('part1: bundles table ACL -- got %s', pg_temp.table_acl('public.bundles')));
  perform pg_temp.assert(
    pg_temp.table_acl('public.bundle_books') = 'anon:SELECT|authenticated:SELECT',
    format('part1: bundle_books stays SELECT-only for anon and authenticated -- got %s',
           pg_temp.table_acl('public.bundle_books')));
  perform pg_temp.assert(
    (select confdeltype = 'c' from pg_constraint
      where conrelid = 'public.bundle_books'::regclass and contype = 'f'
        and confrelid = 'public.bundles'::regclass),
    'part1: bundle_books.bundle_id keeps ON DELETE CASCADE');
end $$;

-- ============================================================
-- Part 2: refusals change nothing.
-- ============================================================
do $$
declare
  v_out text;
begin
  -- B, bound to B's own id (what deleteBundle sends), targets A's draft.
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000b',
    'e0702000-0000-4000-8000-0000000000a1', 'e0700000-0000-4000-8000-00000000000b');
  perform pg_temp.assert(v_out = '<none>', format('part2: another author gets zero rows -- got %s', v_out));

  -- B forges A's author id: the policy still refuses.
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000b',
    'e0702000-0000-4000-8000-0000000000a1', 'e0700000-0000-4000-8000-00000000000a');
  perform pg_temp.assert(v_out = '<none>', format('part2: a forged author id gets zero rows -- got %s', v_out));

  -- The same two attempts on A's PUBLISHED bundle, which B can see: only
  -- the delete policy stands between B and the row.
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000b',
    'e0702000-0000-4000-8000-0000000000a2', 'e0700000-0000-4000-8000-00000000000b');
  perform pg_temp.assert(v_out = '<none>', format('part2: another author gets zero rows for a published bundle -- got %s', v_out));
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000b',
    'e0702000-0000-4000-8000-0000000000a2', 'e0700000-0000-4000-8000-00000000000a');
  perform pg_temp.assert(v_out = '<none>', format('part2: a forged author id gets zero rows for a published bundle -- got %s', v_out));

  -- A names A's bundle with B's author id: the author_id predicate refuses.
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000a',
    'e0702000-0000-4000-8000-0000000000a1', 'e0700000-0000-4000-8000-00000000000b');
  perform pg_temp.assert(v_out = '<none>', format('part2: a mismatched author predicate gets zero rows -- got %s', v_out));

  -- A names a bundle that does not exist.
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000a',
    'e0702000-0000-4000-8000-0000000000ff', 'e0700000-0000-4000-8000-00000000000a');
  perform pg_temp.assert(v_out = '<none>', format('part2: a missing bundle gets zero rows -- got %s', v_out));

  -- anon holds no DELETE.
  v_out := pg_temp.delete_returning('anon', null,
    'e0702000-0000-4000-8000-0000000000a1', 'e0700000-0000-4000-8000-00000000000a');
  perform pg_temp.assert(v_out like '42501:permission denied for table bundles%',
    format('part2: anon cannot delete bundles -- got %s', v_out));

  -- authenticated cannot delete membership directly.
  v_out := pg_temp.run_as('authenticated', 'e0700000-0000-4000-8000-00000000000a',
    $q$delete from public.bundle_books where bundle_id = 'e0702000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v_out like '42501:permission denied for table bundle_books%',
    format('part2: authenticated cannot delete bundle_books -- got %s', v_out));

  perform pg_temp.assert(
    (select count(*) from public.bundles where id::text like 'e0702000-%') = 3
    and pg_temp.members('e0702000-0000-4000-8000-0000000000a1') = 'e0701000-0000-4000-8000-0000000000a1,e0701000-0000-4000-8000-0000000000a2'
    and pg_temp.members('e0702000-0000-4000-8000-0000000000a2') = 'e0701000-0000-4000-8000-0000000000a1,e0701000-0000-4000-8000-0000000000a2'
    and pg_temp.members('e0702000-0000-4000-8000-0000000000b1') = 'e0701000-0000-4000-8000-0000000000b1,e0701000-0000-4000-8000-0000000000b2',
    'part2: every refusal left all bundles and memberships intact');
end $$;

-- ============================================================
-- Part 3: the owner's delete returns exactly its own id, and the
-- cascade removes exactly that bundle's membership.
-- ============================================================
do $$
declare
  v_out text;
begin
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000a',
    'e0702000-0000-4000-8000-0000000000a1', 'e0700000-0000-4000-8000-00000000000a');
  perform pg_temp.assert(v_out = 'e0702000-0000-4000-8000-0000000000a1',
    format('part3: the owner''s draft delete returns exactly its id -- got %s', v_out));

  perform pg_temp.assert(
    not exists (select 1 from public.bundles where id = 'e0702000-0000-4000-8000-0000000000a1')
    and pg_temp.members('e0702000-0000-4000-8000-0000000000a1') = '<none>',
    'part3: the draft bundle and its membership are gone');
  perform pg_temp.assert(
    (select title from public.bundles where id = 'e0702000-0000-4000-8000-0000000000a2') = 'Fixture Bundle'
    and pg_temp.members('e0702000-0000-4000-8000-0000000000a2') = 'e0701000-0000-4000-8000-0000000000a1,e0701000-0000-4000-8000-0000000000a2'
    and pg_temp.members('e0702000-0000-4000-8000-0000000000b1') = 'e0701000-0000-4000-8000-0000000000b1,e0701000-0000-4000-8000-0000000000b2',
    'part3: Fixture Bundle and the other author''s bundle are untouched');
  perform pg_temp.assert(
    (select count(*) from public.books where id::text like 'e0701000-%') = 4,
    'part3: no book was deleted');

  -- Deleting the same bundle again returns nothing: no second success.
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000a',
    'e0702000-0000-4000-8000-0000000000a1', 'e0700000-0000-4000-8000-00000000000a');
  perform pg_temp.assert(v_out = '<none>', format('part3: a repeated delete returns zero rows -- got %s', v_out));

  -- A published bundle is deleted and returned the same way.
  v_out := pg_temp.delete_returning('authenticated', 'e0700000-0000-4000-8000-00000000000a',
    'e0702000-0000-4000-8000-0000000000a2', 'e0700000-0000-4000-8000-00000000000a');
  perform pg_temp.assert(v_out = 'e0702000-0000-4000-8000-0000000000a2',
    format('part3: the owner''s published delete returns exactly its id -- got %s', v_out));
  perform pg_temp.assert(
    pg_temp.members('e0702000-0000-4000-8000-0000000000a2') = '<none>'
    and pg_temp.members('e0702000-0000-4000-8000-0000000000b1') = 'e0701000-0000-4000-8000-0000000000b1,e0701000-0000-4000-8000-0000000000b2',
    'part3: the published bundle''s membership cascaded away, B''s did not');
end $$;

-- ============================================================
-- Part 4: the suite really ran.
-- ============================================================
do $$
declare
  v_n integer;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n <> 20 then
    raise exception 'FAIL: expected 20 assertions to run, found %', v_n;
  end if;
end $$;

select 'BUNDLE-DELETE-SAFETY-1 070 suite: all assertions passed' as result;

rollback;
