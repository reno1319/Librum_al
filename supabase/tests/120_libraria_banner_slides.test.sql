-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for LR1 patch 3
-- (supabase/migrations/20261125200000_libraria_banner_slides.sql):
--
-- * part1 libraria_banner_slides: RLS on, nobody writes directly, anon
--   cannot read it.
-- * part2 staff_save_libraria_banner_slide: owner/admin only; published,
--   pre-order and free books can be picked, a draft is refused (LB539);
--   description 1-120 characters on one line, tag optional up to 24,
--   last day not before first day, picture path slides/<uuid>.jpg.
-- * part3 public_libraria_banner_slides: hides a slide whose book is not
--   listed (and shows it again), and one outside its days (Tirana).
-- * part4 at most 6 slides on any day (LB538); ended slides don't count.
-- * part5 staff_move/staff_delete: swap, ends refuse, order closes up,
--   a new slide goes last, a deleted book takes its slides.
-- * part6 audit rows, the "libraria" bucket, the helper's grants.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/120_libraria_banner_slides.test.sql
--
-- Against the BASE schema it fails at part1 (no table): the negative
-- control. Everything runs inside one transaction and is rolled back.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);
create table pg_temp.kept (k text primary key, v text);

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs p_sql as p_role/p_uid; returns 'OK:<rows>' or the SQLSTATE. A
-- single-value select is returned as 'V:<value>'.
create function pg_temp.run_as(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_rows bigint;
  v_out text;
  v_val text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    if p_sql like 'select %' then
      execute p_sql into v_val;
      v_out := 'V:' || coalesce(v_val, '<null>');
    else
      execute p_sql;
      get diagnostics v_rows = row_count;
      v_out := 'OK:' || v_rows;
    end if;
  exception when others then
    v_out := sqlstate;
  end;
  reset role;
  return v_out;
end;
$$;

-- A = author, O = owner (staff), M = moderator (staff).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1200000-0000-4000-8000-00000000000a', 'r120-a@test', now(), '{"role":"author","display_name":"R120 Autor"}'),
  ('e1200000-0000-4000-8000-0000000000e1', 'r120-o@test', now(), '{"role":"reader","display_name":"R120 Owner"}'),
  ('e1200000-0000-4000-8000-0000000000e2', 'r120-m@test', now(), '{"role":"reader","display_name":"R120 Mod"}');

insert into public.staff_members (user_id, role) values
  ('e1200000-0000-4000-8000-0000000000e1', 'owner'),
  ('e1200000-0000-4000-8000-0000000000e2', 'moderator');

-- L1 live paid, P2 pre-order, D3 draft, F4 live free.
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, file_path, cover_path,
                          categories, release_date, preorder_listed_at, preorder_count) values
  ('e1201000-0000-4000-8000-0000000000b1', 'e1200000-0000-4000-8000-00000000000a', 'R120 L1', 'x', '', 'published', 299, now(),
   'a/l1/v1.epub', 'e120100c-0000-4000-8000-0000000000b1/cover.jpg', array['Poezi'], null, null, 0),
  ('e1201000-0000-4000-8000-0000000000b2', 'e1200000-0000-4000-8000-00000000000a', 'R120 P2', 'x', '', 'preorder', 399, null,
   'a/p2/v1.epub', 'e120100c-0000-4000-8000-0000000000b2/cover.jpg', array['Poezi'], current_date + 30, now(), 1),
  ('e1201000-0000-4000-8000-0000000000b3', 'e1200000-0000-4000-8000-00000000000a', 'R120 D3', 'x', '', 'draft', 199, null,
   null, null, array['Poezi'], null, null, 0),
  ('e1201000-0000-4000-8000-0000000000b4', 'e1200000-0000-4000-8000-00000000000a', 'R120 F4', 'x', '', 'published', 0, now(),
   'a/f4/v1.epub', 'e120100c-0000-4000-8000-0000000000b4/cover.jpg', array['Poezi'], null, null, 0);

