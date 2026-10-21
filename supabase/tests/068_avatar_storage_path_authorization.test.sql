-- Committed SQL regression suite for AVATAR-STORAGE-PATH-AUTH-1
-- (supabase/migrations/20260924160846_avatar_storage_path_authorization.sql):
-- authenticated can no longer write public.profiles.avatar_path in any
-- statement shape, while display_name, bio and public_author_name stay
-- directly updatable on the caller's own row, RLS still isolates other
-- users' rows, and service_role -- the trusted server path updateProfile
-- now uses -- keeps full write access.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/068_avatar_storage_path_authorization.test.sql
--
-- It must also pass against the OTHER build path -- the base schema.sql
-- plus the migration -- and
-- 068_avatar_storage_path_authorization_catalog_equivalence.sh proves
-- those two paths agree. Against the BASE schema alone it must FAIL: that
-- is the negative control showing this suite can see the hole it exists
-- to close.
--
-- Part 5 also pins the avatars bucket's Storage policies (unchanged by
-- this migration): a signed-in user cannot create, overwrite, move or
-- delete an object under another user's avatar prefix.
--
-- PEN-NAMES-2 (20261019222500/20261019222600) narrowed this further:
-- bio is no longer writable by authenticated (E3, 18a), the
-- public_author_profiles view is gone (C5), support no longer reads
-- profiles directly (C13), and signed-in users have no write policy on
-- the avatars bucket at all (C9) -- photos go through the service-role
-- writer. Each assertion the PEN-NAMES-2 rule changed says so.
--
-- Everything runs in one transaction and is rolled back; every probe runs
-- in its own subtransaction. Privilege errors and RLS errors share
-- SQLSTATE 42501, so every expected failure also pins the message
-- fragment: "permission denied for table" is the ACL, "row-level
-- security" is the policy.

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

-- Runs one statement as `p_role` with `auth.uid()` = `p_sub` (null for
-- none) and returns 'OK:<rowcount>' or '<sqlstate>:<message>'.
create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_rows bigint;
  v_state text;
  v_msg text;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'OK:' || v_rows;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

create function pg_temp.expect_ok(p_role text, p_sub text, p_sql text, p_rows integer, p_message text)
  returns void language plpgsql as $$
declare
  v_out text := pg_temp.run_as(p_role, p_sub, p_sql);
begin
  perform pg_temp.assert(v_out = 'OK:' || p_rows, format('%s -- got %s', p_message, v_out));
end;
$$;

create function pg_temp.expect_error(p_role text, p_sub text, p_sql text, p_state text, p_fragment text, p_message text)
  returns void language plpgsql as $$
declare
  v_out text := pg_temp.run_as(p_role, p_sub, p_sql);
begin
  perform pg_temp.assert(
    v_out like p_state || ':%' and v_out like '%' || p_fragment || '%',
    format('%s -- got %s', p_message, v_out));
end;
$$;

-- Table-level ACL for anon, authenticated, service_role and PUBLIC, as
-- 'grantee:PRIV,PRIV|...'. The owner is left out (postgres on Supabase,
-- the test user here); part 2 checks it separately.
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
         and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
       group by 1
    ) s;
$$;

create function pg_temp.column_acl(p_table regclass) returns text
  language sql stable as $$
  select coalesce(string_agg(entry, '|' order by entry), '')
    from (
      select (case when a.grantee = 0 then 'PUBLIC' else r.rolname end)
             || ':' || a.privilege_type || ':'
             || string_agg(att.attname, ',' order by att.attname) as entry
        from pg_attribute att
        cross join lateral aclexplode(att.attacl) a
        left join pg_roles r on r.oid = a.grantee
       where att.attrelid = p_table
         and att.attnum > 0 and not att.attisdropped
       group by a.grantee, r.rolname, a.privilege_type
    ) s;
$$;

create function pg_temp.profile_rows() returns text
  language sql stable as $$
  select coalesce(string_agg(row_to_json(p)::text, ',' order by p.id), '<none>')
    from public.profiles p
   where p.id::text like 'e0680000-%';
$$;

