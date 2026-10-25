-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for HOME-PICKS-1
-- (supabase/migrations/20261025100000_home_featured_slots.sql):
--
-- * part1 grants: home_featured_slots has RLS on, service_role SELECT
--   only, anon/authenticated/PUBLIC nothing, and nobody writes it
--   directly; public_home_featured_slots is SELECT-only for anon,
--   authenticated and service_role and exposes slot, book_id and
--   sponsored only; the two functions are EXECUTE-able by service_role
--   only, and both are SECURITY DEFINER with an empty search_path.
-- * part2 set_home_featured_slot(): 'ok' for a published book with a
--   cover and a price (free = 0 counts); 'not_eligible' for a draft, a
--   book with no cover, no price, or a missing book, changing nothing;
--   'in_slot_N' when the book already fills slot N, changing
--   nothing; re-saving the same book in its slot only changes the tick
--   and set_by; a new book in a slot replaces the old one with the new
--   tick; a bad slot or a null argument raises.
-- * part3 the public view: shows only slots whose book is published; a
--   book going back to draft (unpublish, takedown, review, suspension
--   all set 'draft') drops out and comes back when republished, with
--   its tick.
-- * part4 clear_home_featured_slot() empties one slot only; deleting a
--   book empties its slot; deleting the staff account keeps the slot
--   with set_by null.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/083_home_featured_slots.test.sql
--
-- It must also pass against the base schema.sql plus the migration.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);
grant select, update on pg_temp.assertions_run to anon, authenticated, service_role;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs p_sql as p_role with auth.uid() = p_sub; returns the first
-- column of the first row as text ('' when no row), or
-- '<sqlstate>:<message>'. Each call is its own subtransaction.
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
    v_out := coalesce(v_out, '');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

-- set_home_featured_slot as service_role.
create function pg_temp.set_slot(p_slot int, p_book uuid, p_sponsored boolean) returns text
  language sql as $$
  select pg_temp.value_as('service_role', null, format(
    'select public.set_home_featured_slot(%s::smallint, %L::uuid, %L::boolean, %L::uuid)',
    p_slot, p_book, p_sponsored, 'e0830000-0000-4000-8000-0000000000f1'))
$$;

-- Every slot row as 'slot:book-suffix:sponsored', in slot order.
create function pg_temp.slots() returns text
  language sql as $$
  select coalesce(string_agg(slot || ':' || right(book_id::text, 2) || ':' || sponsored, ' ' order by slot), '')
    from public.home_featured_slots
$$;

-- The public view as anon, same shape.
create function pg_temp.public_slots() returns text
  language sql as $$
  select pg_temp.value_as('anon', null,
    $q$select coalesce(string_agg(slot || ':' || right(book_id::text, 2) || ':' || sponsored, ' ' order by slot), '')
         from public.public_home_featured_slots$q$)
$$;

-- ============================================================
-- Fixtures: author A; staff account S (set_by); books
--   b1 published, cover, 499    b2 published, cover, free (0)
--   b3 published, cover, 299    b4 draft, cover, 199
--   b5 published, no cover      b6 published, cover, no price
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0830000-0000-4000-8000-00000000000a', 'h083-a@test', now(), '{"role":"author","display_name":"H083 Author"}'),
  ('e0830000-0000-4000-8000-0000000000f1', 'h083-s@test', now(), '{"role":"reader","display_name":"H083 Staff"}');

insert into public.books (id, author_id, title, status, price_all, published_at, cover_path) values
  ('e0830001-0000-4000-8000-0000000000b1', 'e0830000-0000-4000-8000-00000000000a', 'H083 One', 'published', 499, now(), 'e0830001-0000-4000-8000-0000000000b1/cover.jpg'),
  ('e0830001-0000-4000-8000-0000000000b2', 'e0830000-0000-4000-8000-00000000000a', 'H083 Free', 'published', 0, now(), 'e0830001-0000-4000-8000-0000000000b2/cover.jpg'),
  ('e0830001-0000-4000-8000-0000000000b3', 'e0830000-0000-4000-8000-00000000000a', 'H083 Three', 'published', 299, now(), 'e0830001-0000-4000-8000-0000000000b3/cover.jpg'),
  ('e0830001-0000-4000-8000-0000000000b4', 'e0830000-0000-4000-8000-00000000000a', 'H083 Draft', 'draft', 199, null, 'e0830001-0000-4000-8000-0000000000b4/cover.jpg'),
  ('e0830001-0000-4000-8000-0000000000b5', 'e0830000-0000-4000-8000-00000000000a', 'H083 No cover', 'published', 199, now(), null),
  ('e0830001-0000-4000-8000-0000000000b6', 'e0830000-0000-4000-8000-00000000000a', 'H083 No price', 'published', null, now(), 'e0830001-0000-4000-8000-0000000000b6/cover.jpg');

