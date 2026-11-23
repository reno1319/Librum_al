-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the public publishing-house pages
-- (supabase/migrations/20261123160000_publishing_house_pages.sql):
--
--   Part 1  shape: pen_names.linked_pen_name_id, the view's two appended
--           columns, the trigger, the two staff functions and grants.
--   Part 2  the view: house_id only on a house's pen names; the house's
--           own name is public once any house book is; a writer's name
--           becomes public through a linked house book.
--   Part 3  the staff link: people.manage only; every refusal; the
--           exact-name rule (b4 c); the audit log.
--   Part 4  a linked house author keeps its name (b7 a), bio and links
--           (g1 a; staff can still remove links); a writer's rename
--           ends the public link (b4 c); nobody else
--           can write the link; a suspended house hides the link's page.
--   Part 5  unlink; the real files (rollback twice, migration again).
--
-- Not one rolled-back transaction: Part 5 runs the real migration and
-- rollback files (each its own begin/commit) with \i. Run from the repo
-- root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/112_publishing_house_pages.test.sql
--
-- Against the BASE schema it fails in Part 1 (no column): the negative
-- control.

set client_min_messages = warning;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- One text value as the given role and user, or 'SQLSTATE:message'.
create function pg_temp.value_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_out text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

-- What anon sees of one pen name in the view: 'name|house_id|linked', or '-'.
create function pg_temp.seen(p_id uuid) returns text
  language sql as $$
  select pg_temp.value_as('anon', null, format(
    $q$select coalesce((select name || '|' || coalesce(house_id::text, '') || '|' || coalesce(linked_pen_name_id::text, '')
                          from public.public_pen_names where id = %L), '-')$q$, p_id));
$$;

create function pg_temp.link(p_sub text, p_pen uuid, p_email text) returns text
  language sql as $$
  select pg_temp.value_as('authenticated', p_sub,
    format('select public.staff_link_house_author(%L, %L)', p_pen, p_email));
$$;

-- ============================================================
-- Fixture (as the table owner):
--   H  publishing house "P112 Botime" (default pen name HD), authors
--      HA "P112 Drita" (one published book) and HB "P112 Arta" (none)
--   W  a writer's own author account, names "P112 Drita" (default, WD,
--      no book of its own) and pseudonym "P112 Hëna" (WP)
--   P  a plain author "P112 Ben" with a published book
--   R  a reader;  S  staff (admin)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1120000-0000-4000-8000-000000000001', 'p112-house@test', now(), '{"display_name":"P112 Botime"}'),
  ('e1120000-0000-4000-8000-000000000002', 'p112-writer@test', now(), '{"display_name":"P112 Drita"}'),
  ('e1120000-0000-4000-8000-000000000003', 'p112-plain@test', now(), '{"display_name":"P112 Ben"}'),
  ('e1120000-0000-4000-8000-000000000004', 'p112-reader@test', now(), '{"display_name":"P112 R"}'),
  ('e1120000-0000-4000-8000-000000000005', 'p112-staff@test', now(), '{"display_name":"P112 S"}');
update public.profiles set role = 'author', public_author_name = 'P112 Botime', account_kind = 'publishing_house'
 where id = 'e1120000-0000-4000-8000-000000000001';
update public.profiles set role = 'author', public_author_name = 'P112 Drita'
 where id = 'e1120000-0000-4000-8000-000000000002';
update public.profiles set role = 'author', public_author_name = 'P112 Ben'
 where id = 'e1120000-0000-4000-8000-000000000003';
insert into public.staff_members (user_id, role) values ('e1120000-0000-4000-8000-000000000005', 'admin');

insert into public.pen_names (id, author_id, name) values
  ('e1120002-0000-4000-8000-00000000000a', 'e1120000-0000-4000-8000-000000000001', 'P112 Drita'),
  ('e1120002-0000-4000-8000-00000000000b', 'e1120000-0000-4000-8000-000000000001', 'P112 Arta'),
  ('e1120002-0000-4000-8000-00000000000c', 'e1120000-0000-4000-8000-000000000002', 'P112 Hëna');
