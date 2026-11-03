-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD14
-- (supabase/migrations/20261103160000_bd14_pen_name_public_gate.sql):
-- a pen name, and a series, is public only with a published book.
-- Renato's answers 2026-11-03:
-- * Q1a  without a published book, a pen name is seen only by its author
--        and by a reader who owns one of its books (refunded: no);
-- * Q2a  a series likewise: public only with a published book, else its
--        author and an owner of one of its books;
-- * Q3a  a book published once keeps its pen name (and series) public
--        while it exists, even unpublished; deleting it hides them;
-- * Q4a  the rule lives in book_makes_pen_name_public() only, for BD15's
--        pre-order to extend.
-- Also: a suspended author stays hidden; a draft bundle lists nothing;
-- both views are security_barrier, so a caller's own function in WHERE
-- never sees a hidden row (checked with a recording function).
--
-- The schema.sql / migration equivalence, populated data and the
-- rollback are in 089_bd14_pen_name_public_gate_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/089_bd14_pen_name_public_gate.test.sql
--
-- Against the BASE schema it fails at part1 (a draft lists its pen
-- name): the negative control.
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

-- One text value: the names a caller sees, comma-joined, or '-'.
create function pg_temp.pens(p_role text, p_sub text) returns text
  language sql as $$
  select pg_temp.value_as(p_role, p_sub,
    $q$select coalesce(string_agg(name, ',' order by name), '-') from public.public_pen_names where name like 'P089%'$q$);
$$;
create function pg_temp.series_seen(p_role text, p_sub text) returns text
  language sql as $$
  select pg_temp.value_as(p_role, p_sub,
    $q$select coalesce(string_agg(title, ',' order by title), '-') from public.public_series where title like 'P089%'$q$);
$$;

-- ============================================================
-- Fixture (as the table owner):
--   A  author "P089 Ana": one DRAFT book a1 (never published), in
--      series "P089 SA"
--   B  author "P089 Ben": one PUBLISHED book b1, in series "P089 SB"
--   D  author "P089 Dua": one DRAFT book d1 (never published); reader R
--      owns it, reader Q's purchase of it is refunded
--   E  author "P089 Era": a DRAFT bundle only, no book
--   R, Q, X  readers (X owns nothing)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0890000-0000-4000-8000-00000000000a', 'p089-a@test', now(), '{"role":"author","display_name":"P089 Ana"}'),
  ('e0890000-0000-4000-8000-00000000000b', 'p089-b@test', now(), '{"role":"author","display_name":"P089 Ben"}'),
  ('e0890000-0000-4000-8000-00000000000d', 'p089-d@test', now(), '{"role":"author","display_name":"P089 Dua"}'),
  ('e0890000-0000-4000-8000-00000000000e', 'p089-e@test', now(), '{"role":"author","display_name":"P089 Era"}'),
  ('e0890000-0000-4000-8000-0000000000aa', 'p089-r@test', now(), '{"role":"reader","display_name":"P089 R"}'),
  ('e0890000-0000-4000-8000-0000000000bb', 'p089-q@test', now(), '{"role":"reader","display_name":"P089 Q"}'),
  ('e0890000-0000-4000-8000-0000000000cc', 'p089-x@test', now(), '{"role":"reader","display_name":"P089 X"}');
insert into public.series (id, author_id, title) values
  ('e0890003-0000-4000-8000-00000000000a', 'e0890000-0000-4000-8000-00000000000a', 'P089 SA'),
  ('e0890003-0000-4000-8000-00000000000b', 'e0890000-0000-4000-8000-00000000000b', 'P089 SB');
insert into public.books (id, author_id, title, status, price_all, published_at, series_id, series_position) values
  ('e0890001-0000-4000-8000-00000000000a', 'e0890000-0000-4000-8000-00000000000a', 'P089 a1', 'draft', 199, null, 'e0890003-0000-4000-8000-00000000000a', 1),
  ('e0890001-0000-4000-8000-00000000000b', 'e0890000-0000-4000-8000-00000000000b', 'P089 b1', 'published', 199, now(), 'e0890003-0000-4000-8000-00000000000b', 1),
  ('e0890001-0000-4000-8000-00000000000d', 'e0890000-0000-4000-8000-00000000000d', 'P089 d1', 'draft', 199, null, null, null);