-- ============================================================
-- part1: grants
-- ============================================================
do $$
declare
  v_priv text;
  v_role text;
begin
  perform pg_temp.assert(
    (select relrowsecurity from pg_class where oid = 'public.home_featured_slots'::regclass),
    'part1: RLS is on for home_featured_slots');
  perform pg_temp.assert(
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'home_featured_slots'),
    'part1: home_featured_slots has no policy');

  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      perform pg_temp.assert(
        not has_table_privilege(v_role, 'public.home_featured_slots', v_priv),
        format('part1: %s holds no %s on home_featured_slots', v_role, v_priv));
    end loop;
    perform pg_temp.assert(
      not has_any_column_privilege(v_role, 'public.home_featured_slots', 'SELECT,INSERT,UPDATE,REFERENCES'),
      format('part1: %s holds no column privilege on home_featured_slots', v_role));
  end loop;

  perform pg_temp.assert(has_table_privilege('service_role', 'public.home_featured_slots', 'SELECT'),
    'part1: service_role may read home_featured_slots');
  foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    perform pg_temp.assert(
      not has_table_privilege('service_role', 'public.home_featured_slots', v_priv),
      format('part1: service_role holds no %s on home_featured_slots', v_priv));
  end loop;

  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    perform pg_temp.assert(has_table_privilege(v_role, 'public.public_home_featured_slots', 'SELECT'),
      format('part1: %s may read public_home_featured_slots', v_role));
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      perform pg_temp.assert(
        not has_table_privilege(v_role, 'public.public_home_featured_slots', v_priv),
        format('part1: %s holds no %s on public_home_featured_slots', v_role, v_priv));
    end loop;
  end loop;

  perform pg_temp.assert(
    (select string_agg(attname, ',' order by attnum) from pg_attribute
      where attrelid = 'public.public_home_featured_slots'::regclass and attnum > 0 and not attisdropped)
    = 'slot,book_id,sponsored',
    'part1: the public view exposes slot, book_id and sponsored only');

  foreach v_role in array array['anon', 'authenticated'] loop
    perform pg_temp.assert(
      not has_function_privilege(v_role, 'public.set_home_featured_slot(smallint,uuid,boolean,uuid)', 'EXECUTE'),
      format('part1: %s cannot execute set_home_featured_slot', v_role));
    perform pg_temp.assert(
      not has_function_privilege(v_role, 'public.clear_home_featured_slot(smallint)', 'EXECUTE'),
      format('part1: %s cannot execute clear_home_featured_slot', v_role));
  end loop;
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.set_home_featured_slot(smallint,uuid,boolean,uuid)', 'EXECUTE'),
    'part1: service_role may execute set_home_featured_slot');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.clear_home_featured_slot(smallint)', 'EXECUTE'),
    'part1: service_role may execute clear_home_featured_slot');
  perform pg_temp.assert(
    not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid in ('public.set_home_featured_slot(smallint,uuid,boolean,uuid)'::regprocedure,
                                 'public.clear_home_featured_slot(smallint)'::regprocedure)
                   and a.grantee = 0),
    'part1: PUBLIC cannot execute either function');

  -- Both writers run as their owner, so each must pin an empty
  -- search_path (every name inside is schema-qualified).
  perform pg_temp.assert(
    (select count(*) = 2
            and bool_and(coalesce(p.prosecdef and p.proconfig = array['search_path=""']::text[], false))
       from pg_proc p
      where p.oid in ('public.set_home_featured_slot(smallint,uuid,boolean,uuid)'::regprocedure,
                      'public.clear_home_featured_slot(smallint)'::regprocedure)),
    'part1: both functions are SECURITY DEFINER with search_path empty');
end $$;

