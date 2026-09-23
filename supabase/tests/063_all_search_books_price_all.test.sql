-- Committed SQL regression suite for ALL-SEARCH-1
-- (supabase/migrations/20260922162155_all_search_books_price_all.sql):
-- public.search_books() filters on the ALL catalog column
-- `books.price_all` and excludes every row that has no authored ALL
-- price.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure, same as every other suite in this directory.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/063_all_search_books_price_all.test.sql
--
-- It must also pass against the OTHER build path -- base schema.sql plus
-- the migration -- and
-- supabase/tests/063_all_search_books_price_all_catalog_equivalence.sh
-- is what proves those two paths agree in the first place.
--
-- Everything below runs inside one transaction and is rolled back at the
-- end, so the file is repeatable with no manual cleanup.
--
-- WHAT THIS SUITE IS FOR, stated plainly. Bookstore search is the ONE
-- free/paid-adjacent decision in Patch 2 that does not live in
-- TypeScript: the unsearched grid filters in the application's own query
-- builder, the searched grid delegates to this function. So the
-- application-level tests cannot see a regression here at all -- if this
-- body drifted back to `price_cents`, every vitest suite would still be
-- green while a reader's search returned books at bounds measured in a
-- currency the catalog does not use, including books with no price.
--
-- The fixtures deliberately give every book a `price_cents` that would
-- produce a DIFFERENT answer from its `price_all`, so a body that
-- consulted the legacy column could not accidentally agree.

begin;

set local client_min_messages = warning;

-- The assertion helper counts itself. A suite that silently stopped
-- asserting -- a `do $$ ... $$` block whose queries all returned zero
-- rows, a part deleted in a merge -- passes just as quietly as a real
-- run, so part 8 below pins the exact number of assertions that must
-- have executed.
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

-- ============================================================
-- Part 0: fixtures.
--
-- One author, five published books, one draft. Every `price_cents`
-- value is chosen so that reading it INSTEAD of `price_all` would give a
-- visibly different answer to at least one query below -- the legacy
-- column is never merely absent from the fixtures, it is actively
-- misleading, which is what turns a silent fallback into a failure.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0630000-0000-0000-0000-000000000001', 'p063-author@test', now(),
   '{"role":"author","display_name":"P063 Author","public_author_name":"Zana Kërçi"}');

update public.profiles
  set role = 'author', public_author_name = 'Zana Kërçi'
  where id = 'e0630000-0000-0000-0000-000000000001';

insert into public.books (id, author_id, title, description, keywords, status, price_cents, price_all) values
  -- Free in ALL, but a large legacy price_cents.
  ('e0630001-0000-0000-0000-000000000001', 'e0630000-0000-0000-0000-000000000001',
   'P063 Free Title', 'a free one', 'p063', 'published', 9900, 0),
  -- The ALL floor. price_cents 1 would pass a `>= 99` cents bound only
  -- by accident and fail a `>= 99` lek bound if the columns were swapped.
  ('e0630002-0000-0000-0000-000000000001', 'e0630000-0000-0000-0000-000000000001',
   'P063 Floor Title', 'ninety nine lek', 'p063', 'published', 1, 99),
  -- A mid-range paid title whose legacy column says something else.
  ('e0630003-0000-0000-0000-000000000001', 'e0630000-0000-0000-0000-000000000001',
   'P063 Middle Title', 'five hundred lek', 'p063', 'published', 40000, 500),
  -- The ceiling.
  ('e0630004-0000-0000-0000-000000000001', 'e0630000-0000-0000-0000-000000000001',
   'P063 Ceiling Title', 'a hundred thousand lek', 'p063', 'published', 0, 100000),
  -- THE ROW THIS SUITE EXISTS FOR: published, matchable, with a real
  -- legacy price_cents and NO authored ALL price. Under the base body it
  -- matched every one of the queries below.
  ('e0630005-0000-0000-0000-000000000001', 'e0630000-0000-0000-0000-000000000001',
   'P063 Unpriced Title', 'no all price at all', 'p063', 'published', 25000, null),
  -- A draft, to prove the published-only rule still holds alongside the
  -- new one rather than being replaced by it.
  ('e0630006-0000-0000-0000-000000000001', 'e0630000-0000-0000-0000-000000000001',
   'P063 Draft Title', 'still a draft', 'p063', 'draft', 100, 250);

-- ============================================================
-- Part 1: a row with no authored ALL price never appears, under any
-- combination of filters -- including no filter at all.
-- ============================================================
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.search_books('P063', null, null, null, 500)
  where book_id = 'e0630005-0000-0000-0000-000000000001';
  perform pg_temp.assert(v_count = 0,
    'part1: an unpriced published book must not appear with no price filter');

  select count(*) into v_count
  from public.search_books('P063', null, 0, 100000, 500)
  where book_id = 'e0630005-0000-0000-0000-000000000001';
  perform pg_temp.assert(v_count = 0,
    'part1: an unpriced published book must not appear inside a wide price window');

  -- Its legacy price_cents is 25000, so a body still reading that column
  -- would return it here and nothing else would notice.
  select count(*) into v_count
  from public.search_books('P063', null, 20000, 30000, 500)
  where book_id = 'e0630005-0000-0000-0000-000000000001';
  perform pg_temp.assert(v_count = 0,
    'part1: an unpriced book must not be findable through its legacy price_cents value');