insert into public.purchases (book_id, reader_id, amount_cents, refunded_at) values
  ('e0890001-0000-4000-8000-00000000000d', 'e0890000-0000-4000-8000-0000000000aa', 19900, null),
  ('e0890001-0000-4000-8000-00000000000d', 'e0890000-0000-4000-8000-0000000000bb', 19900, now());
insert into public.bundles (id, author_id, title, price_cents, status) values
  ('e0890004-0000-4000-8000-00000000000e', 'e0890000-0000-4000-8000-00000000000e', 'P089 Bundle', 0, 'draft');

-- ============================================================
-- Part 1: who sees which pen name (Q1a).
-- ============================================================
select pg_temp.assert(pg_temp.pens('anon', null) = 'P089 Ben',
  format('part1: anon sees only the pen name with a published book -- got %s', pg_temp.pens('anon', null)));
select pg_temp.assert(pg_temp.pens('authenticated', 'e0890000-0000-4000-8000-0000000000cc') = 'P089 Ben',
  'part1: a reader who owns nothing sees the same');
select pg_temp.assert(pg_temp.pens('authenticated', 'e0890000-0000-4000-8000-00000000000a') = 'P089 Ana,P089 Ben',
  'part1 (Q1a): author A also sees their own draft-only pen name');
select pg_temp.assert(pg_temp.pens('authenticated', 'e0890000-0000-4000-8000-00000000000e') = 'P089 Ben,P089 Era',
  'part1 (Q1a): author E sees their own pen name; their draft bundle lists it for nobody else');
select pg_temp.assert(pg_temp.pens('authenticated', 'e0890000-0000-4000-8000-0000000000aa') = 'P089 Ben,P089 Dua',
  'part1 (Q1a): reader R, who owns D''s never-published book, sees D''s pen name');
select pg_temp.assert(pg_temp.pens('authenticated', 'e0890000-0000-4000-8000-0000000000bb') = 'P089 Ben',
  'part1 (Q1a): reader Q, whose purchase was refunded, does not');
select pg_temp.assert(pg_temp.pens('service_role', null) = 'P089 Ben',
  'part1: the service role reads the view like anon (no auth.uid())');

-- ============================================================
-- Part 2: series (Q2a).
-- ============================================================
select pg_temp.assert(pg_temp.series_seen('anon', null) = 'P089 SB',
  format('part2: anon sees only the series with a published book -- got %s', pg_temp.series_seen('anon', null)));
select pg_temp.assert(pg_temp.series_seen('authenticated', 'e0890000-0000-4000-8000-00000000000a') = 'P089 SA,P089 SB',
  'part2 (Q2a): author A also sees their own draft series');
select pg_temp.assert(pg_temp.series_seen('authenticated', 'e0890000-0000-4000-8000-0000000000cc') = 'P089 SB',
  'part2: another reader does not');
-- R owns a book in A's series once it is moved there? No: a series holds
-- one pen name's books (LB451); an owner case uses D's own series.
insert into public.series (id, author_id, title) values
  ('e0890003-0000-4000-8000-00000000000d', 'e0890000-0000-4000-8000-00000000000d', 'P089 SD');
update public.books set series_id = 'e0890003-0000-4000-8000-00000000000d', series_position = 1
 where id = 'e0890001-0000-4000-8000-00000000000d';
select pg_temp.assert(pg_temp.series_seen('authenticated', 'e0890000-0000-4000-8000-0000000000aa') = 'P089 SB,P089 SD'
  and pg_temp.series_seen('anon', null) = 'P089 SB',
  'part2 (Q2a): reader R sees the series of the book they own; anon still does not');

-- ============================================================
-- Part 3: publish, unpublish, delete (Q3a).
-- ============================================================
-- (A direct insert as the table owner: an UPDATE to 'published' needs
-- an approved review, ADMIN-3.)
delete from public.books where id = 'e0890001-0000-4000-8000-00000000000a';
insert into public.books (id, author_id, title, status, price_all, published_at, series_id, series_position) values
  ('e0890001-0000-4000-8000-00000000000a', 'e0890000-0000-4000-8000-00000000000a', 'P089 a1', 'published', 199, now(), 'e0890003-0000-4000-8000-00000000000a', 1);
select pg_temp.assert(pg_temp.pens('anon', null) = 'P089 Ana,P089 Ben'
  and pg_temp.series_seen('anon', null) = 'P089 SA,P089 SB',
  'part3: publishing A''s book lists A''s pen name and series');
