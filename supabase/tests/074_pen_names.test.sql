-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for PEN-NAMES-1
-- (supabase/migrations/20261019184512_pen_names.sql):
--
-- * pen_names is owner-only: anon reads nothing, authenticated reads its
--   own rows (staff with reports.resolve every row) and may update only
--   name, bio and links; author_id, avatar_path, is_default, INSERT and
--   DELETE are server-only; links are at most 3 https URLs;
-- * public.public_pen_names exposes exactly id, name, bio, avatar_path,
--   links -- no author_id -- and only pen names used by a book (any
--   status), a series or a bundle;
-- * the default pen name follows profiles.public_author_name both ways
--   (signup, becoming an author, Profile edits, a clash is refused) and
--   cannot be deleted while its account exists; deleting an account with
--   books still works;
-- * books: default fill, two-way books.pen_name sync, ownership, 11a (one
--   pen name per series/bundle) and 14a (no pen name change while in a
--   series or bundle);
-- * bundle RPCs take the pen name from their books and refuse mixed sets
--   before writing the bundle;
-- * pen_name_follows: own rows only, never your own pen name, and the
--   author_follows mirror (insert and delete);
-- * search_books() matches the book's own pen name, never the account's
--   name for a book under another pen name;
-- * staff_remove_pen_name_links(): reports.resolve only, audited, and
--   the author may add links again; the audit filter knows the event;
-- * r4 (17a): a new default pen name starts with the profile's bio and
--   canonical photo; pen_names.avatar_path accepts only a pen name key or
--   the account's own "<id>/avatar.<ext>";
-- * r5 (audit F1, F2): writing a series or a follow for ANOTHER account
--   fails with the same error whatever the pen name is (no oracle tying a
--   pen name to an account); resolve_author_pen_name is service_role only.
--
-- The backfill over populated data and the schema.sql / migration
-- equivalence are in 074_pen_names_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/074_pen_names.test.sql
--
-- It must also pass against the base schema.sql plus the migration.
-- Against the BASE schema alone it fails at once (no pen_names): the
-- negative control.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);
grant select, update on pg_temp.assertions_run to anon, authenticated;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs p_sql as p_role with auth.uid() = p_sub; returns 'OK:<rows>' or
-- '<sqlstate>:<message>'. Each call is its own subtransaction.
create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_rows bigint;
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

-- Same, for a query returning one text value.
create function pg_temp.value_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

create function pg_temp.pen(p_author uuid, p_name text) returns uuid
  language sql stable as $$
  select id from public.pen_names where author_id = p_author and lower(name) = lower(p_name);
$$;

create function pg_temp.dflt(p_author uuid) returns uuid
  language sql stable as $$
  select id from public.pen_names where author_id = p_author and is_default;
$$;

-- ============================================================
-- Part 0: fixtures, through the signup trigger.
--   A  author 'P074 Ana' (books under the default and 'P074 Owl')
--   B  author 'P074 Ben'
--   N  author 'P074 Nobook' (signed up, no book)
--   R  reader, M moderator (staff), X reader who becomes an author
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0740000-0000-4000-8000-00000000000a', 'p074-a@test', now(), '{"role":"author","display_name":"P074 Ana"}'),
  ('e0740000-0000-4000-8000-00000000000b', 'p074-b@test', now(), '{"role":"author","display_name":"P074 Ben"}'),
  ('e0740000-0000-4000-8000-00000000000c', 'p074-n@test', now(), '{"role":"author","display_name":"P074 Nobook"}'),
  ('e0740000-0000-4000-8000-0000000000aa', 'p074-r@test', now(), '{"role":"reader","display_name":"P074 Reader"}'),
  ('e0740000-0000-4000-8000-0000000000dd', 'p074-m@test', now(), '{"role":"reader","display_name":"P074 Moderator"}'),
  ('e0740000-0000-4000-8000-0000000000ee', 'p074-x@test', now(), '{"role":"reader","display_name":"P074 Becomes"}'),
  ('e0740000-0000-4000-8000-0000000000ef', 'p074-y@test', now(), '{"role":"reader","display_name":"P074 Legacy"}');

insert into public.staff_members (user_id, role) values ('e0740000-0000-4000-8000-0000000000dd', 'moderator');

insert into public.pen_names (id, author_id, name, bio, links) values
  ('e0740002-0000-4000-8000-000000000001', 'e0740000-0000-4000-8000-00000000000a', 'P074 Owl', 'Owl bio', '["https://owl.example"]'),
  ('e0740002-0000-4000-8000-000000000002', 'e0740000-0000-4000-8000-00000000000a', 'P074 Unused', null, '[]');

insert into public.books (id, author_id, title, status, price_all, published_at, pen_name_id) values
  ('e0740001-0000-4000-8000-0000000000a1', 'e0740000-0000-4000-8000-00000000000a', 'P074 Plain', 'published', 199, now(), null),
  ('e0740001-0000-4000-8000-0000000000a2', 'e0740000-0000-4000-8000-00000000000a', 'P074 Hoot One', 'published', 199, now(), 'e0740002-0000-4000-8000-000000000001'),
  ('e0740001-0000-4000-8000-0000000000a3', 'e0740000-0000-4000-8000-00000000000a', 'P074 Hoot Two', 'published', 199, now(), 'e0740002-0000-4000-8000-000000000001'),
  ('e0740001-0000-4000-8000-0000000000a4', 'e0740000-0000-4000-8000-00000000000a', 'P074 Plain Two', 'published', 199, now(), null),
  ('e0740001-0000-4000-8000-0000000000b1', 'e0740000-0000-4000-8000-00000000000b', 'P074 Ben Book', 'draft', 199, null, null);