-- ============================================================
-- Part 0: fixtures. Every profile is created by the REAL path -- the
-- on_auth_user_created trigger (handle_new_user) -- never by a direct
-- authenticated INSERT, which is not granted and must stay so. The
-- avatar paths are then set as the table owner, the way historical rows
-- were written: A is a reader with no avatar, B an author with a
-- canonical avatar, C an author whose value is legacy/non-canonical.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0680000-0000-4000-8000-00000000000a', 'p068-a@test', now(), '{"role":"reader","display_name":"P068 A"}'),
  ('e0680000-0000-4000-8000-00000000000b', 'p068-b@test', now(), '{"role":"author","display_name":"P068 B"}'),
  ('e0680000-0000-4000-8000-00000000000c', 'p068-c@test', now(), '{"role":"author","display_name":"P068 C"}');

do $$
begin
  perform pg_temp.assert(
    pg_temp.profile_rows() like '%"id":"e0680000-0000-4000-8000-00000000000a"%"avatar_path":null%'
    and (select count(*) from public.profiles where id::text like 'e0680000-%' and avatar_path is null) = 3
    and (select role from public.profiles where id = 'e0680000-0000-4000-8000-00000000000a') = 'reader'
    and (select public_author_name from public.profiles where id = 'e0680000-0000-4000-8000-00000000000b') = 'P068 B',
    'part0: the signup trigger created all three profiles with a null avatar_path');
end $$;

update public.profiles set avatar_path = 'e0680000-0000-4000-8000-00000000000b/avatar.png'
  where id = 'e0680000-0000-4000-8000-00000000000b';
update public.profiles set avatar_path = 'legacy/avatars/c.JPEG'
  where id = 'e0680000-0000-4000-8000-00000000000c';

insert into storage.objects (bucket_id, name) values
  ('avatars', 'e0680000-0000-4000-8000-00000000000b/avatar.png');

-- B has a draft book: since AUTHOR-VIEW-REQUIRE-BOOK-1 (migration
-- 20261019154308) public_author_profiles listed an author only once they
-- had a book. PEN-NAMES-2 removed that view; the book stays so part 4's
-- "no public read of avatar_path" check covers an author with a book.
insert into public.books (id, author_id, title) values
  ('e0680001-0000-4000-8000-00000000000b', 'e0680000-0000-4000-8000-00000000000b', 'P068 B draft');

create temp table fixture_rows_before as select pg_temp.profile_rows() as fp;