-- Saves a slide as the owner; returns the id, or the SQLSTATE.
create function pg_temp.save(p_id uuid, p_book text, p_desc text, p_tag text, p_from int, p_to int, p_uid uuid default 'e1200000-0000-4000-8000-0000000000e1')
returns text language plpgsql as $$
begin
  return pg_temp.run_as('authenticated', p_uid, format(
    $f$select public.staff_save_libraria_banner_slide(%L, %L, %L, %L, %L, null,
        (now() at time zone 'Europe/Tirane')::date + %s, (now() at time zone 'Europe/Tirane')::date + %s)::text$f$,
    p_id, p_book, p_desc, p_tag, 'slides/' || gen_random_uuid() || '.jpg',
    coalesce(p_from::text, 'null::int'), coalesce(p_to::text, 'null::int')));
end;
$$;
create function pg_temp.strip(v text) returns uuid language sql as $$ select substr(v, 3)::uuid $$;
create function pg_temp.order_now() returns text language sql as $$
  select string_agg(s.position || ':' || b.title || coalesce('/' || s.tag, ''), ',' order by s.position)
    from public.libraria_banner_slides s join public.books b on b.id = s.book_id $$;

-- part1 the table: RLS on; nobody writes directly; anon reads nothing; staff read.
select pg_temp.assert(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.libraria_banner_slides'::regclass),
  'part1: row level security on');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  $q$insert into public.libraria_banner_slides (position, book_id, description, image_path)
     values (1, 'e1201000-0000-4000-8000-0000000000b1', 'x', 'slides/00000000-0000-4000-8000-000000000001.jpg')$q$) = '42501',
  'part1: nobody writes directly, staff included');
select pg_temp.assert(pg_temp.run_as('anon', null, 'select count(*) from public.libraria_banner_slides') = '42501',
  'part1: anon cannot read the table');

-- part2 saving.
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', '  Një roman për malet.  ', 'Ofertë', null, null) like 'V:%',
  'part2: the owner saves a slide');
insert into pg_temp.kept values ('s1', (select id::text from public.libraria_banner_slides where book_id = 'e1201000-0000-4000-8000-0000000000b1'));
select pg_temp.assert((select description from public.libraria_banner_slides where id = (select v::uuid from pg_temp.kept where k = 's1')) = 'Një roman për malet.',
  'part2: the description is trimmed');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b2', 'Vjen në dhjetor.', '   ', null, null) like 'V:%',
  'part2: a pre-order can be picked (lr3-8 a); a blank tag is no tag');
select pg_temp.assert((select tag is null from public.libraria_banner_slides where book_id = 'e1201000-0000-4000-8000-0000000000b2'),
  'part2: blank tag stored as null');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b4', 'Falas.', null, null, null) like 'V:%',
  'part2: a free live book can be picked');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b3', 'Draft.', null, null, null) = 'LB539',
  'part2: a draft is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', '', null, null, null) = '23514',
  'part2: an empty description is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', repeat('a', 121), null, null, null) = '23514',
  'part2: a description over 120 characters is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', repeat('a', 120), null, null, null) like 'V:%',
  'part2: 120 characters is fine');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'x', repeat('t', 25), null, null) = '23514',
  'part2: a tag over 24 characters is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', E'two\nlines', null, null, null) = '23514',
  'part2: a description on two lines is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'x', null, 5, 2) = '23514',
  'part2: a last day before the first day is refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  $q$select public.staff_save_libraria_banner_slide(null, 'e1201000-0000-4000-8000-0000000000b1', 'x', null, 'covers/evil.jpg', null, null, null)::text$q$) = '23514',
  'part2: a picture path outside slides/<uuid>.jpg is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'x', null, null, null, 'e1200000-0000-4000-8000-0000000000e2') = 'P0001',
  'part2: a moderator is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'x', null, null, null, 'e1200000-0000-4000-8000-00000000000a') = 'P0001',
  'part2: the author is refused');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.staff_save_libraria_banner_slide(null, 'e1201000-0000-4000-8000-0000000000b1', 'x', null, 'slides/00000000-0000-4000-8000-000000000001.jpg', null, null, null)::text$q$) = '42501',
  'part2: anon cannot call it');
select pg_temp.assert(pg_temp.order_now() = '1:R120 L1/Ofertë,2:R120 P2,3:R120 F4,4:R120 L1',
  'part2: four saved, in order, each refusal saved nothing');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  'select count(*) from public.libraria_banner_slides') = 'V:4', 'part2: staff read every row');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e2',
  'select count(*) from public.libraria_banner_slides') = 'V:0', 'part2: a moderator reads none');