insert into public.books (id, author_id, pen_name_id, title, status, price_all, published_at) values
  ('e1120001-0000-4000-8000-00000000000a', 'e1120000-0000-4000-8000-000000000001',
   'e1120002-0000-4000-8000-00000000000a', 'P112 hb1', 'published', 500, now());
insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e1120001-0000-4000-8000-00000000000c', 'e1120000-0000-4000-8000-000000000003', 'P112 pb1', 'published', 500, now());

\set H '''e1120000-0000-4000-8000-000000000001'''
\set S '''e1120000-0000-4000-8000-000000000005'''
\set R '''e1120000-0000-4000-8000-000000000004'''
\set HA '''e1120002-0000-4000-8000-00000000000a'''
\set HB '''e1120002-0000-4000-8000-00000000000b'''
\set WP '''e1120002-0000-4000-8000-00000000000c'''

select set_config('p112.hd', (select id::text from public.pen_names where author_id = :H and is_default), false);
select set_config('p112.wd', (select id::text from public.pen_names
                               where author_id = 'e1120000-0000-4000-8000-000000000002' and is_default), false);
select set_config('p112.pd', (select id::text from public.pen_names
                               where author_id = 'e1120000-0000-4000-8000-000000000003' and is_default), false);
select pg_temp.assert(current_setting('p112.hd') <> '' and current_setting('p112.wd') <> '' and current_setting('p112.pd') <> '',
  'fixture: every author has a default pen name');

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select format_type(atttypid, atttypmod) = 'uuid' and not attnotnull
       from pg_attribute
      where attrelid = 'public.pen_names'::regclass and attname = 'linked_pen_name_id' and not attisdropped),
    'part1: pen_names.linked_pen_name_id is a nullable uuid');
  perform pg_temp.assert(
    exists (select 1 from pg_constraint
             where conrelid = 'public.pen_names'::regclass and contype = 'f'
               and confrelid = 'public.pen_names'::regclass and confdeltype = 'n'),
    'part1: it references pen_names, on delete set null');
  perform pg_temp.assert(
    (select string_agg(attname, ',' order by attnum) from pg_attribute
      where attrelid = 'public.public_pen_names'::regclass and attnum > 0 and not attisdropped)
      = 'id,name,bio,avatar_path,links,house_id,linked_pen_name_id',
    'part1: the view keeps its columns and appends two');
  perform pg_temp.assert(
    (select reloptions from pg_class where oid = 'public.public_pen_names'::regclass) = array['security_barrier=true'],
    'part1: the view stays a security barrier');
  perform pg_temp.assert(
    has_table_privilege('anon', 'public.public_pen_names', 'select')
    and not has_column_privilege('authenticated', 'public.pen_names', 'linked_pen_name_id', 'update'),
    'part1: grants: anon reads the view; authenticated cannot write the link');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.staff_link_house_author(uuid, text)', 'execute')
    and has_function_privilege('authenticated', 'public.staff_unlink_house_author(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.staff_link_house_author(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.staff_unlink_house_author(uuid)', 'execute')
    and not has_function_privilege('service_role', 'public.staff_link_house_author(uuid, text)', 'execute'),
    'part1: the staff functions are for authenticated only');
  perform pg_temp.assert(
    exists (select 1 from pg_trigger where tgrelid = 'public.pen_names'::regclass and tgname = 'pen_names_linked_name_lock'),
    'part1: the name lock trigger exists');
end $$;

-- ============================================================
-- Part 2: the view before any link.
-- ============================================================
select pg_temp.assert(pg_temp.seen(current_setting('p112.hd')::uuid)
  = 'P112 Botime|' || current_setting('p112.hd') || '|',
  'part2: the house page is public (a house book is), its house_id is itself');