do $$
begin
  perform pg_temp.assert(
    (select string_agg(p.public_author_name || '=' || pn.name, ',' order by pn.name)
       from public.pen_names pn join public.profiles p on p.id = pn.author_id
      where pn.is_default and pn.author_id::text like 'e0740000-%')
      = 'P074 Ana=P074 Ana,P074 Ben=P074 Ben,P074 Nobook=P074 Nobook',
    'part0: signup gave each author (and no reader) a default pen name equal to the public name');
  perform pg_temp.assert(
    (select pen_name_id from public.books where id = 'e0740001-0000-4000-8000-0000000000a1')
      = pg_temp.dflt('e0740000-0000-4000-8000-00000000000a')
    and (select pen_name from public.books where id = 'e0740001-0000-4000-8000-0000000000a1') is null
    and (select pen_name from public.books where id = 'e0740001-0000-4000-8000-0000000000a2') = 'P074 Owl',
    'part0: a book without pen_name_id gets the default (text null); with one, the text is its name');
end $$;

-- ============================================================
-- Part 1: privileges and RLS on pen_names.
-- ============================================================
do $$
declare
  v text;
  c text;
begin
  perform pg_temp.assert(not has_table_privilege('anon', 'public.pen_names', 'SELECT'), 'part1: anon cannot read pen_names');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.pen_name_follows', 'SELECT'), 'part1: anon cannot read pen_name_follows');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.pen_names', 'INSERT'), 'part1: authenticated cannot insert pen names');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.pen_names', 'DELETE'), 'part1: authenticated cannot delete pen names');
  foreach c in array array['name', 'bio', 'links'] loop
    perform pg_temp.assert(has_column_privilege('authenticated', 'public.pen_names', c, 'UPDATE'), format('part1: authenticated updates %s', c));
  end loop;
  foreach c in array array['id', 'author_id', 'avatar_path', 'is_default', 'created_at'] loop
    perform pg_temp.assert(not has_column_privilege('authenticated', 'public.pen_names', c, 'UPDATE'), format('part1: authenticated cannot update %s', c));
  end loop;
  perform pg_temp.assert((select relrowsecurity from pg_class where oid = 'public.pen_names'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.pen_name_follows'::regclass), 'part1: RLS on both tables');

  v := pg_temp.value_as('authenticated', 'e0740000-0000-4000-8000-00000000000b',
    $q$select string_agg(name, ',' order by name) from public.pen_names$q$);
  perform pg_temp.assert(v = 'P074 Ben', format('part1: an author reads only their own pen names -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0740000-0000-4000-8000-0000000000aa',
    $q$select count(*)::text from public.pen_names$q$);
  perform pg_temp.assert(v = '0', format('part1: a reader reads no pen names -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0740000-0000-4000-8000-0000000000dd',
    $q$select author_id::text from public.pen_names where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v = 'e0740000-0000-4000-8000-00000000000a', format('part1: a moderator (reports.resolve) sees the account behind a pen name -- got %s', v));

  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.pen_names set bio = 'New owl bio', links = '["https://a.example","https://b.example/x?y=1"]' where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part1: the author edits bio and links -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000b',
    $q$update public.pen_names set bio = 'hijack' where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v = 'OK:0', format('part1: another author updates nothing -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.pen_names set avatar_path = 'e0740000-0000-4000-8000-00000000000b/avatar.jpg' where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v like '42501:%', format('part1: the author cannot write avatar_path -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.pen_names set is_default = true where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v like '42501:%', format('part1: the author cannot write is_default -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$insert into public.pen_names (author_id, name) values ('e0740000-0000-4000-8000-00000000000a', 'Direct')$q$);
  perform pg_temp.assert(v like '42501:%', format('part1: the author cannot insert directly -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$delete from public.pen_names where id = 'e0740002-0000-4000-8000-000000000002'$q$);
  perform pg_temp.assert(v like '42501:%', format('part1: the author cannot delete directly -- got %s', v));

  foreach c in array array['["http://a.example"]', '["https://"]', '["https://a b"]', '[1]', '{"a":1}',
                           '["https://a.example","https://b.example","https://c.example","https://d.example"]',
                           format('[%s]', to_json('https://a.example/' || repeat('x', 490)))] loop
    v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
      format('update public.pen_names set links = %L where id = %L', c, 'e0740002-0000-4000-8000-000000000001'));
    perform pg_temp.assert(v like '23514:%pen_names_links_check%', format('part1: links %s refused -- got %s', c, v));
  end loop;
  v := pg_temp.run_as('service_role', null,
    $q$update public.pen_names set avatar_path = 'e0740000-0000-4000-8000-00000000000b/avatar.jpg' where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v like '23514:%pen_names_avatar_path_check%', format('part1: avatar_path must be a random-folder pen-name key -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.pen_names set avatar_path = '0b2c3d4e-0000-4000-8000-000000000001/pen-name.png' where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part1: the server writer sets a random-folder photo -- got %s', v));
end $$;

-- ============================================================
-- Part 2: the public view.
-- ============================================================
do $$
declare
  v text;
begin
  perform pg_temp.assert(
    (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'public_pen_names')
      = array['id', 'name', 'bio', 'avatar_path', 'links'],
    'part2: exactly id, name, bio, avatar_path, links -- no author_id');
  perform pg_temp.assert(
    (select reloptions from pg_class where oid = 'public.public_pen_names'::regclass) is null
    and (select relowner from pg_class where oid = 'public.public_pen_names'::regclass)
      = (select relowner from pg_class where oid = 'public.pen_names'::regclass),
    'part2: a definer-rights view owned like pen_names');
  perform pg_temp.assert(
    (select array_agg(a.privilege_type::text order by a.privilege_type)
       from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.oid = 'public.public_pen_names'::regclass and a.grantee = 'anon'::regrole) = array['SELECT']
    and not exists (select 1 from pg_class c cross join lateral aclexplode(c.relacl) a
                     where c.oid = 'public.public_pen_names'::regclass and a.grantee = 0),
    'part2: anon holds SELECT only, PUBLIC nothing');

  v := pg_temp.value_as('anon', null,
    $q$select string_agg(name, ',' order by name) from public.public_pen_names where name like 'P074%'$q$);
  perform pg_temp.assert(v = 'P074 Ana,P074 Ben,P074 Owl',
    format('part2: anon sees pen names with a book (draft included), not the unused one nor a book-less signup name -- got %s', v));
  v := pg_temp.value_as('anon', null,
    $q$select bio || '|' || links::text from public.public_pen_names where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v = 'New owl bio|["https://a.example", "https://b.example/x?y=1"]', format('part2: bio and links readable -- got %s', v));
  v := pg_temp.run_as('anon', null, $q$update public.public_pen_names set bio = 'x' where false$q$);
  perform pg_temp.assert(v like '42501:%', format('part2: anon cannot write through the view -- got %s', v));

  -- A series alone makes a pen name public.
  insert into public.series (id, author_id, title, pen_name_id)
  values ('e0740003-0000-4000-8000-000000000009', 'e0740000-0000-4000-8000-00000000000a', 'P074 Unused series', 'e0740002-0000-4000-8000-000000000002');
  v := pg_temp.value_as('anon', null,
    $q$select count(*)::text from public.public_pen_names where id = 'e0740002-0000-4000-8000-000000000002'$q$);
  perform pg_temp.assert(v = '1', format('part2: a pen name used by a series is listed -- got %s', v));
  delete from public.series where id = 'e0740003-0000-4000-8000-000000000009';
end $$;

-- ============================================================
-- Part 3: the default pen name and the profile.
-- ============================================================
do $$
declare
  v text;
begin
  -- Profile edit renames the default; book text stays null.
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000b',
    $q$update public.profiles set public_author_name = 'P074 Benjamin' where id = 'e0740000-0000-4000-8000-00000000000b'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part3: an author renames their public name -- got %s', v));
  perform pg_temp.assert((select name from public.pen_names where id = pg_temp.dflt('e0740000-0000-4000-8000-00000000000b')) = 'P074 Benjamin',
    'part3: the default pen name follows the profile');

  -- A clash with another of the author's pen names is refused.
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.profiles set public_author_name = 'p074 owl' where id = 'e0740000-0000-4000-8000-00000000000a'$q$);
  perform pg_temp.assert(v like 'LB453:You already use%', format('part3: a public name equal to another pen name is refused -- got %s', v));
  perform pg_temp.assert((select public_author_name from public.profiles where id = 'e0740000-0000-4000-8000-00000000000a') = 'P074 Ana',
    'part3: the refused rename changed nothing');

  -- Renaming the default from Pen names updates the profile.
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000b',
    $q$update public.pen_names set name = 'P074 Ben B.' where is_default$q$);
  perform pg_temp.assert(v = 'OK:1', format('part3: the author renames the default pen name -- got %s', v));
  perform pg_temp.assert((select public_author_name from public.profiles where id = 'e0740000-0000-4000-8000-00000000000b') = 'P074 Ben B.',
    'part3: the profile follows the default pen name');

  -- Renaming a pen name to another of the author's names is refused.
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.pen_names set name = 'P074 ANA' where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v like '23505:%', format('part3: a duplicate pen name (any case) is refused -- got %s', v));

  -- A reader with a profile bio and photo becomes an author (becomeAuthor
  -- writes role + public name): r4 (17a) the new default starts with them.
  update public.profiles set bio = 'Becomes bio', avatar_path = 'e0740000-0000-4000-8000-0000000000ee/avatar.png'
   where id = 'e0740000-0000-4000-8000-0000000000ee';
  update public.profiles set role = 'author', public_author_name = 'P074 Becomes'
   where id = 'e0740000-0000-4000-8000-0000000000ee';
  perform pg_temp.assert(pg_temp.dflt('e0740000-0000-4000-8000-0000000000ee') is not null,
    'part3: becoming an author creates the default pen name');
  perform pg_temp.assert(
    (select bio = 'Becomes bio' and avatar_path = 'e0740000-0000-4000-8000-0000000000ee/avatar.png'
       from public.pen_names where id = pg_temp.dflt('e0740000-0000-4000-8000-0000000000ee')),
    'part3 (17a): the new default pen name takes the profile bio and photo');
  -- A blank bio stays null; a photo outside "<id>/avatar.<ext>" is not copied.
  update public.profiles set bio = '   ', avatar_path = 'legacy/old-photo.png'
   where id = 'e0740000-0000-4000-8000-0000000000ef';
  update public.profiles set role = 'author', public_author_name = 'P074 Legacy'
   where id = 'e0740000-0000-4000-8000-0000000000ef';
  perform pg_temp.assert(
    (select bio is null and avatar_path is null
       from public.pen_names where id = pg_temp.dflt('e0740000-0000-4000-8000-0000000000ef')),
    'part3 (17a): a blank bio and a non-canonical photo are not copied');
  -- avatar_path: a pen name key or the account's OWN profile key only.
  v := pg_temp.run_as('service_role', null,
    $q$update public.pen_names set avatar_path = 'e0740000-0000-4000-8000-00000000000b/avatar.png'
        where id = 'e0740002-0000-4000-8000-000000000002'$q$);
  perform pg_temp.assert(v like '23514:%pen_names_avatar_path_check%', format('part3 (17a): another account''s photo key is refused -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.pen_names set avatar_path = 'e0740000-0000-4000-8000-00000000000a/avatar.jpg'
        where id = 'e0740002-0000-4000-8000-000000000002'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part3 (17a): the account''s own profile key is accepted -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.pen_names set avatar_path = 'e0740000-0000-4000-8000-00000000000a/other.png'
        where id = 'e0740002-0000-4000-8000-000000000002'$q$);
  perform pg_temp.assert(v like '23514:%', format('part3 (17a): any other key in the account folder is refused -- got %s', v));
  update public.pen_names set avatar_path = null where id = 'e0740002-0000-4000-8000-000000000002';
  begin
    update public.profiles set public_author_name = '   ' where id = 'e0740000-0000-4000-8000-0000000000ee';
    perform pg_temp.assert(false, 'part3: a blank public name must be refused');
  exception when check_violation then null;
  end;

  -- The default cannot be deleted while the account exists.
  begin
    delete from public.pen_names where id = pg_temp.dflt('e0740000-0000-4000-8000-00000000000b');
    perform pg_temp.assert(false, 'part3: deleting the default must be refused');
  exception when sqlstate 'LB456' then null;
  end;
  -- A used pen name cannot be deleted; an unused one can (server writer).
  v := pg_temp.run_as('service_role', null,
    $q$delete from public.pen_names where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v like '23503:%', format('part3: a used pen name cannot be deleted -- got %s', v));
end $$;

-- ============================================================
-- Part 4: books -- sync, ownership, 11a and 14a.
-- ============================================================
insert into public.series (id, author_id, title, pen_name_id) values
  ('e0740003-0000-4000-8000-000000000001', 'e0740000-0000-4000-8000-00000000000a', 'P074 Owl series', 'e0740002-0000-4000-8000-000000000001');

do $$
declare
  v text;
begin
  -- Old code writes only the text: it finds the existing pen name (any case)...
  update public.books set pen_name = 'p074 owl' where id = 'e0740001-0000-4000-8000-0000000000a4';
  perform pg_temp.assert(
    (select pen_name_id = 'e0740002-0000-4000-8000-000000000001' and pen_name = 'P074 Owl'
       from public.books where id = 'e0740001-0000-4000-8000-0000000000a4'),
    'part4: text-only write resolves to the existing pen name, text normalised');
  -- ...or creates one, and null / the default's name means the default.
  update public.books set pen_name = 'P074 Brand New' where id = 'e0740001-0000-4000-8000-0000000000a4';
  perform pg_temp.assert(
    (select pn.name from public.books b join public.pen_names pn on pn.id = b.pen_name_id
      where b.id = 'e0740001-0000-4000-8000-0000000000a4') = 'P074 Brand New',
    'part4: text-only write creates a new pen name');
  update public.books set pen_name = 'P074 ANA' where id = 'e0740001-0000-4000-8000-0000000000a4';
  perform pg_temp.assert(
    (select pen_name_id = pg_temp.dflt(author_id) and pen_name is null from public.books where id = 'e0740001-0000-4000-8000-0000000000a4'),
    'part4: the default''s own name (any case) is the default, text null');
  -- id wins over text
  update public.books set pen_name_id = 'e0740002-0000-4000-8000-000000000002', pen_name = 'Ignored'
   where id = 'e0740001-0000-4000-8000-0000000000a4';
  perform pg_temp.assert((select pen_name from public.books where id = 'e0740001-0000-4000-8000-0000000000a4') = 'P074 Unused',
    'part4: when pen_name_id is written, the text follows it');
  update public.books set pen_name_id = null where id = 'e0740001-0000-4000-8000-0000000000a4';
  perform pg_temp.assert((select pen_name_id = pg_temp.dflt(author_id) from public.books where id = 'e0740001-0000-4000-8000-0000000000a4'),
    'part4: a null pen_name_id means the default');

  -- Renaming a pen name updates its books' text.
  update public.pen_names set name = 'P074 Night Owl' where id = 'e0740002-0000-4000-8000-000000000001';
  perform pg_temp.assert((select string_agg(distinct pen_name, ',') from public.books where pen_name_id = 'e0740002-0000-4000-8000-000000000001') = 'P074 Night Owl',
    'part4: a rename reaches every book''s text');

  -- Another author's pen name is refused.
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set pen_name_id = 'e0740002-0000-4000-8000-000000000001' where id = 'e0740001-0000-4000-8000-0000000000b1'$q$);
  perform pg_temp.assert(v like '42501:%', format('part4: a pen name of another account is refused -- got %s', v));

  -- 11a: a default-pen book cannot join the Owl series.
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.books set series_id = 'e0740003-0000-4000-8000-000000000001' where id = 'e0740001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v like 'LB451:%', format('part4 (11a): a book of another pen name cannot join the series -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.books set series_id = 'e0740003-0000-4000-8000-000000000001', series_position = 1 where id = 'e0740001-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part4 (11a): a book of the series'' pen name joins it -- got %s', v));
  -- another account's series is refused too (its pen name is never yours)
  insert into public.series (id, author_id, title) values
    ('e0740003-0000-4000-8000-0000000000b1', 'e0740000-0000-4000-8000-00000000000b', 'P074 Ben series');
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.books set series_id = 'e0740003-0000-4000-8000-0000000000b1' where id = 'e0740001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v like 'LB451:%', format('part4 (11a): a book cannot join another account''s series -- got %s', v));

  -- 14a: no pen name change while in a series...
  v := pg_temp.run_as('service_role', null,
    format('update public.books set pen_name_id = %L where id = %L', pg_temp.dflt('e0740000-0000-4000-8000-00000000000a'), 'e0740001-0000-4000-8000-0000000000a2'));
  perform pg_temp.assert(v like 'LB452:This book is in a series or bundle.%', format('part4 (14a): refused while in a series -- got %s', v));
  -- ...but leaving the series in the same write is allowed.
  v := pg_temp.run_as('service_role', null,
    format('update public.books set series_id = null, series_position = null, pen_name_id = %L where id = %L',
           pg_temp.dflt('e0740000-0000-4000-8000-00000000000a'), 'e0740001-0000-4000-8000-0000000000a2'));
  perform pg_temp.assert(v = 'OK:1', format('part4 (14a): leaving the series and changing the pen name together is allowed -- got %s', v));
  update public.books set pen_name_id = 'e0740002-0000-4000-8000-000000000001', series_id = 'e0740003-0000-4000-8000-000000000001'
   where id = 'e0740001-0000-4000-8000-0000000000a2';

  -- A series cannot change pen name while it holds books of the old one.
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    format('update public.series set pen_name_id = %L where id = %L', pg_temp.dflt('e0740000-0000-4000-8000-00000000000a'), 'e0740003-0000-4000-8000-000000000001'));
  perform pg_temp.assert(v like 'LB451:%', format('part4 (11a): a non-empty series keeps its pen name -- got %s', v));
  -- A series with another account's pen name is refused.
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000b',
    $q$insert into public.series (author_id, title, pen_name_id) values ('e0740000-0000-4000-8000-00000000000b', 'x', 'e0740002-0000-4000-8000-000000000001')$q$);
  perform pg_temp.assert(v like '42501:%', format('part4: a series cannot take another account''s pen name -- got %s', v));