select pg_temp.assert((select count(*) from public.admin_audit_log where action = 'libraria.banner_slide_saved') = 4,
  'part2: one audit row per save');

-- part3 what readers see: listed book, days include today.
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.public_libraria_banner_slides$q$) = 'V:4', 'part3: anon sees the four');
update public.books set status = 'draft' where id = 'e1201000-0000-4000-8000-0000000000b4';
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.public_libraria_banner_slides$q$) = 'V:3', 'part3: a book taken off sale hides its slide (lr3-5 a)');
select pg_temp.assert((select count(*) from public.libraria_banner_slides) = 4, 'part3: the slide stays for staff');
-- Back to published without a new review (test only: triggers skipped).
set local session_replication_role = replica;
update public.books set status = 'published' where id = 'e1201000-0000-4000-8000-0000000000b4';
set local session_replication_role = origin;
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.public_libraria_banner_slides$q$) = 'V:4', 'part3: and comes back with the book');
-- Edit slide 4 to start tomorrow, then to have ended yesterday.
insert into pg_temp.kept values ('s4', (select id::text from public.libraria_banner_slides where position = 4));
select pg_temp.assert(pg_temp.save((select v::uuid from pg_temp.kept where k = 's4'), 'e1201000-0000-4000-8000-0000000000b1', 'Nesër.', null, 1, null) = 'V:' || (select v from pg_temp.kept where k = 's4'),
  'part3: editing returns the same id');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.public_libraria_banner_slides$q$) = 'V:3', 'part3: a slide starting tomorrow is hidden');
select pg_temp.assert(pg_temp.save((select v::uuid from pg_temp.kept where k = 's4'), 'e1201000-0000-4000-8000-0000000000b1', 'Dje.', null, -3, -1) like 'V:%',
  'part3: saved as ended yesterday');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.public_libraria_banner_slides$q$) = 'V:3', 'part3: an ended slide is hidden');
select pg_temp.assert(pg_temp.save((select v::uuid from pg_temp.kept where k = 's4'), 'e1201000-0000-4000-8000-0000000000b1', 'Sot.', null, 0, 0) like 'V:%',
  'part3: today only');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.public_libraria_banner_slides$q$) = 'V:4', 'part3: first day = last day = today shows');
select pg_temp.assert(pg_temp.save('00000000-0000-4000-8000-000000000999', 'e1201000-0000-4000-8000-0000000000b1', 'x', null, null, null) = 'V:<null>',
  'part3: editing a missing slide gives null');

-- part4 at most 6 on any day (lr3-7 a). Now: 3 open slides + slide 4 today only.
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'Five.', null, null, null) like 'V:%', 'part4: a fifth');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'Six.', null, null, null) like 'V:%', 'part4: a sixth');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'Seven now.', null, null, null) = 'LB538',
  'part4: a seventh showing today is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'Seven tomorrow.', null, 1, null) like 'V:%',
  'part4: a seventh from tomorrow is fine (slide 4 ends today)');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'Eight.', null, 5, 6) = 'LB538',
  'part4: an eighth on days six already show is refused');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'Old.', null, -10, -2) like 'V:%',
  'part4: a slide that already ended does not count');
select pg_temp.assert(pg_temp.save((select v::uuid from pg_temp.kept where k = 's4'), 'e1201000-0000-4000-8000-0000000000b1', 'Sot.', null, 0, 1) = 'LB538',
  'part4: stretching slide 4 into tomorrow is refused');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.public_libraria_banner_slides$q$) = 'V:6', 'part4: six show today');
select pg_temp.assert((select count(*) from public.libraria_banner_slides) = 8, 'part4: eight saved');

-- part5 move and delete.
delete from public.libraria_banner_slides where position > 4;
select pg_temp.assert(pg_temp.order_now() = '1:R120 L1/Ofertë,2:R120 P2,3:R120 F4,4:R120 L1', 'part5: four left (test reset)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  format('select public.staff_move_libraria_banner_slide(%L, true)::text', (select id from public.libraria_banner_slides where position = 3))) = 'V:true',
  'part5: move 3 up');