-- ============================================================
-- Part 1: privilege and policy metadata.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'public.profiles'::regclass),
    'part1: profiles keeps RLS enabled, not forced');

  -- Table level: authenticated SELECT only; anon nothing; no PUBLIC entry.
  perform pg_temp.assert(
    pg_temp.table_acl('public.profiles') =
      'authenticated:SELECT'
      || '|service_role:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part1: profiles table ACL -- got %s', pg_temp.table_acl('public.profiles')));

  -- Column level: exactly display_name and public_author_name --
  -- avatar_path is gone, and (PEN-NAMES-2 E3) so is bio.
  perform pg_temp.assert(
    pg_temp.column_acl('public.profiles') = 'authenticated:UPDATE:display_name,public_author_name',
    format('part1: profiles column ACL -- got %s', pg_temp.column_acl('public.profiles')));

  -- Policies: the same three, with the same definitions.
  perform pg_temp.assert(
    (select string_agg(policyname || '|' || cmd || '|' || permissive || '|' || array_to_string(roles, ',')
                       || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' order by policyname)
       from pg_policies where schemaname = 'public' and tablename = 'profiles')
    = 'Staff with an authorized permission can view any profile|SELECT|PERMISSIVE|public|'
      || '(staff_has_permission(''reports.view''::text) OR staff_has_permission(''staff.view''::text) OR '
      || 'staff_has_permission(''audit.view''::text))|' || E'\n'
      || 'Users can update their own profile|UPDATE|PERMISSIVE|public|(auth.uid() = id)|(auth.uid() = id)' || E'\n'
      || 'Users can view their own full profile|SELECT|PERMISSIVE|public|(auth.uid() = id)|',
    'part1: the three profiles policies (PEN-NAMES-2 C13: refunds.view no longer in the staff policy)');

  -- Triggers on profiles: the BEFORE DELETE reader-hold cleanup and,
  -- since PEN-NAMES-1 (migration 20261019184512), the AFTER trigger that
  -- keeps the default pen name equal to public_author_name.
  perform pg_temp.assert(
    (select string_agg(tgname, ',' order by tgname) from pg_trigger
      where tgrelid = 'public.profiles'::regclass and not tgisinternal)
      = 'clear_expired_reader_holds_trigger,profiles_sync_default_pen_name',
    'part1: profiles triggers unchanged');

  -- PEN-NAMES-2 (C5): the public_author_profiles view is gone.
  perform pg_temp.assert(
    to_regclass('public.public_author_profiles') is null,
    'part1 (PEN-NAMES-2): public_author_profiles no longer exists');
end $$;

-- ============================================================
-- Part 2: effective privileges, resolved per role and column (role
-- membership and PUBLIC inheritance included).
-- ============================================================
do $$
declare
  v_col text;
begin
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'avatar_path', 'UPDATE'),
    'part2: authenticated has no UPDATE on avatar_path');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'avatar_path', 'INSERT'),
    'part2: authenticated has no INSERT on avatar_path');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.profiles', 'INSERT'),
    'part2: authenticated has no INSERT on profiles');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.profiles', 'DELETE'),
    'part2: authenticated has no DELETE on profiles');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
    'part2: authenticated has no table-level UPDATE on profiles');
  perform pg_temp.assert(
    has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.profiles', 'bio', 'UPDATE')
    and has_column_privilege('authenticated', 'public.profiles', 'public_author_name', 'UPDATE'),
    'part2: authenticated keeps UPDATE on display_name and public_author_name (PEN-NAMES-2 E3: not bio)');
  foreach v_col in array array['id', 'role', 'avatar_path', 'stripe_account_id', 'stripe_payouts_enabled', 'created_at'] loop
    perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', v_col, 'UPDATE'),
      format('part2: authenticated has no UPDATE on %s', v_col));
  end loop;
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.profiles', 'SELECT'),
    'part2: authenticated keeps SELECT');
  perform pg_temp.assert(
    not has_any_column_privilege('anon', 'public.profiles', 'SELECT, INSERT, UPDATE, REFERENCES')
    and not has_table_privilege('anon', 'public.profiles', 'DELETE, TRUNCATE, TRIGGER, MAINTAIN'),
    'part2: anon holds nothing on profiles');
  perform pg_temp.assert(
    not has_any_column_privilege('public', 'public.profiles', 'SELECT, INSERT, UPDATE, REFERENCES')
    and not has_table_privilege('public', 'public.profiles', 'DELETE, TRUNCATE, TRIGGER, MAINTAIN'),
    'part2: PUBLIC holds nothing on profiles');
  perform pg_temp.assert(
    has_table_privilege('service_role', 'public.profiles', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    and has_column_privilege('service_role', 'public.profiles', 'avatar_path', 'UPDATE'),
    'part2: service_role keeps every privilege, avatar_path UPDATE included');
  perform pg_temp.assert(
    has_table_privilege((select relowner::regrole::text from pg_class where oid = 'public.profiles'::regclass),
      'public.profiles', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'part2: the table owner keeps every privilege');
end $$;

-- ============================================================
-- Part 3: authenticated cannot name avatar_path in any write shape.
-- A = e0680000-...0a (reader, no avatar), B = ...0b (author, canonical
-- avatar), C = ...0c (legacy value).
-- ============================================================
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$update public.profiles set avatar_path = 'e0680000-0000-4000-8000-00000000000b/avatar.png' where id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  '42501', 'permission denied for table profiles', 'part3: pointing avatar_path at another user''s object is refused');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$update public.profiles set avatar_path = 'e0680000-0000-4000-8000-00000000000a/avatar.png' where id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  '42501', 'permission denied for table profiles', 'part3: even the caller''s own canonical path is refused');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000b',
  $q$update public.profiles set avatar_path = null where id = 'e0680000-0000-4000-8000-00000000000b'$q$,
  '42501', 'permission denied for table profiles', 'part3: clearing avatar_path to null is refused');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000b',
  $q$update public.profiles set avatar_path = avatar_path where id = 'e0680000-0000-4000-8000-00000000000b'$q$,
  '42501', 'permission denied for table profiles', 'part3: a self-assignment of avatar_path is refused');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$update public.profiles set display_name = 'P068 A2', bio = 'b', avatar_path = 'e0680000-0000-4000-8000-00000000000b/avatar.png' where id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  '42501', 'permission denied for table profiles', 'part3: the pre-Patch-9 updateProfile payload (name + bio + avatar_path) is refused as a whole');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$update public.profiles p set avatar_path = v.avatar_path from public.public_pen_names v where p.id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  '42501', 'permission denied for table profiles', 'part3: UPDATE ... FROM copying a readable foreign path (PEN-NAMES-2: from public_pen_names, public_author_profiles is gone) is refused');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$with c as (select 'e0680000-0000-4000-8000-00000000000b/avatar.png'::text as p) update public.profiles set avatar_path = (select p from c) where id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  '42501', 'permission denied for table profiles', 'part3: a CTE/subquery-fed avatar_path UPDATE is refused');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$insert into public.profiles (id, role, display_name, avatar_path) values ('e0680000-0000-4000-8000-00000000000a', 'reader', 'x', 'e0680000-0000-4000-8000-00000000000b/avatar.png')$q$,
  '42501', 'permission denied for table profiles', 'part3: INSERT naming avatar_path is refused');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$insert into public.profiles (id, role, display_name) values ('e0680000-0000-4000-8000-00000000000a', 'reader', 'x') on conflict (id) do update set avatar_path = 'e0680000-0000-4000-8000-00000000000b/avatar.png'$q$,
  '42501', 'permission denied for table profiles', 'part3: an upsert setting avatar_path is refused');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$insert into public.profiles (id, role, display_name) values ('e0680000-0000-4000-8000-0000000000ff', 'reader', 'new')$q$,
  '42501', 'permission denied for table profiles', 'part3: a direct profile INSERT stays refused (profiles come from the signup trigger)');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$delete from public.profiles where id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  '42501', 'permission denied for table profiles', 'part3: a direct profile DELETE stays refused');