end $$;

-- ============================================================
-- Part 2: the bounds are WHOLE LEK, compared against price_all.
--
-- Each assertion below is chosen so the legacy column gives a different
-- answer. `>= 99` over price_all admits the 99, 500 and 100000 titles;
-- over price_cents it would admit the free title (9900) and the middle
-- title (40000) and REJECT the floor title (1) and the ceiling title (0).
-- ============================================================
do $$
declare
  v_ids uuid[];
begin
  select array_agg(book_id order by book_id) into v_ids
  from public.search_books('P063', null, 99, null, 500);
  perform pg_temp.assert(
    v_ids = array[
      'e0630002-0000-0000-0000-000000000001',
      'e0630003-0000-0000-0000-000000000001',
      'e0630004-0000-0000-0000-000000000001'
    ]::uuid[],
    format('part2: min bound 99 must select exactly the three paid titles, got %s', v_ids));

  select array_agg(book_id order by book_id) into v_ids
  from public.search_books('P063', null, null, 0, 500);
  perform pg_temp.assert(
    v_ids = array['e0630001-0000-0000-0000-000000000001']::uuid[],
    format('part2: max bound 0 must select exactly the free title, got %s', v_ids));

  select array_agg(book_id order by book_id) into v_ids
  from public.search_books('P063', null, 100, 1000, 500);
  perform pg_temp.assert(
    v_ids = array['e0630003-0000-0000-0000-000000000001']::uuid[],
    format('part2: the 100..1000 lek window must select exactly the 500 lek title, got %s', v_ids));

  -- The exact endpoints are inclusive, on both sides.
  select array_agg(book_id order by book_id) into v_ids
  from public.search_books('P063', null, 99, 99, 500);
  perform pg_temp.assert(
    v_ids = array['e0630002-0000-0000-0000-000000000001']::uuid[],
    'part2: the min and max bounds are both inclusive at 99');

  select array_agg(book_id order by book_id) into v_ids
  from public.search_books('P063', null, 100000, 100000, 500);
  perform pg_temp.assert(
    v_ids = array['e0630004-0000-0000-0000-000000000001']::uuid[],
    'part2: the min and max bounds are both inclusive at 100000');
end $$;

-- ============================================================
-- Part 3: the unrelated behaviour this migration must NOT have changed.
-- ============================================================
do $$
declare
  v_count integer;
  v_ids uuid[];
begin
  -- Published-only still holds: the draft has a perfectly valid
  -- price_all of 250 and still never appears.
  select count(*) into v_count
  from public.search_books('P063', null, null, null, 500)
  where book_id = 'e0630006-0000-0000-0000-000000000001';
  perform pg_temp.assert(v_count = 0,
    'part3: a draft with a valid price_all must still be excluded');

  -- Diacritic-tolerant pen-name matching still works, through the safe
  -- view, and still respects the new null rule.
  select array_agg(book_id order by book_id) into v_ids
  from public.search_books('Kerci', null, null, null, 500);
  perform pg_temp.assert(
    v_ids = array[
      'e0630001-0000-0000-0000-000000000001',
      'e0630002-0000-0000-0000-000000000001',
      'e0630003-0000-0000-0000-000000000001',
      'e0630004-0000-0000-0000-000000000001'
    ]::uuid[],
    format('part3: unaccented pen-name matching must still work and must exclude the unpriced row, got %s', v_ids));

  -- A null search term still means "no term filter".
  select count(*) into v_count from public.search_books(null, null, null, null, 500);
  perform pg_temp.assert(v_count = 4,
    'part3: a null search term must return every published, ALL-priced book');

  -- The candidate clamp is unchanged.
  select count(*) into v_count from public.search_books('P063', null, null, null, 1);
  perform pg_temp.assert(v_count = 1, 'part3: result_limit must still clamp the candidate set');

  -- The genre filter is unchanged and still composes with the new rule.
  select count(*) into v_count
  from public.search_books('P063', 'Nonexistent Genre', null, null, 500);
  perform pg_temp.assert(v_count = 0, 'part3: an unmatched genre filter must still return nothing');
end $$;

-- ============================================================
-- Part 4: the function's own catalog identity is unchanged.
--
-- Signature, PARAMETER NAMES, return shape, language, volatility,
-- SECURITY INVOKER, and search_path. The parameter names matter as much
-- as the types here: PostgREST calls this function by NAMED argument, so
-- renaming `min_price_cents` would break every caller at once -- this
-- patch deliberately keeps the misnomer, and this assertion is what
-- stops a well-meaning later edit from "fixing" it silently.
-- ============================================================
do $$
declare
  v_oid oid;
  v_args text;
  v_result text;
  v_names text;