end $$;

-- ============================================================
-- Part 5: bundles.
-- ============================================================
do $$
declare
  v text;
begin
  -- Mixed books: refused before the bundle row exists.
  v := pg_temp.run_as('service_role', null,
    $q$select * from public.create_bundle_with_membership('e0740004-0000-4000-8000-000000000001', 'e0740000-0000-4000-8000-00000000000a', 'Mixed', '', 299,
         array['e0740001-0000-4000-8000-0000000000a1','e0740001-0000-4000-8000-0000000000a2']::uuid[])$q$);
  perform pg_temp.assert(v like 'LB451:%', format('part5: a mixed bundle is refused -- got %s', v));
  perform pg_temp.assert(not exists (select 1 from public.bundles where id = 'e0740004-0000-4000-8000-000000000001'),
    'part5: no bundle row was written');

  -- Same pen name: created with that pen name.
  v := pg_temp.run_as('service_role', null,
    $q$select * from public.create_bundle_with_membership('e0740004-0000-4000-8000-000000000002', 'e0740000-0000-4000-8000-00000000000a', 'Owls', '', 299,
         array['e0740001-0000-4000-8000-0000000000a2','e0740001-0000-4000-8000-0000000000a3']::uuid[])$q$);
  perform pg_temp.assert(v = 'OK:2', format('part5: a one-pen-name bundle is created -- got %s', v));
  perform pg_temp.assert((select pen_name_id from public.bundles where id = 'e0740004-0000-4000-8000-000000000002') = 'e0740002-0000-4000-8000-000000000001',
    'part5: the bundle takes its books'' pen name');

  -- 14a for a bundle member.
  v := pg_temp.run_as('service_role', null,
    format('update public.books set pen_name_id = %L where id = %L', pg_temp.dflt('e0740000-0000-4000-8000-00000000000a'), 'e0740001-0000-4000-8000-0000000000a3'));
  perform pg_temp.assert(v like 'LB452:%', format('part5 (14a): refused while in a bundle -- got %s', v));

  -- Update to the default-pen books: the RPC moves the bundle's pen name
  -- before the membership (N4).
  update public.books set pen_name_id = pg_temp.dflt(author_id) where id = 'e0740001-0000-4000-8000-0000000000a4';
  v := pg_temp.run_as('service_role', null,
    $q$select * from public.update_bundle_with_membership('e0740004-0000-4000-8000-000000000002', 'e0740000-0000-4000-8000-00000000000a',
         null, false, null, 'Plains', '', 299,
         array['e0740001-0000-4000-8000-0000000000a1','e0740001-0000-4000-8000-0000000000a4']::uuid[])$q$);
  perform pg_temp.assert(v = 'OK:2', format('part5: the update RPC switches the bundle to the default pen name -- got %s', v));
  perform pg_temp.assert((select pen_name_id from public.bundles where id = 'e0740004-0000-4000-8000-000000000002') = pg_temp.dflt('e0740000-0000-4000-8000-00000000000a'),
    'part5: the bundle now has the default pen name');
  v := pg_temp.run_as('service_role', null,
    $q$select * from public.update_bundle_with_membership('e0740004-0000-4000-8000-000000000002', 'e0740000-0000-4000-8000-00000000000a',
         null, false, null, 'Mixed', '', 299,
         array['e0740001-0000-4000-8000-0000000000a1','e0740001-0000-4000-8000-0000000000a2']::uuid[])$q$);
  perform pg_temp.assert(v like 'LB451:%', format('part5: the update RPC refuses a mixed set -- got %s', v));
  -- a direct membership row of another pen name is refused
  v := pg_temp.run_as('service_role', null,
    $q$insert into public.bundle_books (bundle_id, book_id) values ('e0740004-0000-4000-8000-000000000002', 'e0740001-0000-4000-8000-0000000000a3')$q$);
  perform pg_temp.assert(v like 'LB451:%', format('part5: a member of another pen name is refused -- got %s', v));