select pg_temp.assert(pg_temp.seen(:HA) = 'P112 Drita|' || current_setting('p112.hd') || '|',
  'part2: a house author carries the house');
select pg_temp.assert(pg_temp.seen(:HB) = '-', 'part2: a house author with no book stays private');
select pg_temp.assert(pg_temp.seen(current_setting('p112.pd')::uuid) = 'P112 Ben||',
  'part2: a person''s pen name has no house');
select pg_temp.assert(pg_temp.seen(current_setting('p112.wd')::uuid) = '-',
  'part2: the writer with no book of their own is not public yet');

-- ============================================================
-- Part 3: the staff link.
-- ============================================================
select pg_temp.assert(pg_temp.link(:R, :HA, 'p112-writer@test') like '42501:%' or pg_temp.link(:R, :HA, 'p112-writer@test') like 'P0001:not authorized%',
  'part3: a reader is refused');
select pg_temp.assert(pg_temp.value_as('anon', null,
  format('select public.staff_link_house_author(%L, %L)', :HA, 'p112-writer@test')) like '42501:%',
  'part3: anon cannot call it');
select pg_temp.assert(pg_temp.link(:S, :HB, 'p112-writer@test') = 'no_match', 'part3: no name matches "P112 Arta"');
select pg_temp.assert(pg_temp.link(:S, :HA, 'nobody@test') = 'no_account', 'part3: unknown email');
select pg_temp.assert(pg_temp.link(:S, :HA, '') = 'no_account', 'part3: empty email');
select pg_temp.assert(pg_temp.link(:S, :HA, 'p112-house@test') = 'same_account', 'part3: the house itself');
select pg_temp.assert(pg_temp.link(:S, :HA, 'p112-reader@test') = 'not_author', 'part3: a reader account');
select pg_temp.assert(pg_temp.link(:S, current_setting('p112.hd')::uuid, 'p112-writer@test') = 'not_house_author',
  'part3: the house''s own name can''t be linked');
select pg_temp.assert(pg_temp.link(:S, current_setting('p112.pd')::uuid, 'p112-writer@test') = 'not_house_author',
  'part3: a person''s pen name can''t be linked');
select pg_temp.assert(pg_temp.link(:S, '00000000-0000-4000-8000-000000000000', 'p112-writer@test') = 'not_found',
  'part3: unknown pen name');
select pg_temp.assert((select count(*) from public.pen_names where linked_pen_name_id is not null) = 0
  and (select count(*) from public.admin_audit_log where action like 'house_author.%') = 0,
  'part3: no refusal wrote anything');

select pg_temp.assert(pg_temp.link(:S, :HA, '  P112-Writer@TEST ') = 'linked', 'part3: the same name links (email case and spaces ignored)');
select pg_temp.assert((select linked_pen_name_id::text from public.pen_names where id = :HA) = current_setting('p112.wd'),
  'part3: linked to the writer''s SAME name (their default "P112 Drita"), not their pseudonym');
select pg_temp.assert(
  (select count(*) from public.admin_audit_log
    where action = 'house_author.linked' and target_type = 'pen_names' and target_id = :HA
      and actor_id = :S and metadata ->> 'linked_pen_name_id' = current_setting('p112.wd')
      and not (metadata::text like '%@%')) = 1,
  'part3: one audit row, without the email');
select pg_temp.assert(pg_temp.link(:S, :HA, 'p112-writer@test') = 'already_linked', 'part3: linking twice is refused');

select pg_temp.assert(pg_temp.seen(:HA) = 'P112 Drita|' || current_setting('p112.hd') || '|' || current_setting('p112.wd'),
  'part3: the view shows the link on the house author');
select pg_temp.assert(pg_temp.seen(current_setting('p112.wd')::uuid) = 'P112 Drita||',
  'part3: the writer''s page is now public through the linked house book, with no house');
select pg_temp.assert(pg_temp.seen(:WP) = '-', 'part3: the writer''s pseudonym stays private');

