-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for LR1 patch 4
-- (supabase/migrations/20261126090000_libraria_reading_picks.sql):
--
-- * part1 libraria_reading_picks: RLS on, nobody writes directly, anon
--   cannot read it.
-- * part2 staff_save_libraria_reading_pick: owner/admin only; published,
--   pre-order, free and 18+ books can be picked, a draft is refused
--   (LB540); badge optional up to 24, note 1-400 and quote 1-240
--   characters as one paragraph, quote from the book or the author.
-- * part3 public_libraria_reading_picks: newest first; hides a pick whose
--   book is not listed or has no price (and shows it again).
-- * part4 editing keeps the published date; staff_delete; a deleted book
--   takes its picks.
-- * part5 audit rows and grants.
-- * part6 staff_has_permission('catalog.feature'): owner and admin, now
--   in the database too (lr4-6 a); editor, moderator, support and
--   non-staff never; the admin's other permissions are unchanged.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/121_libraria_reading_picks.test.sql
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

-- A = author, O = owner, D = admin, M = moderator (staff).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1210000-0000-4000-8000-00000000000a', 'r121-a@test', now(), '{"role":"author","display_name":"R121 Autor"}'),
  ('e1210000-0000-4000-8000-0000000000e1', 'r121-o@test', now(), '{"role":"reader","display_name":"R121 Owner"}'),
  ('e1210000-0000-4000-8000-0000000000e3', 'r121-d@test', now(), '{"role":"reader","display_name":"R121 Admin"}'),
  ('e1210000-0000-4000-8000-0000000000e2', 'r121-m@test', now(), '{"role":"reader","display_name":"R121 Mod"}');

insert into public.staff_members (user_id, role) values
  ('e1210000-0000-4000-8000-0000000000e1', 'owner'),
  ('e1210000-0000-4000-8000-0000000000e3', 'admin'),
  ('e1210000-0000-4000-8000-0000000000e2', 'moderator');

-- L1 live paid, P2 pre-order, D3 draft, F4 live free, X5 live 18+.
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, file_path, cover_path,
                          categories, release_date, preorder_listed_at, preorder_count, is_adult) values
  ('e1211000-0000-4000-8000-0000000000b1', 'e1210000-0000-4000-8000-00000000000a', 'R121 L1', 'x', '', 'published', 299, now(),
   'a/l1/v1.epub', 'e121100c-0000-4000-8000-0000000000b1/cover.jpg', array['Poezi'], null, null, 0, false),
  ('e1211000-0000-4000-8000-0000000000b2', 'e1210000-0000-4000-8000-00000000000a', 'R121 P2', 'x', '', 'preorder', 399, null,
   'a/p2/v1.epub', 'e121100c-0000-4000-8000-0000000000b2/cover.jpg', array['Poezi'], current_date + 30, now(), 1, false),
  ('e1211000-0000-4000-8000-0000000000b3', 'e1210000-0000-4000-8000-00000000000a', 'R121 D3', 'x', '', 'draft', 199, null,
   null, null, array['Poezi'], null, null, 0, false),
  ('e1211000-0000-4000-8000-0000000000b4', 'e1210000-0000-4000-8000-00000000000a', 'R121 F4', 'x', '', 'published', 0, now(),
   'a/f4/v1.epub', 'e121100c-0000-4000-8000-0000000000b4/cover.jpg', array['Poezi'], null, null, 0, false),
  ('e1211000-0000-4000-8000-0000000000b5', 'e1210000-0000-4000-8000-00000000000a', 'R121 X5', 'x', '', 'published', 249, now(),
   'a/x5/v1.epub', 'e121100c-0000-4000-8000-0000000000b5/cover.jpg', array['Poezi'], null, null, 0, true);

-- Saves a pick; returns 'V:<id>', 'V:<null>' or the SQLSTATE.
create function pg_temp.save(p_id uuid, p_book text, p_badge text, p_note text, p_quote text, p_from text,
                             p_uid uuid default 'e1210000-0000-4000-8000-0000000000e1')
returns text language plpgsql as $$
begin
  return pg_temp.run_as('authenticated', p_uid, format(
    'select public.staff_save_libraria_reading_pick(%L, %L, %L, %L, %L, %L)::text',
    p_id, p_book, p_badge, p_note, p_quote, p_from));
end;
$$;
-- What anon sees, newest first, as titles.
create function pg_temp.public_now() returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  select string_agg(b.title, ',' order by p.published_at desc, p.id desc) into v
    from public.public_libraria_reading_picks p join public.public_books b on b.id = p.book_id;
  reset role;
  return coalesce(v, '<none>');