select pg_temp.expect_error('anon', null,
  $q$update public.profiles set avatar_path = 'e0680000-0000-4000-8000-00000000000b/avatar.png'$q$,
  '42501', 'permission denied for table profiles', 'part3: anon cannot write avatar_path');
select pg_temp.expect_error('anon', null,
  $q$update public.profiles set display_name = 'anon'$q$,
  '42501', 'permission denied for table profiles', 'part3: anon cannot update any column');
select pg_temp.expect_error('anon', null,
  $q$select avatar_path from public.profiles$q$,
  '42501', 'permission denied for table profiles', 'part3: anon cannot read the base table');

do $$
begin
  perform pg_temp.assert(pg_temp.profile_rows() = (select fp from fixture_rows_before),
    'part3: every refused statement left every profile exactly as it was');
end $$;

-- ============================================================
-- Part 4: what must keep working.
-- ============================================================
-- The exact session payloads updateProfile sends. PEN-NAMES-2 (E3):
-- bio is no longer among them (the pen name carries the public bio), and
-- a payload that names bio is refused as a whole.
select pg_temp.expect_ok('authenticated', 'e0680000-0000-4000-8000-00000000000b',
  $q$update public.profiles set display_name = 'P068 B2', public_author_name = 'Pen B2' where id = 'e0680000-0000-4000-8000-00000000000b'$q$,
  1, 'part4 (PEN-NAMES-2): an author updates name and pen name on their own row');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$update public.profiles set display_name = 'P068 A2', bio = 'bio A' where id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  '42501', 'permission denied for table profiles', 'part4 (PEN-NAMES-2): a payload naming bio is refused');
select pg_temp.expect_ok('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$update public.profiles set display_name = 'Hijacked' where id = 'e0680000-0000-4000-8000-00000000000b'$q$,
  0, 'part4: RLS still matches zero rows for another user''s profile');
select pg_temp.expect_ok('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$select 1 from public.profiles where id = 'e0680000-0000-4000-8000-00000000000b'$q$,
  0, 'part4: RLS still hides another user''s profile row');