end $$;

-- A direct pen name change of a non-empty bundle fails at commit
-- (deferred), shown here with SET CONSTRAINTS IMMEDIATE.
do $$
begin
  begin
    set constraints public.bundles_check_member_pen_names immediate;
    update public.bundles set pen_name_id = 'e0740002-0000-4000-8000-000000000001' where id = 'e0740004-0000-4000-8000-000000000002';
    perform pg_temp.assert(false, 'part5: a bundle cannot switch pen name away from its books');
  exception when sqlstate 'LB451' then null;
  end;
  set constraints public.bundles_check_member_pen_names deferred;
end $$;

-- ============================================================
-- Part 6: follows.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-0000000000aa',
    $q$insert into public.pen_name_follows (follower_id, pen_name_id) values ('e0740000-0000-4000-8000-0000000000aa', 'e0740002-0000-4000-8000-000000000001')$q$);
  perform pg_temp.assert(v = 'OK:1', format('part6: a reader follows a pen name -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-0000000000aa',
    $q$insert into public.pen_name_follows (follower_id, pen_name_id) values ('e0740000-0000-4000-8000-00000000000b', 'e0740002-0000-4000-8000-000000000001')$q$);
  perform pg_temp.assert(v like '42501:%', format('part6: nobody follows on someone else''s behalf -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$insert into public.pen_name_follows (follower_id, pen_name_id) values ('e0740000-0000-4000-8000-00000000000a', 'e0740002-0000-4000-8000-000000000001')$q$);
  perform pg_temp.assert(v like 'LB457:%', format('part6: an author cannot follow their own pen name -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0740000-0000-4000-8000-00000000000b',
    $q$select count(*)::text from public.pen_name_follows$q$);
  perform pg_temp.assert(v = '0', format('part6: follows are visible only to the follower -- got %s', v));

  -- Mirror: old code's follow and unfollow land on the default pen name.
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-0000000000aa',
    $q$insert into public.author_follows (follower_id, author_id) values ('e0740000-0000-4000-8000-0000000000aa', 'e0740000-0000-4000-8000-00000000000a')$q$);
  perform pg_temp.assert(v = 'OK:1', format('part6: old code follows an author -- got %s', v));
  perform pg_temp.assert(exists (select 1 from public.pen_name_follows where follower_id = 'e0740000-0000-4000-8000-0000000000aa'
                                   and pen_name_id = pg_temp.dflt('e0740000-0000-4000-8000-00000000000a')),
    'part6: mirrored onto the default pen name');
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-0000000000aa',
    $q$delete from public.author_follows where follower_id = 'e0740000-0000-4000-8000-0000000000aa'$q$);
  perform pg_temp.assert(
    not exists (select 1 from public.pen_name_follows where follower_id = 'e0740000-0000-4000-8000-0000000000aa'
                  and pen_name_id = pg_temp.dflt('e0740000-0000-4000-8000-00000000000a'))
    and exists (select 1 from public.pen_name_follows where follower_id = 'e0740000-0000-4000-8000-0000000000aa'
                  and pen_name_id = 'e0740002-0000-4000-8000-000000000001'),
    'part6: old unfollow removes only the default pen name follow');
end $$;

-- ============================================================
-- Part 7: search (5a).
-- ============================================================
set local role anon;
select pg_temp.assert(
  (select array_agg(s.book_id order by s.book_id) from public.search_books('P074 Night Owl') s)
    = array['e0740001-0000-4000-8000-0000000000a2', 'e0740001-0000-4000-8000-0000000000a3']::uuid[],
  'part7: the pen name finds exactly its books');
select pg_temp.assert(
  not exists (select 1 from public.search_books('P074 Ana') s
               where s.book_id in ('e0740001-0000-4000-8000-0000000000a2', 'e0740001-0000-4000-8000-0000000000a3')),
  'part7: the account''s public name never finds a book under another pen name');
select pg_temp.assert(
  exists (select 1 from public.search_books('P074 Ana') s where s.book_id = 'e0740001-0000-4000-8000-0000000000a1'),
  'part7: the default pen name finds its own books');
reset role;

-- ============================================================
-- Part 8: staff remove links.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-0000000000aa',
    $q$select public.staff_remove_pen_name_links('e0740002-0000-4000-8000-000000000001')$q$);
  perform pg_temp.assert(v like 'P0001:not authorized%', format('part8: a reader cannot remove links -- got %s', v));
  v := pg_temp.run_as('anon', null,
    $q$select public.staff_remove_pen_name_links('e0740002-0000-4000-8000-000000000001')$q$);
  perform pg_temp.assert(v like '42501:%', format('part8: anon cannot execute -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-0000000000dd',
    $q$select public.staff_remove_pen_name_links('e0740002-0000-4000-8000-000000000001')$q$);
  perform pg_temp.assert(v = 'OK:1', format('part8: a moderator removes links -- got %s', v));
  perform pg_temp.assert((select links from public.pen_names where id = 'e0740002-0000-4000-8000-000000000001') = '[]'::jsonb,
    'part8: links are gone');
  perform pg_temp.assert(
    (select count(*) from public.admin_audit_log
      where action = 'pen_name.links_removed' and target_type = 'pen_names'
        and target_id = 'e0740002-0000-4000-8000-000000000001'
        and actor_id = 'e0740000-0000-4000-8000-0000000000dd'
        and metadata->'removed_links' = '["https://a.example", "https://b.example/x?y=1"]'::jsonb) = 1,
    'part8: one audit row with the removed links');
  v := pg_temp.run_as('authenticated', 'e0740000-0000-4000-8000-00000000000a',
    $q$update public.pen_names set links = '["https://again.example"]' where id = 'e0740002-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part8 (15a): the author may add links again -- got %s', v));
  -- r4: the admin audit filter accepts the event and its target type.
  perform pg_temp.assert(
    pg_get_functiondef('public.list_admin_audit_events(text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer)'::regprocedure)
      ~ '''pen_name\.links_removed''' and
    pg_get_functiondef('public.list_admin_audit_events(text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer)'::regprocedure)
      ~ '''pen_names''',
    'part8: list_admin_audit_events() filters by pen_name.links_removed and pen_names');
end $$;

-- ============================================================
-- Part 10 (r5, audit F1 and F2): no error oracle ties a pen name to an
-- account. For a foreign account, the series and follow refusals are
-- identical whatever the pen name is; the caller's own rows and
-- service_role keep their specific errors.
--   A = ...0a (pen names: default, 'P074 Owl'), B = ...0b, R = reader,
--   E = ...ef (a reader with no default pen name).
-- ============================================================
do $$
declare
  a constant text := 'e0740000-0000-4000-8000-00000000000a';
  b constant text := 'e0740000-0000-4000-8000-00000000000b';
  r constant text := 'e0740000-0000-4000-8000-0000000000aa';
  e constant text := 'e0740000-0000-4000-8000-0000000000ef';
  owl constant text := 'e0740002-0000-4000-8000-000000000001';
  v_own text;
  v_other text;
  v_null text;
  v_nodefault text;
  v_sid uuid;
begin
  -- F2: the pen name resolver (any author id -> a pen name id, creating
  -- one) is closed to the data API.
  perform pg_temp.assert(not has_function_privilege('anon', 'public.resolve_author_pen_name(uuid, text)', 'EXECUTE'),
    'part10 (F2): anon cannot execute resolve_author_pen_name');
  perform pg_temp.assert(not has_function_privilege('authenticated', 'public.resolve_author_pen_name(uuid, text)', 'EXECUTE'),
    'part10 (F2): authenticated cannot execute resolve_author_pen_name');
  perform pg_temp.assert(has_function_privilege('service_role', 'public.resolve_author_pen_name(uuid, text)', 'EXECUTE'),
    'part10 (F2): service_role executes resolve_author_pen_name');

  -- F1, series INSERT by authenticated R for account A: A's own pen name,
  -- B's pen name, no pen name -- and for E, which has no default.
  v_own := pg_temp.run_as('authenticated', r,
    format($q$insert into public.series (author_id, title, pen_name_id) values (%L, 'probe', %L)$q$, a, owl));
  v_other := pg_temp.run_as('authenticated', r,
    format($q$insert into public.series (author_id, title, pen_name_id) values (%L, 'probe', %L)$q$, a, pg_temp.dflt(b::uuid)));
  v_null := pg_temp.run_as('authenticated', r,
    format($q$insert into public.series (author_id, title) values (%L, 'probe')$q$, a));
  v_nodefault := pg_temp.run_as('authenticated', r,
    format($q$insert into public.series (author_id, title) values (%L, 'probe')$q$, e));
  perform pg_temp.assert(v_own like '42501:new row violates row-level security policy%',
    format('part10 (F1): series for another account -> the RLS error -- got %s', v_own));
  perform pg_temp.assert(v_other = v_own and v_null = v_own and v_nodefault = v_own,
    format('part10 (F1): series insert, same error whatever the pen name -- own=%s other=%s null=%s nodefault=%s',
           v_own, v_other, v_null, v_nodefault));

  -- The same as anon (anon holds INSERT on series; RLS refuses it).
  v_own := pg_temp.run_as('anon', null,
    format($q$insert into public.series (author_id, title, pen_name_id) values (%L, 'probe', %L)$q$, a, owl));
  v_other := pg_temp.run_as('anon', null,
    format($q$insert into public.series (author_id, title, pen_name_id) values (%L, 'probe', %L)$q$, a, pg_temp.dflt(b::uuid)));
  v_null := pg_temp.run_as('anon', null,
    format($q$insert into public.series (author_id, title) values (%L, 'probe')$q$, a));
  perform pg_temp.assert(v_own = v_other and v_own = v_null and v_own like '42501:%',
    format('part10 (F1): anon series insert, same error whatever the pen name -- own=%s other=%s null=%s', v_own, v_other, v_null));

  -- Series UPDATE: B moves B's own series to account A, with A's pen
  -- name or with B's -- the same refusal.
  insert into public.series (author_id, title) values (b::uuid, 'P074 B series') returning id into v_sid;
  v_own := pg_temp.run_as('authenticated', b,
    format($q$update public.series set author_id = %L, pen_name_id = %L where id = %L$q$, a, owl, v_sid));
  v_other := pg_temp.run_as('authenticated', b,
    format($q$update public.series set author_id = %L, pen_name_id = %L where id = %L$q$, a, pg_temp.dflt(b::uuid), v_sid));
  perform pg_temp.assert(v_own like '42501:new row violates row-level security policy%' and v_other = v_own,
    format('part10 (F1): series update to another account, same error whatever the pen name -- own=%s other=%s', v_own, v_other));

  -- pen_name_follows INSERT by R for follower B: B's own pen name or A's.
  v_own := pg_temp.run_as('authenticated', r,
    format($q$insert into public.pen_name_follows (follower_id, pen_name_id) values (%L, %L)$q$, b, pg_temp.dflt(b::uuid)));
  v_other := pg_temp.run_as('authenticated', r,
    format($q$insert into public.pen_name_follows (follower_id, pen_name_id) values (%L, %L)$q$, b, owl));
  perform pg_temp.assert(v_own like '42501:new row violates row-level security policy%' and v_other = v_own,
    format('part10 (F1): follow for another account, same error whatever the pen name -- own=%s other=%s', v_own, v_other));

  -- Unchanged: the caller's own rows keep their specific errors, and
  -- service_role is still checked.
  v_own := pg_temp.run_as('authenticated', a,
    format($q$insert into public.pen_name_follows (follower_id, pen_name_id) values (%L, %L)$q$, a, owl));
  perform pg_temp.assert(v_own like 'LB457:%', format('part10: following your own pen name is still LB457 -- got %s', v_own));
  v_own := pg_temp.run_as('authenticated', a,
    format($q$insert into public.series (author_id, title, pen_name_id) values (%L, 'probe', %L)$q$, a, pg_temp.dflt(b::uuid)));
  perform pg_temp.assert(v_own like '42501:pen names: the pen name does not belong to this series%',
    format('part10: an own series with another account''s pen name is still refused by the trigger -- got %s', v_own));
  v_own := pg_temp.run_as('authenticated', a,
    format($q$insert into public.series (author_id, title) values (%L, 'P074 own series')$q$, a));
  perform pg_temp.assert(v_own = 'OK:1', format('part10: an own series still gets the default pen name -- got %s', v_own));
  v_own := pg_temp.run_as('service_role', null,
    format($q$insert into public.series (author_id, title, pen_name_id) values (%L, 'probe', %L)$q$, a, pg_temp.dflt(b::uuid)));
  perform pg_temp.assert(v_own like '42501:pen names: the pen name does not belong to this series%',
    format('part10: service_role is still checked -- got %s', v_own));
  v_own := pg_temp.run_as('service_role', null,
    format($q$insert into public.pen_name_follows (follower_id, pen_name_id) values (%L, %L)$q$, a, owl));
  perform pg_temp.assert(v_own like 'LB457:%', format('part10: service_role self-follow is still LB457 -- got %s', v_own));
end $$;

-- ============================================================
-- Part 9: deleting an account with books, pen names and follows works
-- (the pen_name_id keys are NO ACTION, checked after the cascade).
-- ============================================================
do $$
begin
  delete from auth.users where id = 'e0740000-0000-4000-8000-00000000000a';
  perform pg_temp.assert(not exists (select 1 from public.pen_names where author_id = 'e0740000-0000-4000-8000-00000000000a')
    and not exists (select 1 from public.books where author_id = 'e0740000-0000-4000-8000-00000000000a')
    and not exists (select 1 from public.pen_name_follows where pen_name_id = 'e0740002-0000-4000-8000-000000000001'),
    'part9: account deletion removes its books, pen names and their follows');
end $$;

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 80,
    format('expected at least 80 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 074_pen_names.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