-- ============================================================
-- Part 4: the name lock, the column, a suspended house.
-- ============================================================
select pg_temp.assert(pg_temp.value_as('authenticated', :H,
  format($q$update public.pen_names set name = 'P112 Tjetër' where id = %L returning 'changed'$q$, :HA)) like 'LB530:%',
  'part4: the house cannot rename a linked author');
select pg_temp.assert(pg_temp.value_as('authenticated', :H,
  format($q$update public.pen_names set bio = 'Bio e re' where id = %L returning 'changed'$q$, :HA)) like 'LB530:%',
  'part4: the house cannot change a linked author''s bio (g1 a)');
select pg_temp.assert(pg_temp.value_as('authenticated', :H,
  format($q$update public.pen_names set links = '["https://a.example"]'::jsonb where id = %L returning 'changed'$q$, :HA)) like 'LB530:%',
  'part4: the house cannot change a linked author''s links (g1 a)');
update public.pen_names set links = '["https://p112.example"]'::jsonb where id = :HA;
select pg_temp.assert(pg_temp.value_as('authenticated', :S,
  format($q$select 'done' from public.staff_remove_pen_name_links(%L)$q$, :HA)) = 'done',
  'part4: staff can still remove a linked author''s links');
select pg_temp.assert((select links from public.pen_names where id = :HA) = '[]'::jsonb,
  'part4: the links are gone');
select pg_temp.assert(pg_temp.value_as('authenticated', :H,
  format($q$update public.pen_names set linked_pen_name_id = null where id = %L returning 'changed'$q$, :HA)) like '42501:%',
  'part4: the house cannot unlink itself');
select pg_temp.assert(pg_temp.value_as('authenticated', :H,
  format($q$update public.pen_names set name = 'P112 Arta 2' where id = %L returning 'changed'$q$, :HB)) = 'changed',
  'part4: an unlinked house author can be renamed');

insert into public.account_suspensions (user_id, reason) values (:H, 'P112 test');
select pg_temp.assert(pg_temp.seen(current_setting('p112.wd')::uuid) = '-'
  and pg_temp.seen(:HA) = '-' and pg_temp.seen(current_setting('p112.hd')::uuid) = '-',
  'part4: a suspended house hides its pages and the page its link made public');
update public.account_suspensions set lifted_at = now() where user_id = :H;
select pg_temp.assert(pg_temp.seen(current_setting('p112.wd')::uuid) = 'P112 Drita||', 'part4: lifting brings it back');

-- b4 c (audit F1): the writer renames the linked name, through the pen
-- name itself and through the account's author name. The link stays in
-- the table (staff see it) but the public view drops it at once.
select pg_temp.assert(pg_temp.value_as('authenticated', 'e1120000-0000-4000-8000-000000000002',
  format($q$update public.pen_names set name = 'P112 Sekret' where id = %L returning 'changed'$q$,
         current_setting('p112.wd'))) = 'changed',
  'part4: the writer renames their linked name');
select pg_temp.assert(pg_temp.seen(:HA) = 'P112 Drita|' || current_setting('p112.hd') || '|',
  'part4: after the writer''s rename the house author shows no link');
select pg_temp.assert(pg_temp.seen(current_setting('p112.wd')::uuid) = '-',
  'part4: after the rename the writer''s name is not public through the link');
select pg_temp.assert((select linked_pen_name_id::text from public.pen_names where id = :HA) = current_setting('p112.wd'),
  'part4: the link row itself stays for staff');
update public.pen_names set name = 'p112 drita' where id = current_setting('p112.wd')::uuid;
select pg_temp.assert(pg_temp.seen(:HA) = 'P112 Drita|' || current_setting('p112.hd') || '|' || current_setting('p112.wd')
  and pg_temp.seen(current_setting('p112.wd')::uuid) = 'p112 drita||',
  'part4: renaming back to the same name (case aside) restores it');