select pg_temp.expect_ok('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$select avatar_path from public.profiles where id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  1, 'part4: a user can still read their own avatar_path');
select pg_temp.expect_error('anon', null,
  $q$select avatar_path from public.public_author_profiles where id = 'e0680000-0000-4000-8000-00000000000b'$q$,
  '42P01', 'does not exist', 'part4 (PEN-NAMES-2): anon has no public view of a profile''s avatar_path any more');
-- The trusted writer's exact statement shape: filtered by id, returning.
select pg_temp.expect_ok('service_role', null,
  $q$update public.profiles set avatar_path = 'e0680000-0000-4000-8000-00000000000a/avatar.png' where id = 'e0680000-0000-4000-8000-00000000000a' returning id, avatar_path$q$,
  1, 'part4: service_role writes a derived avatar_path for exactly one row');
select pg_temp.expect_ok('service_role', null,
  $q$update public.profiles set avatar_path = null where id = 'e0680000-0000-4000-8000-00000000000a'$q$,
  1, 'part4: service_role can clear avatar_path');

do $$
begin
  perform pg_temp.assert(
    (select display_name || '|' || coalesce(bio, '') || '|' || coalesce(public_author_name, '') || '|' || coalesce(avatar_path, '<null>')
       from public.profiles where id = 'e0680000-0000-4000-8000-00000000000b')
      = 'P068 B2||Pen B2|e0680000-0000-4000-8000-00000000000b/avatar.png',
    'part4: the author''s permitted fields persisted, bio stayed unset and the avatar_path did not move');
  perform pg_temp.assert(
    (select display_name from public.profiles where id = 'e0680000-0000-4000-8000-00000000000b') <> 'Hijacked',
    'part4: the cross-user update took no effect');
  perform pg_temp.assert(
    (select avatar_path from public.profiles where id = 'e0680000-0000-4000-8000-00000000000c') = 'legacy/avatars/c.JPEG',
    'part4: the legacy value is untouched');
end $$;

-- ============================================================
-- Part 5: the avatars bucket's own Storage policies: no cross-prefix
-- create, overwrite, move or delete by a signed-in user. PEN-NAMES-2
-- (C9): no own-prefix write either -- signed-in users have no write
-- policy on avatars at all.
-- ============================================================
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$insert into storage.objects (bucket_id, name) values ('avatars', 'e0680000-0000-4000-8000-00000000000b/avatar.png')$q$,
  '42501', 'row-level security', 'part5: uploading into another user''s avatar prefix is refused');
-- A traversal-SHAPED key whose first folder is the caller's own: before
-- PEN-NAMES-2 this created a separate literal object; now every user
-- insert into avatars is refused.
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$insert into storage.objects (bucket_id, name) values ('avatars', 'e0680000-0000-4000-8000-00000000000a/../e0680000-0000-4000-8000-00000000000b/avatar.png')$q$,
  '42501', 'row-level security', 'part5 (PEN-NAMES-2): a traversal-shaped key under the caller''s own first folder is refused');
select pg_temp.expect_ok('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$update storage.objects set name = name where bucket_id = 'avatars' and name = 'e0680000-0000-4000-8000-00000000000b/avatar.png'$q$,
  0, 'part5: another user''s avatar object cannot be overwritten (the UPDATE sees no row)');
select pg_temp.expect_ok('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$delete from storage.objects where bucket_id = 'avatars'$q$,
  0, 'part5: no avatar object can be deleted by a signed-in user (the bucket has no DELETE policy)');
select pg_temp.expect_error('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$insert into storage.objects (bucket_id, name) values ('avatars', 'e0680000-0000-4000-8000-00000000000a/avatar.png')$q$,
  '42501', 'row-level security', 'part5 (PEN-NAMES-2): a user can no longer upload under their own prefix (service-role writer only)');
select pg_temp.expect_ok('authenticated', 'e0680000-0000-4000-8000-00000000000a',
  $q$update storage.objects set name = 'e0680000-0000-4000-8000-00000000000b/moved.png' where bucket_id = 'avatars' and name = 'e0680000-0000-4000-8000-00000000000b/avatar.png'$q$,
  0, 'part5 (PEN-NAMES-2): a user cannot move any avatar object (the UPDATE sees no row)');

do $$
begin
  perform pg_temp.assert(
    (select count(*) from storage.objects where bucket_id = 'avatars' and name = 'e0680000-0000-4000-8000-00000000000b/avatar.png') = 1
    and (select count(*) from storage.objects where bucket_id = 'avatars') = 1
    and (select count(*) from storage.objects where bucket_id = 'avatars'
          and split_part(name, '/', 1) = 'e0680000-0000-4000-8000-00000000000a') = 0,
    'part5 (PEN-NAMES-2): the victim''s object survives unchanged and no user key was added');
end $$;

-- ============================================================
-- Part 6: the suite really ran.
-- ============================================================
do $$
declare
  v_n integer;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n <> 57 then
    raise exception 'FAIL: expected 57 assertions to run, found %', v_n;
  end if;
end $$;

select 'AVATAR-STORAGE-PATH-AUTH-1 068 suite: all assertions passed' as result;

rollback;