end;
$$;
-- Spreads the published dates so the order is certain (test only).
create function pg_temp.age(p_book text, p_days int) returns void language sql as $$
  update public.libraria_reading_picks set published_at = now() - make_interval(days => p_days) where book_id = p_book::uuid $$;

-- part1 the table: RLS on; nobody writes directly; anon reads nothing.
select pg_temp.assert(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.libraria_reading_picks'::regclass),
  'part1: row level security on');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e1',
  $q$insert into public.libraria_reading_picks (book_id, note, quote, quote_from)
     values ('e1211000-0000-4000-8000-0000000000b1', 'x', 'y', 'book')$q$) = '42501',
  'part1: nobody writes directly, staff included');
select pg_temp.assert(pg_temp.run_as('anon', null, 'select count(*) from public.libraria_reading_picks') = '42501',
  'part1: anon cannot read the table');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-00000000000a',
  $q$update public.libraria_reading_picks set note = 'x'$q$) = '42501',
  'part1: a signed-in user cannot update it');

-- part2 saving.
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', '  Zgjedhja e Librum ', '  Pse e lexojmë.  ', ' Një citim. ', 'book') like 'V:%',
  'part2: the owner publishes a pick');
insert into pg_temp.kept values ('k1', (select id::text from public.libraria_reading_picks where book_id = 'e1211000-0000-4000-8000-0000000000b1'));
select pg_temp.assert(
  (select badge || '|' || note || '|' || quote || '|' || quote_from from public.libraria_reading_picks where id = (select v::uuid from pg_temp.kept where k = 'k1'))
  = 'Zgjedhja e Librum|Pse e lexojmë.|Një citim.|book', 'part2: badge, note and quote are trimmed');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b2', '   ', 'Vjen në dhjetor.', 'Citim.', 'author', 'e1210000-0000-4000-8000-0000000000e3') like 'V:%',
  'part2: an admin publishes; a pre-order can be picked; a blank badge is no badge (lr4-4 a)');
select pg_temp.assert((select badge is null from public.libraria_reading_picks where book_id = 'e1211000-0000-4000-8000-0000000000b2'),
  'part2: blank badge stored as null');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b4', null, 'Falas.', 'Citim.', 'book') like 'V:%',
  'part2: a free live book can be picked');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b5', null, 'Për të rritur.', 'Citim.', 'book') like 'V:%',
  'part2: an 18+ book can be picked (lr4-5 b)');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b3', null, 'Draft.', 'Citim.', 'book') = 'LB540',
  'part2: a draft is refused');
select pg_temp.assert(pg_temp.save(null, '00000000-0000-4000-8000-000000000999', null, 'x', 'y', 'book') = 'LB540',
  'part2: a missing book is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, '', 'y', 'book') = '23514',
  'part2: an empty note is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, repeat('a', 401), 'y', 'book') = '23514',
  'part2: a note over 400 characters is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, E'two\nlines', 'y', 'book') = '23514',
  'part2: a note on two lines is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'x', '', 'book') = '23514',
  'part2: an empty quote is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'x', repeat('q', 241), 'book') = '23514',
  'part2: a quote over 240 characters is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'x', E'a\rb', 'book') = '23514',
  'part2: a quote with a line break is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', repeat('t', 25), 'x', 'y', 'book') = '23514',
  'part2: a badge over 24 characters is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'x', 'y', 'someone') = '23514',
  'part2: the quote is from the book or the author only');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'x', 'y', null) = '23502',
  'part2: who said it is required');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'x', 'y', 'book', 'e1210000-0000-4000-8000-0000000000e2') = 'P0001',
  'part2: a moderator is refused');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'x', 'y', 'book', 'e1210000-0000-4000-8000-00000000000a') = 'P0001',
  'part2: the author is refused');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.staff_save_libraria_reading_pick(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'x', 'y', 'book')::text$q$) = '42501',
  'part2: anon cannot call it');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, repeat('a', 400), repeat('q', 240), 'author') like 'V:%',
  'part2: 400 and 240 characters are fine');
delete from public.libraria_reading_picks where note = repeat('a', 400);
select pg_temp.assert((select count(*) from public.libraria_reading_picks) = 4, 'part2: four saved, each refusal saved nothing');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e1',
  'select count(*) from public.libraria_reading_picks') = 'V:4', 'part2: staff read every row');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e2',
  'select count(*) from public.libraria_reading_picks') = 'V:0', 'part2: a moderator reads none');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-00000000000a',
  'select count(*) from public.libraria_reading_picks') = 'V:0', 'part2: an author reads none');