update public.profiles set public_author_name = 'P112 Sekret 2' where id = 'e1120000-0000-4000-8000-000000000002';
select pg_temp.assert((select name from public.pen_names where id = current_setting('p112.wd')::uuid) = 'P112 Sekret 2',
  'part4: the account author name renames the default pen name');
select pg_temp.assert(pg_temp.seen(:HA) = 'P112 Drita|' || current_setting('p112.hd') || '|'
  and pg_temp.seen(current_setting('p112.wd')::uuid) = '-',
  'part4: a rename through the account author name also drops the public link');
update public.profiles set public_author_name = 'P112 Drita' where id = 'e1120000-0000-4000-8000-000000000002';
select pg_temp.assert(pg_temp.seen(current_setting('p112.wd')::uuid) = 'P112 Drita||', 'part4: and back');

-- ============================================================
-- Part 5: unlink, then the real files.
-- ============================================================
select pg_temp.assert(pg_temp.value_as('authenticated', :R,
  format('select public.staff_unlink_house_author(%L)', :HA)) like 'P0001:not authorized%',
  'part5: a reader cannot unlink');
select pg_temp.assert(pg_temp.value_as('authenticated', :S,
  format('select public.staff_unlink_house_author(%L)', :HA)) = 'unlinked', 'part5: staff unlink');
select pg_temp.assert(pg_temp.value_as('authenticated', :S,
  format('select public.staff_unlink_house_author(%L)', :HA)) = 'not_linked', 'part5: unlinking twice says so');
select pg_temp.assert(
  (select count(*) from public.admin_audit_log where action = 'house_author.unlinked' and target_id = :HA) = 1,
  'part5: the unlink is audited once');
select pg_temp.assert(pg_temp.seen(current_setting('p112.wd')::uuid) = '-',
  'part5: the writer''s page is private again (no book of their own)');
select pg_temp.assert(pg_temp.value_as('authenticated', :H,
  format($q$update public.pen_names set name = 'P112 Drita M.' where id = %L returning 'changed'$q$, :HA)) = 'changed',
  'part5: after unlinking the house can rename it');

-- Link again so the rollback has a link to drop.
update public.pen_names set name = 'P112 Drita' where id = :HA;
select pg_temp.assert(pg_temp.link(:S, :HA, 'p112-writer@test') = 'linked', 'part5: relinked before the rollback');

\i supabase/tests/112_publishing_house_pages.rollback.sql
\i supabase/tests/112_publishing_house_pages.rollback.sql

do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from pg_attribute where attrelid = 'public.pen_names'::regclass and attname = 'linked_pen_name_id' and not attisdropped),
    'part5: rollback drops the column');
  perform pg_temp.assert(
    (select string_agg(attname, ',' order by attnum) from pg_attribute
      where attrelid = 'public.public_pen_names'::regclass and attnum > 0 and not attisdropped)
      = 'id,name,bio,avatar_path,links',
    'part5: rollback restores the view''s five columns');
  perform pg_temp.assert(
    has_table_privilege('anon', 'public.public_pen_names', 'select')
    and has_table_privilege('authenticated', 'public.public_pen_names', 'select')
    and not has_table_privilege('anon', 'public.public_pen_names', 'insert'),
    'part5: rollback restates the view grants');
  perform pg_temp.assert(
    not exists (select 1 from pg_proc where proname in ('staff_link_house_author', 'staff_unlink_house_author', 'pen_names_linked_name_lock')),
    'part5: rollback drops the functions');
  perform pg_temp.assert(
    (select count(*) from public.pen_names where name like 'P112%') = 6,
    'part5: rollback keeps every pen name');
end $$;

\i supabase/migrations/20261123160000_publishing_house_pages.sql

select pg_temp.assert(pg_temp.seen(:HA) = 'P112 Drita|' || current_setting('p112.hd') || '|',
  'part5: the migration again: house columns back, no link');

select 'ALL PASS' as result;