-- Direct writes are refused before RLS for every API role.
do $$
declare
  v text;
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    v := pg_temp.value_as(v_role, 'e0830000-0000-4000-8000-00000000000a',
      $q$insert into public.home_featured_slots (slot, book_id) values (1, 'e0830001-0000-4000-8000-0000000000b1') returning slot::text$q$);
    perform pg_temp.assert(v like '42501:%', format('part1: %s cannot insert a slot directly -- got %s', v_role, v));
  end loop;
  v := pg_temp.value_as('anon', null, 'select public.clear_home_featured_slot(1::smallint)::text');
  perform pg_temp.assert(v like '42501:%', format('part1: anon cannot call clear_home_featured_slot -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0830000-0000-4000-8000-00000000000a',
    $q$select public.set_home_featured_slot(1::smallint, 'e0830001-0000-4000-8000-0000000000b1'::uuid, false, null)$q$);
  perform pg_temp.assert(v like '42501:%', format('part1: authenticated cannot call set_home_featured_slot -- got %s', v));
end $$;

-- ============================================================
-- part2: set_home_featured_slot
-- ============================================================
select pg_temp.assert(pg_temp.set_slot(1, 'e0830001-0000-4000-8000-0000000000b1', true) = 'ok', 'part2: a priced book with a cover fills slot 1');
select pg_temp.assert(pg_temp.set_slot(2, 'e0830001-0000-4000-8000-0000000000b2', false) = 'ok', 'part2: a free book (0) fills slot 2');
select pg_temp.assert(pg_temp.slots() = '1:b1:true 2:b2:false', format('part2: two slots filled -- got %s', pg_temp.slots()));
select pg_temp.assert(
  (select set_by from public.home_featured_slots where slot = 1) = 'e0830000-0000-4000-8000-0000000000f1',
  'part2: set_by is recorded');

select pg_temp.assert(pg_temp.set_slot(3, 'e0830001-0000-4000-8000-0000000000b4', false) = 'not_eligible', 'part2: a draft is refused');
select pg_temp.assert(pg_temp.set_slot(3, 'e0830001-0000-4000-8000-0000000000b5', false) = 'not_eligible', 'part2: a book with no cover is refused');
select pg_temp.assert(pg_temp.set_slot(3, 'e0830001-0000-4000-8000-0000000000b6', false) = 'not_eligible', 'part2: a book with no price is refused');
select pg_temp.assert(pg_temp.set_slot(3, 'e0830001-0000-4000-8000-0000000000ff', false) = 'not_eligible', 'part2: a missing book is refused');
select pg_temp.assert(pg_temp.set_slot(1, 'e0830001-0000-4000-8000-0000000000b4', false) = 'not_eligible', 'part2: a refused pick over a filled slot');
select pg_temp.assert(pg_temp.slots() = '1:b1:true 2:b2:false', format('part2: refusals change nothing -- got %s', pg_temp.slots()));

select pg_temp.assert(pg_temp.set_slot(3, 'e0830001-0000-4000-8000-0000000000b1', false) = 'in_slot_1', 'part2: a book in slot 1 cannot also fill slot 3');
select pg_temp.assert(pg_temp.set_slot(2, 'e0830001-0000-4000-8000-0000000000b1', false) = 'in_slot_1', 'part2: nor replace slot 2');
select pg_temp.assert(pg_temp.slots() = '1:b1:true 2:b2:false', format('part2: in_slot_N changes nothing -- got %s', pg_temp.slots()));

select pg_temp.assert(pg_temp.set_slot(1, 'e0830001-0000-4000-8000-0000000000b1', false) = 'ok', 'part2: re-saving the same book only changes the tick');
select pg_temp.assert(pg_temp.slots() = '1:b1:false 2:b2:false', format('part2: tick cleared -- got %s', pg_temp.slots()));
select pg_temp.assert(pg_temp.set_slot(2, 'e0830001-0000-4000-8000-0000000000b3', true) = 'ok', 'part2: a new book replaces slot 2');
select pg_temp.assert(pg_temp.slots() = '1:b1:false 2:b3:true', format('part2: slot 2 now b3, paid -- got %s', pg_temp.slots()));

do $$
declare v text;
begin
  v := pg_temp.set_slot(0, 'e0830001-0000-4000-8000-0000000000b2', false);
  perform pg_temp.assert(v like 'P0001:%', format('part2: slot 0 raises -- got %s', v));
  v := pg_temp.set_slot(4, 'e0830001-0000-4000-8000-0000000000b2', false);
  perform pg_temp.assert(v like 'P0001:%', format('part2: slot 4 raises -- got %s', v));
  v := pg_temp.value_as('service_role', null,
    $q$select public.set_home_featured_slot(3::smallint, null, false, null)$q$);
  perform pg_temp.assert(v like 'P0001:%', format('part2: a null book raises -- got %s', v));
  v := pg_temp.value_as('service_role', null,
    $q$select public.set_home_featured_slot(3::smallint, 'e0830001-0000-4000-8000-0000000000b2'::uuid, null, null)$q$);
  perform pg_temp.assert(v like 'P0001:%', format('part2: a null tick raises -- got %s', v));
  v := pg_temp.value_as('service_role', null, 'select public.clear_home_featured_slot(9::smallint)::text');
  perform pg_temp.assert(v like 'P0001:%', format('part2: clearing slot 9 raises -- got %s', v));
end $$;

-- The table itself refuses a fourth slot and a second row for a book.
do $$
begin
  begin
    insert into public.home_featured_slots (slot, book_id) values (4, 'e0830001-0000-4000-8000-0000000000b2');
    perform pg_temp.assert(false, 'part2: slot 4 must violate the check');
  exception when check_violation then
    perform pg_temp.assert(true, 'part2: slot 4 violates the check');
  end;
  begin
    insert into public.home_featured_slots (slot, book_id) values (3, 'e0830001-0000-4000-8000-0000000000b1');
    perform pg_temp.assert(false, 'part2: a second row for b1 must violate the unique key');
  exception when unique_violation then
    perform pg_temp.assert(true, 'part2: a second row for b1 violates the unique key');
  end;
end $$;

-- ============================================================
-- part3: the public view
-- ============================================================
select pg_temp.assert(pg_temp.public_slots() = '1:b1:false 2:b3:true', format('part3: anon sees both live slots -- got %s', pg_temp.public_slots()));
update public.books set status = 'draft' where id = 'e0830001-0000-4000-8000-0000000000b3';
select pg_temp.assert(pg_temp.public_slots() = '1:b1:false', format('part3: a draft book drops out -- got %s', pg_temp.public_slots()));
select pg_temp.assert(pg_temp.slots() = '1:b1:false 2:b3:true', 'part3: the slot row itself stays');
-- Republishing normally needs a review approval (book_reviews); this
-- test is about the view only, so the books triggers are skipped here.
set local session_replication_role = replica;
update public.books set status = 'published' where id = 'e0830001-0000-4000-8000-0000000000b3';
set local session_replication_role = origin;
select pg_temp.assert(pg_temp.public_slots() = '1:b1:false 2:b3:true', format('part3: republished, back with its tick -- got %s', pg_temp.public_slots()));
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e0830000-0000-4000-8000-00000000000a',
    'select count(*)::text from public.public_home_featured_slots') = '2',
  'part3: authenticated reads the same view');