-- part3 what readers see: newest first; an off-sale book hides its pick.
select pg_temp.age('e1211000-0000-4000-8000-0000000000b1', 40);
select pg_temp.age('e1211000-0000-4000-8000-0000000000b2', 30);
select pg_temp.age('e1211000-0000-4000-8000-0000000000b4', 20);
select pg_temp.age('e1211000-0000-4000-8000-0000000000b5', 10);
select pg_temp.assert(pg_temp.public_now() = 'R121 X5,R121 F4,R121 P2,R121 L1', 'part3: anon sees every pick, newest first (lr4-1 a)');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b1', null, 'Përsëri.', 'Citim.', 'book') like 'V:%',
  'part3: a new pick of a book picked before');
select pg_temp.assert(pg_temp.public_now() = 'R121 L1,R121 X5,R121 F4,R121 P2,R121 L1', 'part3: the new pick is first, the old one stays as a past pick');
delete from public.libraria_reading_picks where note = 'Përsëri.';
update public.books set status = 'draft' where id = 'e1211000-0000-4000-8000-0000000000b5';
select pg_temp.assert(pg_temp.public_now() = 'R121 F4,R121 P2,R121 L1', 'part3: an off-sale book hides its pick; the newest still on sale is first (lr4-3 a)');
select pg_temp.assert((select count(*) from public.libraria_reading_picks) = 4, 'part3: the pick stays for staff');
set local session_replication_role = replica;
update public.books set status = 'published' where id = 'e1211000-0000-4000-8000-0000000000b5';
set local session_replication_role = origin;
select pg_temp.assert(pg_temp.public_now() = 'R121 X5,R121 F4,R121 P2,R121 L1', 'part3: and comes back with the book');
update public.books set price_all = null where id = 'e1211000-0000-4000-8000-0000000000b4';
select pg_temp.assert(pg_temp.public_now() = 'R121 X5,R121 P2,R121 L1', 'part3: a book with no price hides its pick');
select pg_temp.assert(pg_temp.save(null, 'e1211000-0000-4000-8000-0000000000b4', null, 'x', 'y', 'book') = 'LB540',
  'part3: and cannot be picked');
update public.books set price_all = 0 where id = 'e1211000-0000-4000-8000-0000000000b4';
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-00000000000a',
  'select count(*) from public.public_libraria_reading_picks') = 'V:4', 'part3: signed-in readers see them too');

-- part4 editing keeps the date; delete.
insert into pg_temp.kept values ('k1date', (select published_at::text from public.libraria_reading_picks where id = (select v::uuid from pg_temp.kept where k = 'k1')));
select pg_temp.assert(pg_temp.save((select v::uuid from pg_temp.kept where k = 'k1'), 'e1211000-0000-4000-8000-0000000000b1', 'Libri i muajit', 'Shënim i ri.', 'Citim i ri.', 'author')
  = 'V:' || (select v from pg_temp.kept where k = 'k1'), 'part4: editing returns the same id');
select pg_temp.assert(
  (select published_at::text = (select v from pg_temp.kept where k = 'k1date') and updated_at > published_at
     from public.libraria_reading_picks where id = (select v::uuid from pg_temp.kept where k = 'k1')),
  'part4: editing keeps the published date');
select pg_temp.assert(pg_temp.public_now() = 'R121 X5,R121 F4,R121 P2,R121 L1', 'part4: so the order does not change');
select pg_temp.assert(pg_temp.save((select v::uuid from pg_temp.kept where k = 'k1'), 'e1211000-0000-4000-8000-0000000000b3', null, 'x', 'y', 'book') = 'LB540',
  'part4: an edit to a draft book is refused');
select pg_temp.assert(pg_temp.save('00000000-0000-4000-8000-000000000999', 'e1211000-0000-4000-8000-0000000000b1', null, 'x', 'y', 'book') = 'V:<null>',
  'part4: editing a missing pick gives null');
select pg_temp.assert((select count(*) from public.libraria_reading_picks) = 4, 'part4: and adds nothing');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e2',
  format('select public.staff_delete_libraria_reading_pick(%L)::text', (select v from pg_temp.kept where k = 'k1'))) = 'P0001',
  'part4: a moderator cannot delete');
select pg_temp.assert(pg_temp.run_as('anon', null,
  format('select public.staff_delete_libraria_reading_pick(%L)::text', (select v from pg_temp.kept where k = 'k1'))) = '42501',
  'part4: anon cannot delete');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e1',
  format('select public.staff_delete_libraria_reading_pick(%L)::text', (select v from pg_temp.kept where k = 'k1'))) = 'V:true',
  'part4: the owner deletes it');
select pg_temp.assert(pg_temp.public_now() = 'R121 X5,R121 F4,R121 P2', 'part4: gone');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e1',
  $q$select public.staff_delete_libraria_reading_pick('00000000-0000-4000-8000-000000000999')::text$q$) = 'V:false',
  'part4: deleting a missing pick gives false');