select pg_temp.assert(pg_temp.order_now() = '1:R120 L1/Ofertë,2:R120 F4,3:R120 P2,4:R120 L1', 'part5: swapped');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  format('select public.staff_move_libraria_banner_slide(%L, true)::text', (select id from public.libraria_banner_slides where position = 1))) = 'V:false',
  'part5: the first cannot move up');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  format('select public.staff_move_libraria_banner_slide(%L, false)::text', (select id from public.libraria_banner_slides where position = 4))) = 'V:false',
  'part5: the last cannot move down');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  format('select public.staff_move_libraria_banner_slide(%L, false)::text', (select id from public.libraria_banner_slides where position = 1))) = 'V:true',
  'part5: move 1 down');
select pg_temp.assert(pg_temp.order_now() = '1:R120 F4,2:R120 L1/Ofertë,3:R120 P2,4:R120 L1', 'part5: swapped again');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e2',
  format('select public.staff_move_libraria_banner_slide(%L, false)::text', (select id from public.libraria_banner_slides where position = 1))) = 'P0001',
  'part5: a moderator cannot move');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e2',
  format('select public.staff_delete_libraria_banner_slide(%L)::text', (select id from public.libraria_banner_slides where position = 1))) = 'P0001',
  'part5: a moderator cannot delete');
select pg_temp.assert(pg_temp.run_as('anon', null,
  format('select public.staff_delete_libraria_banner_slide(%L)::text', (select id from public.libraria_banner_slides where position = 1))) = '42501',
  'part5: anon cannot delete');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  format('select public.staff_delete_libraria_banner_slide(%L)::text', (select id from public.libraria_banner_slides where position = 2))) = 'V:true',
  'part5: the owner deletes slide 2');
select pg_temp.assert(pg_temp.order_now() = '1:R120 F4,2:R120 P2,3:R120 L1', 'part5: the order closes up');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1200000-0000-4000-8000-0000000000e1',
  $q$select public.staff_delete_libraria_banner_slide('00000000-0000-4000-8000-000000000999')::text$q$) = 'V:false',
  'part5: deleting a missing slide gives false');
select pg_temp.assert(pg_temp.save(null, 'e1201000-0000-4000-8000-0000000000b1', 'New last.', null, null, null) like 'V:%', 'part5: a new slide');
select pg_temp.assert(pg_temp.order_now() = '1:R120 F4,2:R120 P2,3:R120 L1,4:R120 L1', 'part5: goes last');
delete from public.books where id = 'e1201000-0000-4000-8000-0000000000b2';
select pg_temp.assert((select count(*) from public.libraria_banner_slides where book_id = 'e1201000-0000-4000-8000-0000000000b2') = 0,
  'part5: deleting a book deletes its slides');

-- part6 audit and the bucket.
select pg_temp.assert((select count(*) from public.admin_audit_log where action = 'libraria.banner_slide_moved') = 2, 'part6: two moves audited');
select pg_temp.assert((select count(*) from public.admin_audit_log where action = 'libraria.banner_slide_deleted') = 1, 'part6: one delete audited');
select pg_temp.assert(
  (select metadata->'before'->>'description' from public.admin_audit_log where action = 'libraria.banner_slide_deleted') = 'Një roman për malet.',
  'part6: the delete keeps the old row');
select pg_temp.assert(
  (select (metadata->'before'->>'description') || '>' || (metadata->'after'->>'description')
     from public.admin_audit_log where action = 'libraria.banner_slide_saved' and metadata->'before'->>'description' = 'Nesër.') = 'Nesër.>Dje.',
  'part6: an edit keeps before and after');
select pg_temp.assert(
  (select public::text || ':' || file_size_limit || ':' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'libraria')
  = 'true:5242880:image/jpeg', 'part6: public bucket, 5 MB, JPEG only');
select pg_temp.assert(
  (select count(*) from pg_catalog.pg_policies where schemaname = 'storage' and (qual like '%libraria%' or with_check like '%libraria%')) = 0,
  'part6: no storage policy names the bucket (service role only)');
select pg_temp.assert(not has_function_privilege('authenticated', 'public.libraria_banner_busiest_day_count(uuid, date, date)', 'execute'),
  'part6: the helper is not callable by users');

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n < 60 then
    raise exception 'FAIL: only % assertions ran (expected at least 60)', v_n;
  end if;
  raise warning '120_libraria_banner_slides: % assertions passed', v_n;
  raise notice 'ALL PASSED: 120_libraria_banner_slides.test.sql (% assertions)', v_n;
end $$;

rollback;