-- ============================================================
-- part4: clearing and deletes
-- ============================================================
select pg_temp.assert(
  pg_temp.value_as('service_role', null, 'select public.clear_home_featured_slot(2::smallint)::text') = '',
  'part4: clear slot 2');
select pg_temp.assert(pg_temp.slots() = '1:b1:false', format('part4: only slot 2 emptied -- got %s', pg_temp.slots()));
select pg_temp.assert(
  pg_temp.value_as('service_role', null, 'select public.clear_home_featured_slot(3::smallint)::text') = '',
  'part4: clearing an empty slot is fine');

select pg_temp.assert(pg_temp.set_slot(2, 'e0830001-0000-4000-8000-0000000000b2', true) = 'ok', 'part4: b2 into slot 2');
delete from public.books where id = 'e0830001-0000-4000-8000-0000000000b2';
select pg_temp.assert(pg_temp.slots() = '1:b1:false', format('part4: deleting a book empties its slot -- got %s', pg_temp.slots()));

delete from public.profiles where id = 'e0830000-0000-4000-8000-0000000000f1';
select pg_temp.assert(
  (select set_by is null from public.home_featured_slots where slot = 1),
  'part4: deleting the staff account keeps the slot, set_by null');

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  raise warning '083_home_featured_slots: % assertions passed', v_n;
  raise notice 'ALL PASSED: 083_home_featured_slots.test.sql (% assertions)', v_n;
end $$;

rollback;