delete from public.books where id = 'e1211000-0000-4000-8000-0000000000b2';
select pg_temp.assert((select count(*) from public.libraria_reading_picks where book_id = 'e1211000-0000-4000-8000-0000000000b2') = 0,
  'part4: deleting a book deletes its picks');

-- part5 audit rows and grants.
select pg_temp.assert((select count(*) from public.admin_audit_log where action = 'libraria.reading_pick_saved') = 7,
  'part5: one audit row per save (5 new, 1 re-pick, 1 edit)');
select pg_temp.assert(
  (select (metadata->'before'->>'note') || '>' || (metadata->'after'->>'note')
     from public.admin_audit_log where action = 'libraria.reading_pick_saved' and metadata->'before' is not null and metadata->'before' <> 'null'::jsonb)
  = 'Pse e lexojmë.>Shënim i ri.', 'part5: an edit keeps before and after');
select pg_temp.assert((select count(*) from public.admin_audit_log where action = 'libraria.reading_pick_deleted') = 1, 'part5: one delete audited');
select pg_temp.assert(
  (select metadata->'before'->>'quote' from public.admin_audit_log where action = 'libraria.reading_pick_deleted') = 'Citim i ri.',
  'part5: the delete keeps the old row');
select pg_temp.assert(
  (select actor_id from public.admin_audit_log where action = 'libraria.reading_pick_saved'
     and metadata->'after'->>'note' = 'Vjen në dhjetor.') = 'e1210000-0000-4000-8000-0000000000e3',
  'part5: the audit row names who saved it');
select pg_temp.assert(not has_table_privilege('anon', 'public.libraria_reading_picks', 'select'), 'part5: anon has no table grant');
select pg_temp.assert(has_table_privilege('anon', 'public.public_libraria_reading_picks', 'select'), 'part5: anon reads the view');
select pg_temp.assert(not has_table_privilege('anon', 'public.public_libraria_reading_picks', 'insert'), 'part5: the view is read-only for anon');
select pg_temp.assert(not has_function_privilege('anon', 'public.staff_delete_libraria_reading_pick(uuid)', 'execute'), 'part5: anon cannot execute delete');
select pg_temp.assert(
  (select pg_catalog.array_to_string(reloptions, ',') from pg_catalog.pg_class where oid = 'public.public_libraria_reading_picks'::regclass) like '%security_barrier%',
  'part5: the view is a security barrier');

-- part6 catalog.feature for owner and admin only (lr4-6 a).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1210000-0000-4000-8000-0000000000e4', 'r121-e@test', now(), '{"role":"reader","display_name":"R121 Editor"}'),
  ('e1210000-0000-4000-8000-0000000000e5', 'r121-s@test', now(), '{"role":"reader","display_name":"R121 Support"}');
insert into public.staff_members (user_id, role) values
  ('e1210000-0000-4000-8000-0000000000e4', 'editor'),
  ('e1210000-0000-4000-8000-0000000000e5', 'support');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e1',
  $q$select public.staff_has_permission('catalog.feature')::text$q$) = 'V:true', 'part6: owner has catalog.feature');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e3',
  $q$select public.staff_has_permission('catalog.feature')::text$q$) = 'V:true', 'part6: admin has catalog.feature');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e4',
  $q$select public.staff_has_permission('catalog.feature')::text$q$) = 'V:false', 'part6: editor does not');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e2',
  $q$select public.staff_has_permission('catalog.feature')::text$q$) = 'V:false', 'part6: moderator does not');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e5',
  $q$select public.staff_has_permission('catalog.feature')::text$q$) = 'V:false', 'part6: support does not');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-00000000000a',
  $q$select public.staff_has_permission('catalog.feature')::text$q$) = 'V:false', 'part6: a non-staff author does not');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e3',
  $q$select public.staff_has_permission('staff.manage')::text$q$) = 'V:false', 'part6: admin still lacks staff.manage');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e3',
  $q$select public.staff_set_libraria_category_buttons(array['Poezi'])::text$q$) not in ('P0001', '42501'),
  'part6: so an admin can save the category buttons (patch 2)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1210000-0000-4000-8000-0000000000e3',
  $q$select public.staff_save_libraria_banner_slide(null, 'e1211000-0000-4000-8000-0000000000b1', 'x', null, 'slides/00000000-0000-4000-8000-000000000001.jpg', null, null, null)::text$q$) like 'V:%',
  'part6: and a banner slide (patch 3)');

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n < 64 then
    raise exception 'FAIL: only % assertions ran (expected at least 64)', v_n;
  end if;
  raise warning '121_libraria_reading_picks: % assertions passed', v_n;
  raise notice 'ALL PASSED: 121_libraria_reading_picks.test.sql (% assertions)', v_n;
end $$;

rollback;