update public.books set status = 'draft' where id = 'e0890001-0000-4000-8000-00000000000a';
select pg_temp.assert(pg_temp.pens('anon', null) = 'P089 Ana,P089 Ben'
  and pg_temp.series_seen('anon', null) = 'P089 SA,P089 SB',
  'part3 (Q3a): unpublished (published_at kept), both stay listed');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_books where id = 'e0890001-0000-4000-8000-00000000000a'$q$) = '0',
  'part3: while the book itself is out of the store');
delete from public.books where id = 'e0890001-0000-4000-8000-00000000000a';
select pg_temp.assert(pg_temp.pens('anon', null) = 'P089 Ben'
  and pg_temp.series_seen('anon', null) = 'P089 SB',
  'part3 (Q3a): deleting the once-published book hides both again');

-- ============================================================
-- Part 4: a suspended author stays hidden, published book or not.
-- ============================================================
insert into public.account_suspensions (user_id, reason)
values ('e0890000-0000-4000-8000-00000000000b', 'P089 test');
select pg_temp.assert(pg_temp.pens('anon', null) = '-'
  and pg_temp.series_seen('anon', null) = '-',
  'part4: B suspended: no pen name and no series listed');
delete from public.account_suspensions where user_id = 'e0890000-0000-4000-8000-00000000000b';

-- ============================================================
-- Part 5: the views' shape, and security_barrier in action.
-- ============================================================
select pg_temp.assert(
  (select reloptions from pg_class where oid = 'public.public_pen_names'::regclass) = array['security_barrier=true']
  and (select reloptions from pg_class where oid = 'public.public_series'::regclass) = array['security_barrier=true'],
  'part5: both views are security_barrier');
select pg_temp.assert(
  pg_get_viewdef('public.public_pen_names'::regclass) like '%book_makes_pen_name_public%'
  and pg_get_viewdef('public.public_series'::regclass) like '%book_makes_pen_name_public%'
  and pg_get_viewdef('public.public_pen_names'::regclass) not like '%published_at%'
  and pg_get_viewdef('public.public_series'::regclass) not like '%published_at%',
  'part5 (Q4a): both views use book_makes_pen_name_public() and state no publish rule of their own');
select pg_temp.assert(
  (select provolatile = 'i' and not prosecdef and proconfig is null
     from pg_proc where oid = 'public.book_makes_pen_name_public(public.books)'::regprocedure)
  and has_function_privilege('anon', 'public.book_makes_pen_name_public(public.books)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.book_makes_pen_name_public(public.books)'::regprocedure and a.grantee = 0),
  'part5: the rule function is immutable, invoker, no SET (inlinable), callable by anon, not by PUBLIC');

-- A caller-supplied function in WHERE must never see a hidden row. The
-- recorder is planned cheapest (cost 0.0001), so without
-- security_barrier the planner would run it first, on every row.
create table pg_temp.seen (name text);
grant insert, select on pg_temp.seen to anon;
create function pg_temp.record_seen(p text) returns boolean
  language plpgsql cost 0.0001 as $$
begin
  insert into pg_temp.seen values (p);
  return true;
end;
$$;
grant execute on function pg_temp.record_seen(text) to anon;
-- Run first, in its own statement: within one expression the EXISTS
-- checks below could be evaluated before the query runs.
select pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_pen_names where pg_temp.record_seen(name)$q$) as ran_public_pen_names;
select pg_temp.assert(
  not exists (select 1 from pg_temp.seen where name in ('P089 Ana', 'P089 Dua', 'P089 Era'))
  and exists (select 1 from pg_temp.seen where name = 'P089 Ben'),
  format('part5: a caller''s own WHERE function saw only listed pen names -- saw %s',
         (select string_agg(name, ',' order by name) from pg_temp.seen where name like 'P089%')));
delete from pg_temp.seen;
select pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_series where pg_temp.record_seen(title)$q$) as ran_public_series;
select pg_temp.assert(
  not exists (select 1 from pg_temp.seen where name in ('P089 SA', 'P089 SD'))
  and exists (select 1 from pg_temp.seen where name = 'P089 SB'),
  format('part5: same for public_series -- saw %s',
         (select string_agg(name, ',' order by name) from pg_temp.seen where name like 'P089%')));

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 21,
    format('expected at least 21 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 089_bd14_pen_name_public_gate.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