begin
  select p.oid into v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'search_books';

  perform pg_temp.assert(v_oid is not null, 'part4: exactly one public.search_books must exist');

  perform pg_temp.assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'search_books') = 1,
    'part4: there must be exactly ONE search_books overload');

  select pg_get_function_identity_arguments(v_oid) into v_args;
  perform pg_temp.assert(
    v_args = 'search_term text, genre_filter text, min_price_cents integer, max_price_cents integer, result_limit integer',
    format('part4: identity arguments must be unchanged, got %s', v_args));

  select array_to_string(p.proargnames, ',') into v_names from pg_proc p where p.oid = v_oid;
  perform pg_temp.assert(
    v_names = 'search_term,genre_filter,min_price_cents,max_price_cents,result_limit,book_id',
    format('part4: parameter names (including the deliberately unrenamed price bounds) must be unchanged, got %s', v_names));

  select pg_get_function_result(v_oid) into v_result;
  perform pg_temp.assert(
    v_result = 'TABLE(book_id uuid)',
    format('part4: the return shape must be unchanged, got %s', v_result));

  perform pg_temp.assert(
    (select p.prosecdef from pg_proc p where p.oid = v_oid) = false,
    'part4: search_books must remain SECURITY INVOKER');

  perform pg_temp.assert(
    (select p.provolatile from pg_proc p where p.oid = v_oid) = 's',
    'part4: search_books must remain STABLE');

  perform pg_temp.assert(
    (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = v_oid) = 'sql',
    'part4: search_books must remain a plain SQL function');

  perform pg_temp.assert(
    (select p.proconfig from pg_proc p where p.oid = v_oid) = array['search_path=""'],
    format('part4: search_books must keep its empty search_path, got %s',
      coalesce((select array_to_string(p.proconfig, '|') from pg_proc p where p.oid = v_oid), '<none>')));
end $$;

-- ============================================================
-- Part 5: the body itself. Proves the legacy column is GONE from the
-- price predicates rather than merely shadowed by a new one, and that
-- the null exclusion is present.
--
-- Text assertions on prosrc, not behaviour: a body that kept
-- `books.price_cents >= min_price_cents` alongside a new price_all
-- predicate would pass every behavioural test above (the AND is
-- narrowing) while still reading the legacy column.
-- ============================================================
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'search_books';

  perform pg_temp.assert(
    v_src like '%books.price_all is not null%',
    'part5: the body must exclude rows with no authored ALL price');
  perform pg_temp.assert(
    v_src like '%books.price_all >= min_price_cents%',
    'part5: the minimum bound must compare against price_all');
  perform pg_temp.assert(
    v_src like '%books.price_all <= max_price_cents%',
    'part5: the maximum bound must compare against price_all');

  -- The executable text, comments stripped, must not mention the legacy
  -- column at all. Stripping comments first is load-bearing: this file's
  -- own body explains WHY price_cents is not consulted, and a naive
  -- `not like '%price_cents%'` would fail on that explanation.
  perform pg_temp.assert(
    regexp_replace(v_src, '--[^\n]*', '', 'g') not like '%books.price_cents%',
    'part5: no executable line of the body may read books.price_cents');
end $$;

-- ============================================================
-- Part 6: effective privileges are exactly what they were.
--
-- `create or replace` preserves an existing ACL, and this migration
-- restates no grant -- so this is the assertion that turns "it should
-- have been preserved" into "it was".
-- ============================================================
do $$
declare
  v_acl text;
  v_owner text;
begin
  select coalesce(array_to_string(p.proacl::text[], ','), '<default>') into v_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'search_books';

  perform pg_temp.assert(
    v_acl like '%anon=X/%' and v_acl like '%authenticated=X/%',
    format('part6: anon and authenticated must both retain EXECUTE, got %s', v_acl));

  perform pg_temp.assert(
    v_acl not like '%=X/%,=X/%' and v_acl not like '=X/%',
    format('part6: EXECUTE must not be held by PUBLIC, got %s', v_acl));

  select r.rolname into v_owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public' and p.proname = 'search_books';
  perform pg_temp.assert(
    v_owner = current_user,
    format('part6: the function owner must be the building role, got %s', v_owner));
end $$;

-- ============================================================
-- Part 7: no business row was modified by loading this function.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select count(*) from public.books where author_id = 'e0630000-0000-0000-0000-000000000001') = 6,
    'part7: the fixture rows must be untouched');
  perform pg_temp.assert(
    (select count(*) from public.books where price_all is null
       and author_id = 'e0630000-0000-0000-0000-000000000001') = 1,
    'part7: the unpriced fixture must still be unpriced -- nothing backfills price_all');
  perform pg_temp.assert(
    (select price_cents from public.books
       where id = 'e0630005-0000-0000-0000-000000000001') = 25000,
    'part7: the legacy price_cents column must be left exactly as it was');
end $$;

-- ============================================================
-- Part 8: the suite is not vacuous.
--
-- Pins the number of assertions that actually executed. Raised as a
-- WARNING so a passing run prints one visible line rather than nothing
-- at all -- silence is what a suite that never ran also looks like.
-- ============================================================
do $$
declare
  v_n integer;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n <> 32 then
    raise exception 'FAIL: part8: expected 32 assertions to have executed, got %', v_n;
  end if;
  raise warning 'ALL-SEARCH-1 (063): % assertions executed and passed', v_n;
end $$;

rollback;
