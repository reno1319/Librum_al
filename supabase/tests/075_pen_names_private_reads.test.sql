-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for PEN-NAMES-2
-- (supabase/migrations/20261019222500_pen_names_private_reads.sql, the
-- expand, and 20261019222600_pen_names_private_reads_contract.sql, the
-- contract): readers and signed-out visitors never learn the account
-- behind a pen name through the data API.
--
--   Part 1  privileges: anon has no SELECT on books, series, bundles or
--           reviews; authenticated no INSERT on books; author_follows
--           and public_author_profiles are gone; blog_posts.created_by
--           is hidden; every view's exact column list and options; every
--           new function closed to PUBLIC and anon.
--   Part 2  the books-INSERT error oracle (MF1) is closed; 2b the same
--           for bundles (audit PEN-2 r1 F1).
--   Part 3  row tests: own rows only on the base tables; the views;
--           13a staff (MF2); support display names (MF3, MF-A); the
--           author-only policies left on base tables (MF4); [23b].
--   Part 4  invariant: no account column readable for other users' rows
--           outside an explicit allowlist (O13, MF-C).
--   Part 5  storage policies.
--   Part 6  checks and unique indexes.
--   Part 7  books_enforce_pen_name exists with its column list (MF7) and
--           still checks the caller's own rows.
--   Part 8  search_books.
--   Part 9  reviews: the upsert, public_reviews' reviewer name (22a).
--
-- The guard, the old-code window after the expand and the catalog
-- equivalence are in 075_pen_names_private_reads_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/075_pen_names_private_reads.test.sql
--
-- It must also pass against the base schema.sql plus both migrations.
-- Against the base schema alone it fails at once (no public_books).
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

create function pg_temp.cols(p_rel text) returns text
  language sql stable as $$
  select string_agg(attname, ',' order by attnum)
    from pg_catalog.pg_attribute
   where attrelid = p_rel::regclass and attnum > 0 and not attisdropped;
$$;

create function pg_temp.dflt(p_author uuid) returns uuid
  language sql stable as $$
  select id from public.pen_names where author_id = p_author and is_default;
$$;

-- ============================================================
-- Part 0: fixtures.
--   A  author 'P075 Ana' (default pen name and 'P075 Owl'): published,
--      draft and unpublished-but-bought books, a series, two bundles
--   B  author 'P075 Ben' (one book; reviews A's book)
--   C  author 'P075 Cy' (no series)
--   R  reader who bought A's books, has a bundle snapshot and a refund
--   M  moderator, U support, E editor
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0750000-0000-4000-8000-00000000000a', 'p075-a@test', now(), '{"role":"author","display_name":"P075 Ana Real"}'),
  ('e0750000-0000-4000-8000-00000000000b', 'p075-b@test', now(), '{"role":"author","display_name":"P075 Ben"}'),
  ('e0750000-0000-4000-8000-00000000000c', 'p075-c@test', now(), '{"role":"author","display_name":"P075 Cy"}'),
  ('e0750000-0000-4000-8000-0000000000aa', 'p075-r@test', now(), '{"role":"reader","display_name":"P075 Reader"}'),
  ('e0750000-0000-4000-8000-0000000000dd', 'p075-m@test', now(), '{"role":"reader","display_name":"P075 Moderator"}'),
  ('e0750000-0000-4000-8000-0000000000ee', 'p075-u@test', now(), '{"role":"reader","display_name":"P075 Support"}'),
  ('e0750000-0000-4000-8000-0000000000ef', 'p075-e@test', now(), '{"role":"reader","display_name":"P075 Editor"}');

insert into public.staff_members (user_id, role) values
  ('e0750000-0000-4000-8000-0000000000dd', 'moderator'),
  ('e0750000-0000-4000-8000-0000000000ee', 'support'),
  ('e0750000-0000-4000-8000-0000000000ef', 'editor');

insert into public.pen_names (id, author_id, name) values
  ('e0750002-0000-4000-8000-000000000001', 'e0750000-0000-4000-8000-00000000000a', 'P075 Owl');

insert into public.series (id, author_id, title) values
  ('e0750003-0000-4000-8000-000000000001', 'e0750000-0000-4000-8000-00000000000a', 'P075 Series');

insert into public.books (id, author_id, title, status, price_all, published_at, pen_name_id, series_id, cover_path, file_path) values
  ('e0750001-0000-4000-8000-0000000000a1', 'e0750000-0000-4000-8000-00000000000a', 'P075 Plain', 'published', 199, now(), null,
   'e0750003-0000-4000-8000-000000000001', 'e075c0de-0000-4000-8000-0000000000a1/cover.jpg', 'e0750000-0000-4000-8000-00000000000a/e0750001-0000-4000-8000-0000000000a1.epub'),
  ('e0750001-0000-4000-8000-0000000000a2', 'e0750000-0000-4000-8000-00000000000a', 'P075 Hoot', 'published', 199, now(), 'e0750002-0000-4000-8000-000000000001',
   null, null, null),
  ('e0750001-0000-4000-8000-0000000000a3', 'e0750000-0000-4000-8000-00000000000a', 'P075 Draft', 'draft', 199, null, null, null, null, null),
  ('e0750001-0000-4000-8000-0000000000a4', 'e0750000-0000-4000-8000-00000000000a', 'P075 Gone', 'draft', 199, null, null, null, null, null),
  ('e0750001-0000-4000-8000-0000000000b1', 'e0750000-0000-4000-8000-00000000000b', 'P075 Ben Book', 'published', 199, now(), null, null, null, null);

insert into public.bundles (id, author_id, title, status, price_all) values
  ('e0750004-0000-4000-8000-000000000001', 'e0750000-0000-4000-8000-00000000000a', 'P075 Bundle', 'published', 299),
  ('e0750004-0000-4000-8000-000000000002', 'e0750000-0000-4000-8000-00000000000a', 'P075 Draft Bundle', 'draft', 299);
insert into public.bundle_books (bundle_id, book_id) values
  ('e0750004-0000-4000-8000-000000000001', 'e0750001-0000-4000-8000-0000000000a1');

insert into public.book_contributors (book_id, name, role) values
  ('e0750001-0000-4000-8000-0000000000a1', 'P075 Illustrator', 'Illustrator');

-- R bought a1 and a4 (a4 since unpublished); B bought a1.
insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0750001-0000-4000-8000-0000000000a1', 'e0750000-0000-4000-8000-0000000000aa', 'cs_p075_1', 0),
  ('e0750001-0000-4000-8000-0000000000a4', 'e0750000-0000-4000-8000-0000000000aa', 'cs_p075_2', 0),
  ('e0750001-0000-4000-8000-0000000000a1', 'e0750000-0000-4000-8000-00000000000b', 'cs_p075_3', 0);

insert into public.reviews (book_id, reader_id, rating, body) values
  ('e0750001-0000-4000-8000-0000000000a1', 'e0750000-0000-4000-8000-0000000000aa', 5, 'R review'),
  ('e0750001-0000-4000-8000-0000000000a1', 'e0750000-0000-4000-8000-00000000000b', 4, 'B review');

insert into public.bundle_checkout_snapshots
  (id, bundle_id, bundle_title, author_id, reader_id, bundle_price_cents_at_checkout, items, protection_expires_at, fulfilled_at) values
  ('e0750005-0000-4000-8000-000000000001', 'e0750004-0000-4000-8000-000000000001', 'P075 Bundle',
   'e0750000-0000-4000-8000-00000000000a', 'e0750000-0000-4000-8000-0000000000aa', 299, '[]', now(), now());

insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status, reviewed_by, reviewed_at) values
  ('e0750006-0000-4000-8000-000000000001', 'e0750000-0000-4000-8000-0000000000aa', 'pi_p075_1', 100, 'rejected',
   'e0750000-0000-4000-8000-0000000000dd', now());
insert into public.refund_request_items (refund_request_id, purchase_id, book_id, amount_cents)
select 'e0750006-0000-4000-8000-000000000001', p.id, p.book_id, 100
  from public.purchases p where p.stripe_checkout_session_id = 'cs_p075_1';

insert into public.blog_posts (title, slug, excerpt, content_markdown, category, status, created_by) values
  ('P075 post', 'p075-post', 'x', 'x', 'publishing', 'published', 'e0750000-0000-4000-8000-0000000000ef');

-- ============================================================
-- Part 1: privileges.
-- ============================================================
do $$
declare
  v_rel text;
begin
  foreach v_rel in array array['books', 'series', 'bundles', 'reviews'] loop
    perform pg_temp.assert(not has_table_privilege('anon', 'public.' || v_rel, 'SELECT')
      and not exists (select 1 from pg_catalog.pg_attribute a
                       where a.attrelid = ('public.' || v_rel)::regclass and a.attnum > 0 and not a.attisdropped
                         and has_column_privilege('anon', ('public.' || v_rel)::regclass, a.attnum, 'SELECT')),
      format('part1: anon has no SELECT on %s (table or any column)', v_rel));
  end loop;

  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.books', 'INSERT')
    and not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.books'::regclass and a.attnum > 0 and not a.attisdropped
                       and has_column_privilege('authenticated', 'public.books'::regclass, a.attnum, 'INSERT')),
    'part1: authenticated has no INSERT on books (table or any column; MF1)');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.bundles', 'INSERT')
    and not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.bundles'::regclass and a.attnum > 0 and not a.attisdropped
                       and has_column_privilege('authenticated', 'public.bundles'::regclass, a.attnum, 'INSERT')),
    'part1: authenticated has no INSERT on bundles (table or any column; audit PEN-2 r1 F1)');
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.books', 'SELECT, DELETE')
    and has_column_privilege('authenticated', 'public.books', 'series_id', 'UPDATE')
    and has_column_privilege('authenticated', 'public.books', 'series_position', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.books', 'title', 'UPDATE'),
    'part1: authenticated keeps select, delete and update (series_id, series_position) on books');

  perform pg_temp.assert(to_regclass('public.author_follows') is null
    and to_regclass('public.public_author_profiles') is null
    and to_regprocedure('public.author_follows_mirror_pen_name_follows()') is null,
    'part1: author_follows, its mirror function and public_author_profiles are gone (C5, C6)');

  perform pg_temp.assert(not has_column_privilege('anon', 'public.blog_posts', 'created_by', 'SELECT')
    and not has_column_privilege('authenticated', 'public.blog_posts', 'created_by', 'SELECT')
    and has_column_privilege('anon', 'public.blog_posts', 'title', 'SELECT'),
    'part1: blog_posts.created_by is not readable; other columns are (E2)');

  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'bio', 'UPDATE')
    and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE')
    and has_column_privilege('authenticated', 'public.profiles', 'public_author_name', 'UPDATE'),
    'part1: profiles UPDATE is (display_name, public_author_name) only (E3)');

  -- series: reset-and-regrant (C2)
  perform pg_temp.assert(not has_table_privilege('anon', 'public.series', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    and not has_table_privilege('authenticated', 'public.series', 'UPDATE, TRUNCATE, REFERENCES, TRIGGER')
    and has_table_privilege('authenticated', 'public.series', 'SELECT, DELETE')
    and has_column_privilege('authenticated', 'public.series', 'pen_name_id', 'INSERT')
    and not has_column_privilege('authenticated', 'public.series', 'id', 'INSERT'),
    'part1: series grants are select, delete and insert (author_id, title, pen_name_id) for authenticated only');

  -- reviews (C3) and book_contributors (C4, O14)
  perform pg_temp.assert(not has_table_privilege('anon', 'public.reviews', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    and has_table_privilege('authenticated', 'public.reviews', 'SELECT, INSERT')
    and not has_table_privilege('authenticated', 'public.reviews', 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
    and has_column_privilege('authenticated', 'public.reviews', 'body', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.reviews', 'created_at', 'UPDATE')
    and not exists (select 1 from pg_catalog.pg_policies where tablename = 'reviews' and cmd = 'DELETE'),
    'part1: reviews grants fit the upsert; no delete (C3, O7)');
  perform pg_temp.assert(has_table_privilege('anon', 'public.book_contributors', 'SELECT')
    and not has_table_privilege('anon', 'public.book_contributors', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    and has_table_privilege('authenticated', 'public.book_contributors', 'SELECT, INSERT, DELETE')
    and not has_table_privilege('authenticated', 'public.book_contributors', 'UPDATE, TRUNCATE, REFERENCES, TRIGGER')
    and not has_table_privilege('anon', 'public.book_views', 'SELECT'),
    'part1: book_contributors and book_views grants (C4, O14)');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.bundle_checkout_snapshots', 'SELECT'),
    'part1: [23b] authenticated has no SELECT on bundle_checkout_snapshots');
  -- C7 + [23b]: neither snapshot SELECT policy survives, so a later grant
  -- alone could not reopen the base table to buyers or sellers.
  perform pg_temp.assert(
    not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'bundle_checkout_snapshots' and cmd in ('SELECT', 'ALL')),
    'part1: no SELECT policy is left on bundle_checkout_snapshots (C7, [23b])');

  -- exact view columns and options
  perform pg_temp.assert(pg_temp.cols('public.public_books') =
    'id,title,subtitle,description,preview_text,keywords,isbn,language,publisher,edition,original_publication_date,genre,series_id,series_position,price_cents,cover_path,status,published_at,created_at,updated_at,price_all,librum_choice_at,pen_name_id',
    'part1: public_books columns (no author_id, file_path, pen_name)');
  perform pg_temp.assert(pg_temp.cols('public.public_series') = 'id,title,pen_name_id,created_at', 'part1: public_series columns');
  perform pg_temp.assert(pg_temp.cols('public.public_bundles') =
    'id,title,description,price_cents,status,created_at,updated_at,price_all,pen_name_id', 'part1: public_bundles columns');
  perform pg_temp.assert(pg_temp.cols('public.public_reviews') = 'id,book_id,rating,body,created_at,reviewer_name',
    'part1: public_reviews columns (no reader_id)');
  perform pg_temp.assert(pg_temp.cols('public.reader_bundle_purchases') =
    'id,stripe_checkout_session_id,stripe_payment_intent_id,bundle_id,bundle_title,reader_id,bundle_price_cents_at_checkout,total_amount_cents,items,protection_expires_at,fulfilled_at,refunded_at,created_at,regime,currency,royalty_rate_bps',
    'part1: reader_bundle_purchases columns (no author_id)');
  perform pg_temp.assert(pg_temp.cols('public.reader_refund_requests') =
    'id,reader_id,stripe_payment_intent_id,bundle_checkout_snapshot_id,amount_cents,reason,status,requested_at,reviewed_at,admin_notes,refunded_at,created_at',
    'part1: reader_refund_requests columns (no reviewed_by)');
  perform pg_temp.assert(pg_temp.cols('public.author_book_purchases') =
    'id,book_id,stripe_checkout_session_id,stripe_payment_intent_id,amount_cents,discount_code_id,bundle_id,refunded_at,created_at,regime,payment_id',
    'part1: [23b] author_book_purchases columns (no reader_id)');
  perform pg_temp.assert(pg_temp.cols('public.author_bundle_sales') =
    'id,stripe_checkout_session_id,stripe_payment_intent_id,bundle_id,bundle_title,author_id,bundle_price_cents_at_checkout,total_amount_cents,items,protection_expires_at,fulfilled_at,refunded_at,created_at,regime,currency,royalty_rate_bps',
    'part1: [23b] author_bundle_sales columns (no reader_id)');

  foreach v_rel in array array['public_books', 'public_bundles', 'public_reviews', 'reader_bundle_purchases',
                               'reader_refund_requests', 'author_book_purchases', 'author_bundle_sales'] loop
    perform pg_temp.assert((select reloptions from pg_catalog.pg_class where oid = ('public.' || v_rel)::regclass) = '{security_barrier=true}'
      and (select relowner::regrole::text from pg_catalog.pg_class where oid = ('public.' || v_rel)::regclass) = 'postgres',
      format('part1: %s is a security_barrier definer view owned by postgres (O1)', v_rel));
  end loop;

  foreach v_rel in array array['public_books', 'public_series', 'public_bundles', 'public_reviews'] loop
    perform pg_temp.assert(has_table_privilege('anon', 'public.' || v_rel, 'SELECT')
      and has_table_privilege('authenticated', 'public.' || v_rel, 'SELECT')
      and not has_table_privilege('anon', 'public.' || v_rel, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      and not has_table_privilege('authenticated', 'public.' || v_rel, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      format('part1: %s is SELECT-only for anon and authenticated', v_rel));
  end loop;
  foreach v_rel in array array['reader_bundle_purchases', 'reader_refund_requests', 'author_book_purchases', 'author_bundle_sales'] loop
    perform pg_temp.assert(not has_table_privilege('anon', 'public.' || v_rel, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      and has_table_privilege('authenticated', 'public.' || v_rel, 'SELECT')
      and not has_table_privilege('authenticated', 'public.' || v_rel, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      format('part1: %s is SELECT-only for authenticated, nothing for anon', v_rel));
  end loop;

  -- every new function: no EXECUTE for PUBLIC or anon (O9)
  perform pg_temp.assert(not has_function_privilege('public', 'public.staff_profile_display_names(uuid[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.staff_profile_display_names(uuid[])', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.staff_profile_display_names(uuid[])', 'EXECUTE')
    and (select prosecdef and proconfig = array['search_path=""'] from pg_catalog.pg_proc
          where oid = 'public.staff_profile_display_names(uuid[])'::regprocedure),
    'part1: staff_profile_display_names is definer, empty search_path, authenticated only (E6, O9)');
end $$;

-- ============================================================
-- Part 2: the books-INSERT oracle (MF1). As authenticated B, every X gives
-- the same SQLSTATE and message.
-- ============================================================
do $$
declare
  s uuid := 'e0750003-0000-4000-8000-000000000001';  -- A's series, A's default pen name
  v_rand text;
  v_reader text;
  v_owner text;
  v_other text;
begin
  v_rand := pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-00000000000b',
    format($q$insert into public.books (author_id, title, series_id) values (%L, 't', %L)$q$, gen_random_uuid(), s));
  v_reader := pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-00000000000b',
    format($q$insert into public.books (author_id, title, series_id) values (%L, 't', %L)$q$, 'e0750000-0000-4000-8000-0000000000aa', s));
  v_owner := pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-00000000000b',
    format($q$insert into public.books (author_id, title, series_id) values (%L, 't', %L)$q$, 'e0750000-0000-4000-8000-00000000000a', s));
  v_other := pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-00000000000b',
    format($q$insert into public.books (author_id, title, series_id) values (%L, 't', %L)$q$, 'e0750000-0000-4000-8000-00000000000c', s));
  perform pg_temp.assert(v_rand = v_reader and v_reader = v_owner and v_owner = v_other and v_rand like '42501:%',
    format('part2: books INSERT gives one answer for every X (MF1) -- %s / %s / %s / %s', v_rand, v_reader, v_owner, v_other));
end $$;

-- Part 2b (audit PEN-2 r1 F1): the bundles-INSERT oracle. As authenticated
-- B, inserting bundles(author_id = X) used to give RLS's 42501 for an
-- author and LB454 for a reader or no account. Now every X gives the same
-- answer (the ACL), and with the grant put back inside this rolled-back
-- transaction the trigger's r5 guard still leaves only RLS's answer.
do $$
declare
  v_x text[] := array[gen_random_uuid()::text,
                      'e0750000-0000-4000-8000-0000000000aa',   -- a reader
                      'e0750000-0000-4000-8000-00000000000a',   -- an author with two pen names
                      'e0750000-0000-4000-8000-00000000000c'];  -- an author with one
  v_out text[];
  x text;
begin
  v_out := array[]::text[];
  foreach x in array v_x loop
    v_out := v_out || pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-00000000000b',
      format($q$insert into public.bundles (author_id, title) values (%L, 't')$q$, x));
  end loop;
  perform pg_temp.assert((select count(distinct o) from unnest(v_out) o) = 1 and v_out[1] like '42501:permission denied%',
    format('part2b: bundles INSERT gives one answer for every X (F1) -- %s', array_to_string(v_out, ' / ')));

  grant insert (author_id, title) on public.bundles to authenticated;
  v_out := array[]::text[];
  foreach x in array v_x loop
    v_out := v_out || pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-00000000000b',
      format($q$insert into public.bundles (author_id, title) values (%L, 't')$q$, x));
  end loop;
  revoke insert on public.bundles from authenticated;
  perform pg_temp.assert((select count(distinct o) from unnest(v_out) o) = 1 and v_out[1] like '42501:%row-level security%',
    format('part2b: with a bundles INSERT grant, the trigger guard still leaves one RLS answer for every X (F1) -- %s', array_to_string(v_out, ' / ')));
end $$;

-- ============================================================
-- Part 3: rows.
-- ============================================================
do $$
declare
  a text := 'e0750000-0000-4000-8000-00000000000a';
  b text := 'e0750000-0000-4000-8000-00000000000b';
  r text := 'e0750000-0000-4000-8000-0000000000aa';
  m text := 'e0750000-0000-4000-8000-0000000000dd';
  u text := 'e0750000-0000-4000-8000-0000000000ee';
  v text;
  i integer;
  v_ids uuid[];
begin
  -- B cannot read A's base rows
  perform pg_temp.assert(pg_temp.run_as('authenticated', b, format('select * from public.books where author_id = %L', a)) = 'OK:0',
    'part3: B reads none of A''s books rows');
  perform pg_temp.assert(pg_temp.run_as('authenticated', b, format('select * from public.series where author_id = %L', a)) = 'OK:0',
    'part3: B reads none of A''s series rows');
  perform pg_temp.assert(pg_temp.run_as('authenticated', b, format('select * from public.bundles where author_id = %L', a)) = 'OK:0',
    'part3: B reads none of A''s bundles rows');
  perform pg_temp.assert(pg_temp.run_as('authenticated', b, 'select * from public.reviews') = 'OK:1',
    'part3: B reads only its own review row');
  perform pg_temp.assert(pg_temp.run_as('authenticated', r, 'select * from public.bundle_checkout_snapshots') like '42501:%',
    'part3: the buyer cannot read the base bundle snapshot (author_id; C7, [23b])');
  perform pg_temp.assert(pg_temp.run_as('authenticated', r, 'select reviewed_by from public.refund_requests') = 'OK:0',
    'part3: the reader cannot read reviewed_by on the base refund table (C7b, O3)');
  perform pg_temp.assert(pg_temp.run_as('anon', null, 'select * from public.reviews') like '42501:%'
    and pg_temp.run_as('anon', null, 'select * from public.books') like '42501:%'
    and pg_temp.run_as('anon', null, 'select * from public.series') like '42501:%',
    'part3: anon is refused on base books, series and reviews');

  -- B reads through the views
  perform pg_temp.assert(pg_temp.run_as('authenticated', b, 'select * from public.public_books where id::text like ''e0750001-%''') = 'OK:3',
    'part3: B sees the published books (A x2, B x1) through public_books');
  perform pg_temp.assert(pg_temp.run_as('anon', null, 'select * from public.public_books where id::text like ''e0750001-%''') = 'OK:3'
    and pg_temp.run_as('anon', null, 'select * from public.public_series where id::text like ''e0750003-%''') = 'OK:1'
    and pg_temp.run_as('anon', null, 'select * from public.public_bundles where id::text like ''e0750004-%''') = 'OK:1'
    and pg_temp.run_as('anon', null, 'select * from public.public_reviews where book_id::text like ''e0750001-%''') = 'OK:2',
    'part3: anon reads published books, every series, published bundles and their reviews through the views');

  -- A sees own drafts
  perform pg_temp.assert(pg_temp.run_as('authenticated', a, format('select * from public.books where author_id = %L', a)) = 'OK:4'
    and pg_temp.run_as('authenticated', a, 'select * from public.public_books where id::text like ''e0750001-%-0000000000a_''') = 'OK:4'
    and pg_temp.run_as('authenticated', a, 'select * from public.public_bundles where id::text like ''e0750004-%''') = 'OK:2'
    and pg_temp.run_as('authenticated', a, format('select * from public.series where author_id = %L', a)) = 'OK:1',
    'part3: A sees its own drafts (base rows and views) and its own series');

  -- the buyer sees an unpublished acquired book only through public_books
  perform pg_temp.assert(pg_temp.run_as('authenticated', r, 'select * from public.books where id = ''e0750001-0000-4000-8000-0000000000a4''') = 'OK:0'
    and pg_temp.run_as('authenticated', r, 'select * from public.public_books where id = ''e0750001-0000-4000-8000-0000000000a4''') = 'OK:1'
    and pg_temp.run_as('authenticated', b, 'select * from public.public_books where id = ''e0750001-0000-4000-8000-0000000000a4''') = 'OK:0',
    'part3: an unpublished acquired book is visible to its buyer through public_books only');
  perform pg_temp.assert(pg_temp.run_as('authenticated', r, 'select * from public.reader_bundle_purchases') = 'OK:1'
    and pg_temp.run_as('authenticated', b, 'select * from public.reader_bundle_purchases') = 'OK:0'
    and pg_temp.run_as('authenticated', r, 'select * from public.reader_refund_requests') = 'OK:1'
    and pg_temp.run_as('authenticated', b, 'select * from public.reader_refund_requests') = 'OK:0'
    and pg_temp.run_as('authenticated', r, 'select * from public.refund_request_items') = 'OK:1'
    and pg_temp.run_as('authenticated', b, 'select * from public.refund_request_items') = 'OK:0',
    'part3: readers read their own bundle snapshot, refund requests and refund items through the reader views (O-a)');

  -- 13a (MF2)
  perform pg_temp.assert(pg_temp.value_as('authenticated', m,
      'select author_id::text from public.books where id = ''e0750001-0000-4000-8000-0000000000a3''') = a,
    'part3: a moderator (reports.resolve) reads another author''s draft book row with its account (MF2)');
  perform pg_temp.assert(pg_temp.run_as('authenticated', u, 'select * from public.books') = 'OK:0',
    'part3: a support user reads no books row (MF2)');

  -- MF3, MF-A
  perform pg_temp.assert(pg_temp.run_as('authenticated', u, format('select * from public.profiles where id <> %L', u)) = 'OK:0',
    'part3: a support user reads no other profile row (C13)');
  perform pg_temp.assert(pg_temp.run_as('authenticated', m, format('select * from public.profiles where id = %L', a)) = 'OK:1',
    'part3: a moderator (reports.view) still reads profiles');
  perform pg_temp.assert(pg_temp.value_as('authenticated', u,
      format('select string_agg(id::text || ''='' || display_name, '','' order by display_name) from public.staff_profile_display_names(array[%L, %L, %L, %L]::uuid[])', r, m, u, a))
      = m || '=P075 Moderator,' || r || '=P075 Reader,' || u || '=P075 Support',
    'part3: staff_profile_display_names returns refund readers, reviewers and staff; never the unrelated author A');
  perform pg_temp.assert(pg_temp.value_as('authenticated', u,
      'select string_agg(attname, '','') from pg_catalog.pg_attribute where attrelid = (select prorettype from pg_catalog.pg_proc where proname = ''staff_profile_display_names'')') is not distinct from null
    and pg_get_function_result('public.staff_profile_display_names(uuid[])'::regprocedure) = 'TABLE(id uuid, display_name text)',
    'part3: staff_profile_display_names returns id and display_name only');
  perform pg_temp.assert(pg_temp.run_as('authenticated', a, format('select * from public.staff_profile_display_names(array[%L]::uuid[])', r)) = 'P0001:not authorized'
    and pg_temp.run_as('authenticated', m, format('select * from public.staff_profile_display_names(array[%L]::uuid[])', r)) = 'P0001:not authorized',
    'part3: staff_profile_display_names refuses without refunds.view');
  perform pg_temp.assert(pg_temp.run_as('authenticated', u, 'select * from public.staff_profile_display_names(null)') = 'OK:0'
    and pg_temp.run_as('authenticated', u, 'select * from public.staff_profile_display_names(array[]::uuid[])') = 'OK:0',
    'part3: null or empty input returns no rows');
  -- 250 refund readers in one call (MF-A: no cap)
  for i in 1..250 loop
    v_ids := v_ids || format('e075a000-0000-4000-8000-%s', lpad(i::text, 12, '0'))::uuid;
  end loop;
  insert into auth.users (id, email, raw_user_meta_data)
  select x, x::text || '@p075.test', '{"role":"reader","display_name":"P075 Many"}' from unnest(v_ids) x;
  insert into public.refund_requests (reader_id, stripe_payment_intent_id, amount_cents)
  select x, 'pi_' || x::text, 100 from unnest(v_ids) x;
  perform pg_temp.assert(pg_temp.run_as('authenticated', u,
      format('select * from public.staff_profile_display_names(%L::uuid[])', v_ids)) = 'OK:250',
    'part3: staff_profile_display_names returns names for 250 refund readers in one call (MF-A)');

  -- MF4: author-only policies on base tables still work as their author
  perform pg_temp.assert(pg_temp.run_as('authenticated', a,
      $q$insert into public.discount_codes (author_id, book_id, code, percent_off) values ('e0750000-0000-4000-8000-00000000000a', 'e0750001-0000-4000-8000-0000000000a1', 'P075OFF', 10)$q$) = 'OK:1'
    and pg_temp.run_as('authenticated', a, 'select * from public.discount_codes where code = ''P075OFF''') = 'OK:1',
    'part3: discount code policies work as the author (MF4)');
  perform pg_temp.assert(pg_temp.run_as('authenticated', a,
      $q$insert into public.book_contributors (book_id, name, role) values ('e0750001-0000-4000-8000-0000000000a3', 'P075 Translator', 'Translator')$q$) = 'OK:1'
    and pg_temp.run_as('authenticated', a, 'select * from public.book_contributors where name = ''P075 Translator''') = 'OK:1'
    and pg_temp.run_as('authenticated', a, 'delete from public.book_contributors where name = ''P075 Translator''') = 'OK:1'
    and pg_temp.run_as('authenticated', b,
      $q$insert into public.book_contributors (book_id, name, role) values ('e0750001-0000-4000-8000-0000000000a3', 'P075 Bad', 'Translator')$q$) like '42501:%',
    'part3: contributor write policies work as the author and refuse others (MF4)');
  insert into public.book_views (book_id) values ('e0750001-0000-4000-8000-0000000000a1');
  perform pg_temp.assert(pg_temp.run_as('authenticated', a, 'select * from public.book_views') = 'OK:1'
    and pg_temp.run_as('authenticated', b, 'select * from public.book_views') = 'OK:0',
    'part3: book_views counts are visible to their author only (MF4)');
  perform pg_temp.assert(pg_temp.run_as('authenticated', a, 'select * from public.bundle_books where bundle_id::text like ''e0750004-%''') = 'OK:1',
    'part3: bundle contents are visible to their author (MF4)');
  perform pg_temp.assert(pg_temp.run_as('anon', null, 'select * from public.book_contributors where book_id::text like ''e0750001-%''') = 'OK:1'
    and pg_temp.run_as('anon', null, 'select * from public.bundle_books where bundle_id::text like ''e0750004-%''') = 'OK:1',
    'part3: anon reads contributors and bundle contents of public books without error (MF4)');

  -- [23b]
  perform pg_temp.assert(pg_temp.run_as('authenticated', a, 'select * from public.author_book_purchases') = 'OK:3'
    and pg_temp.value_as('authenticated', a, 'select count(*)::text from public.author_book_purchases where book_id = ''e0750001-0000-4000-8000-0000000000a1''') = '2'
    and pg_temp.run_as('authenticated', a, 'select * from public.author_bundle_sales') = 'OK:1'
    and pg_temp.run_as('authenticated', b, 'select * from public.author_bundle_sales') = 'OK:0',
    'part3: [23b] the author reads its own sales and counts through the views (deleteBook/deleteAccount count these)');
  -- audit PEN-2 r1 F2: the row rule, not just the column list.
  perform pg_temp.assert(pg_temp.run_as('authenticated', b, 'select * from public.author_book_purchases') = 'OK:0'
    and pg_temp.run_as('authenticated', r, 'select * from public.author_book_purchases') = 'OK:0'
    and pg_temp.run_as('authenticated', r, 'select * from public.author_bundle_sales') = 'OK:0',
    'part3: [23b] another author and a reader read no rows of A''s sales views (F2)');
  perform pg_temp.assert(pg_temp.run_as('authenticated', a, 'select reader_id from public.purchases') = 'OK:0'
    and pg_temp.run_as('authenticated', a, 'select reader_id from public.author_book_purchases') like '42703:%'
    and pg_temp.run_as('authenticated', a, 'select reader_id from public.author_bundle_sales') like '42703:%'
    and pg_temp.run_as('authenticated', a, 'select reader_id from public.bundle_checkout_snapshots') like '42501:%',
    'part3: [23b] the author gets no reader_id from purchases or snapshots');
  perform pg_temp.assert(pg_temp.run_as('authenticated', r, 'select * from public.purchases') = 'OK:2',
    'part3: readers keep their own purchases');
end $$;

-- ============================================================
-- Part 4: invariant. For every relation and set-returning function anon
-- or authenticated can read, no account column is readable for other
-- users' rows outside the allowlist (O13, MF-C).
-- ============================================================
create table pg_temp.allow (rel text, col text, gate text, reason text);
insert into pg_temp.allow values
  -- own-row tables (every SELECT policy is auth.uid() = col, or staff-gated below)
  ('books', 'author_id', 'own+staff', 'authors read own rows; reports.resolve staff every row (13a, MF2)'),
  ('series', 'author_id', 'own', 'authors read own rows'),
  ('bundles', 'author_id', 'own', 'authors read own rows'),
  ('reviews', 'reader_id', 'own', 'readers read own reviews (upsert)'),
  ('purchases', 'reader_id', 'own', 'readers read own purchases'),
  ('wishlist_items', 'reader_id', 'own', 'own wishlist'),
  ('pen_name_follows', 'follower_id', 'own', 'own follows'),
  ('discount_codes', 'author_id', 'own', 'own codes'),
  ('author_payout_destinations', 'author_id', 'own', 'own payout destination'),
  ('author_payout_settings', 'author_id', 'own', 'own payout settings'),
  ('book_rights_declarations', 'author_id', 'own', 'own rights declarations'),
  ('pen_names', 'author_id', 'own+staff', 'own pen names; reports.resolve staff (13a)'),
  ('staff_members', 'user_id', 'own+staff', 'own staff row; staff.view'),
  ('staff_members', 'created_by', 'own+staff', 'own staff row; staff.view'),
  ('profiles', 'id', 'own+staff', 'own profile; reports.view, staff.view, audit.view (C13)'),
  -- staff-gated (owner, admin, moderator only; asserted below)
  ('book_reports', 'reporter_id', 'staff', 'reports.view'),
  ('book_reports', 'reviewed_by', 'staff', 'reports.view'),
  -- ADMIN-2-TAKEDOWN (20261020080000): authors read their own takedown
  -- notices (author_id is in the column grant, so the dashboard filters
  -- to the author's own rows); reports.view staff read every row.
  -- id, report_id and the staff ids are not granted to authenticated.
  ('book_takedowns', 'author_id', 'own+staff', 'authors read own takedowns; reports.view staff'),
  -- ADMIN-3-REVIEW (20261020120000): authors read their own review rows
  -- (author_id is in the column grant); staff read through the service role.
  ('book_reviews', 'author_id', 'own', 'authors read own reviews'),
  ('payments', 'buyer_id', 'staff', 'finance.view'),
  ('author_ledger_entries', 'author_id', 'staff', 'finance.view'),
  ('author_payouts', 'author_id', 'staff', 'finance.view'),
  -- refunds.view (support): buyer and staff ids only; after C13 and E6
  -- they map to no pen name
  ('refund_requests', 'reader_id', 'refunds', 'refunds.view staff; readers use reader_refund_requests'),
  ('refund_requests', 'reviewed_by', 'refunds', 'refunds.view staff'),
  -- definer views filtered to the caller's own rows
  ('reader_bundle_purchases', 'reader_id', 'own-view', 'the reader''s own id'),
  ('reader_refund_requests', 'reader_id', 'own-view', 'the reader''s own id'),
  ('author_bundle_sales', 'author_id', 'own-view', 'the author''s own id');

create table pg_temp.allow_fn (fn text, perm text);
insert into pg_temp.allow_fn values
  ('list_admin_audit_events', 'audit.view'),
  ('list_finance_checkout_exceptions', 'finance.view'),
  ('list_finance_disputes', 'finance.view'),
  ('list_finance_refund_entitlement_mismatches', 'finance.view'),
  ('list_refund_reconciliation_states', 'finance.view'),
  ('list_staff_members', 'staff.view'),
  ('staff_profile_display_names', 'refunds.view');

do $$
declare
  v_pattern text := '(author_id|^reader_id|^follower_id|^created_by|^reviewed_by|^reporter_id|^actor_id|^user_id|^buyer_id)$';
  v_staff_perms text[] := array['reports.view', 'reports.resolve', 'staff.view', 'audit.view',
                                'finance.view', 'finance.payout_export', 'finance.payout_operate'];
  v_role text;
  v_perm text;
  v_bad text;
  rec record;
begin
  -- (a) the staff set: every role holding one of these also holds
  -- reports.resolve (13a), asserted from staff_has_permission itself.
  insert into auth.users (id, email, raw_user_meta_data)
  select ('e075f000-0000-4000-8000-00000000000' || n)::uuid, 'p075-role' || n || '@test', '{"role":"reader","display_name":"P075 Role"}'
    from generate_series(1, 5) n;
  insert into public.staff_members (user_id, role)
  select ('e075f000-0000-4000-8000-00000000000' || n)::uuid, (array['owner','admin','editor','moderator','support'])[n]
    from generate_series(1, 5) n;
  for rec in select sm.user_id, sm.role from public.staff_members sm where sm.user_id::text like 'e075f000-%' loop
    foreach v_perm in array v_staff_perms loop
      if pg_temp.value_as('authenticated', rec.user_id::text, format('select public.staff_has_permission(%L)::text', v_perm)) = 'true' then
        perform pg_temp.assert(pg_temp.value_as('authenticated', rec.user_id::text, 'select public.staff_has_permission(''reports.resolve'')::text') = 'true',
          format('part4: role %s holds %s, so it must hold reports.resolve (13a, MF-C)', rec.role, v_perm));
      end if;
    end loop;
  end loop;

  -- (b) every readable account column is allowlisted
  with rels as (
    select c.oid, c.relname, c.relkind, c.relrowsecurity
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
  ), acct_base as (
    select a.attrelid, a.attnum, a.attname
      from pg_catalog.pg_attribute a
     where a.attnum > 0 and not a.attisdropped
       and (a.attname ~ v_pattern
            or exists (select 1 from pg_catalog.pg_constraint k
                        where k.conrelid = a.attrelid and k.contype = 'f' and a.attnum = any (k.conkey)
                          and k.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass)))
  ), acct as (
    select r.oid as reloid, r.relname, r.relkind, r.relrowsecurity, a.attnum, a.attname
      from rels r join pg_catalog.pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
     where exists (select 1 from acct_base ab where ab.attrelid = a.attrelid and ab.attnum = a.attnum)
        or (r.relname = 'profiles' and a.attname = 'id')
        -- views: a column traced to an account column of a base table,
        -- through the view's own target list (resorigtbl/resorigcol, any
        -- name) or, for a column with no direct origin (an expression),
        -- information_schema.view_column_usage (a used base column of the
        -- same name)
        or (r.relkind = 'v'
            and not exists (
              select 1 from pg_catalog.pg_rewrite w,
                   regexp_matches(w.ev_action::text, ':resname ' || a.attname || ' :ressortgroupref \d+ :resorigtbl ([1-9]\d*) ') m0
               where w.ev_class = r.oid)
            and exists (
              select 1 from information_schema.view_column_usage u
                join pg_catalog.pg_class bc on bc.relname = u.table_name
                join pg_catalog.pg_namespace bn on bn.oid = bc.relnamespace and bn.nspname = u.table_schema
                join acct_base ab on ab.attrelid = bc.oid and ab.attname = u.column_name
               where u.view_schema = 'public' and u.view_name = r.relname and u.column_name = a.attname))
        or (r.relkind = 'v' and exists (
              select 1 from pg_catalog.pg_rewrite w,
                   regexp_matches(w.ev_action::text, ':resname ' || a.attname || ' :ressortgroupref \d+ :resorigtbl (\d+) :resorigcol (\d+)') m
                join acct_base ab on ab.attrelid = m[1]::oid and ab.attnum = m[2]::int2
               where w.ev_class = r.oid))
  )
  select string_agg(format('%s.%s (%s)', acct.relname, acct.attname, role), ', ') into v_bad
    from acct cross join unnest(array['anon', 'authenticated']) role
   where has_column_privilege(role, acct.reloid, acct.attnum, 'SELECT')
     -- a table with RLS and no SELECT policy for the role shows no row
     and not (acct.relkind = 'r' and acct.relrowsecurity and not exists (
               select 1 from pg_catalog.pg_policies p
                where p.schemaname = 'public' and p.tablename = acct.relname and p.cmd in ('SELECT', 'ALL')
                  and p.roles && array['public', role]::name[]))
     and not exists (select 1 from pg_temp.allow al where al.rel = acct.relname and al.col = acct.attname);
  perform pg_temp.assert(v_bad is null, format('part4: account columns readable outside the allowlist: %s', v_bad));

  -- (c) each allowlisted table's SELECT policies match its gate
  for rec in
    select al.rel, al.col, al.gate, p.policyname, p.qual
      from pg_temp.allow al
      join pg_catalog.pg_policies p on p.schemaname = 'public' and p.tablename = al.rel and p.cmd in ('SELECT', 'ALL')
     where al.gate in ('own', 'own+staff', 'staff', 'refunds')
  loop
    if rec.qual ~ ('^\(auth\.uid\(\) = ' || case when rec.rel = 'staff_members' then 'user_id' when rec.rel = 'profiles' then 'id' else rec.col end || '\)$')
       and rec.gate in ('own', 'own+staff') then
      continue;
    end if;
    -- staff-gated: every permission named is in the staff set (or
    -- refunds.view for the refunds entries)
    perform pg_temp.assert(
      rec.qual ~ 'staff_has_permission'
      and not exists (
        select 1 from regexp_matches(rec.qual, 'staff_has_permission\(''([a-z_.]+)''', 'g') mm
         where not (mm[1] = any (v_staff_perms) or (rec.gate = 'refunds' and mm[1] = 'refunds.view')))
      and rec.gate in ('own+staff', 'staff', 'refunds'),
      format('part4: policy "%s" on %s does not match its allowlist gate %s: %s', rec.policyname, rec.rel, rec.gate, rec.qual));
  end loop;

  -- (d) own-row views filter on auth.uid()
  for rec in select al.rel from pg_temp.allow al where al.gate = 'own-view' loop
    perform pg_temp.assert(pg_get_viewdef(('public.' || rec.rel)::regclass) ~ 'auth\.uid\(\)',
      format('part4: %s filters on auth.uid()', rec.rel));
  end loop;

  -- (e) set-returning functions executable by anon or authenticated that
  -- return an account column are gated by an allowlisted permission
  select string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proretset
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     and exists (select 1 from unnest(p.proargnames, p.proargmodes) as x(nm, md)
                  where md = 't' and (nm ~ v_pattern or (p.proname = 'staff_profile_display_names' and nm = 'id')))
     and not exists (select 1 from pg_temp.allow_fn f
                      where f.fn = p.proname
                        and p.prosrc ~ ('staff_has_permission\(''' || replace(f.perm, '.', '\.') || '''\)')
                        and (f.perm = any (v_staff_perms) or f.perm = 'refunds.view'));
  perform pg_temp.assert(v_bad is null, format('part4: set-returning functions returning an account column without an allowlisted gate: %s', v_bad));
  perform pg_temp.assert(not has_function_privilege('anon', 'public.list_staff_members()', 'EXECUTE'),
    'part4: no staff function is open to anon');
end $$;

-- ============================================================
-- Part 5: storage policies (C9).
-- ============================================================
do $$
begin
  perform pg_temp.assert(not exists (select 1 from pg_catalog.pg_policies
                                      where schemaname = 'storage' and tablename = 'objects'
                                        and (coalesce(qual, '') ~ '''(covers|avatars)''' or coalesce(with_check, '') ~ '''(covers|avatars)''')),
    'part5: no policy at all (select or write) on the covers or avatars buckets');
  perform pg_temp.assert((select string_agg(policyname || ':' || qual, ',') from pg_catalog.pg_policies
                           where schemaname = 'storage' and cmd = 'SELECT' and qual ~ '''blog''')
      = 'Staff with blog.manage can read blog images:((bucket_id = ''blog''::text) AND staff_has_permission(''blog.manage''::text))',
    'part5: blog SELECT is staff-only (blog.manage)');
  perform pg_temp.assert((select string_agg(policyname, ',' order by policyname) from pg_catalog.pg_policies
                           where schemaname = 'storage' and (coalesce(qual, '') || coalesce(with_check, '')) ~ '''manuscripts''')
      = 'Authors can delete their own manuscripts,Authors can read their own manuscripts,Authors can replace their own manuscripts,Authors can upload their own manuscripts',
    'part5: manuscripts policies unchanged');
  -- the blog upload path still works for staff and is refused for others
  insert into storage.objects (bucket_id, name) values ('blog', 'p075/one.png');
  perform pg_temp.assert(pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-0000000000ef', 'select * from storage.objects where bucket_id = ''blog''') = 'OK:1'
    and pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-0000000000ef', 'delete from storage.objects where bucket_id = ''blog'' and name = ''p075/one.png''') = 'OK:1'
    and pg_temp.run_as('anon', null, 'select * from storage.objects where bucket_id = ''blog''') = 'OK:0',
    'part5: staff with blog.manage can list and delete blog images; anon lists nothing');
  insert into storage.objects (bucket_id, name) values ('covers', 'e075c0de-0000-4000-8000-0000000000a1/cover.jpg');
  perform pg_temp.assert(pg_temp.run_as('anon', null, 'select * from storage.objects where bucket_id = ''covers''') = 'OK:0'
    and pg_temp.run_as('authenticated', 'e0750000-0000-4000-8000-00000000000a',
          $q$insert into storage.objects (bucket_id, name) values ('covers', 'e0750000-0000-4000-8000-00000000000a/x-cover.png')$q$) like '42501:%',
    'part5: covers cannot be listed or written by users');
end $$;

-- ============================================================
-- Part 6: checks and unique indexes.
-- ============================================================
do $$
declare
  a text := 'e0750000-0000-4000-8000-00000000000a';
begin
  -- ADMIN-3-REVIEW fixture: a live book's cover can no longer change
  -- (LB463), so these CHECK/UNIQUE probes run on the book as a draft; it
  -- is published again below with an approval of its new cover.
  update public.books set status = 'draft' where id = 'e0750001-0000-4000-8000-0000000000a2';
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      $q$update public.books set cover_path = 'e0750000-0000-4000-8000-00000000000a/e0750001-0000-4000-8000-0000000000a2-cover.jpg' where id = 'e0750001-0000-4000-8000-0000000000a2'$q$)
      like '23514:%books_cover_path_check%',
    'part6: an old "<account>/<book>-cover" key is refused (C10)');
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      $q$update public.books set cover_path = 'e075c0de-0000-4000-8000-0000000000a2/cover.jpeg' where id = 'e0750001-0000-4000-8000-0000000000a2'$q$)
      like '23514:%',
    'part6: only .jpg/.png covers');
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      $q$update public.books set cover_path = 'e075c0de-0000-4000-8000-0000000000a1/cover.jpg' where id = 'e0750001-0000-4000-8000-0000000000a2'$q$)
      like '23505:%books_cover_path_key%',
    'part6: two books cannot share a cover key (E7)');
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      $q$update public.books set cover_path = 'e075c0de-0000-4000-8000-0000000000a2/cover.png' where id = 'e0750001-0000-4000-8000-0000000000a2'$q$) = 'OK:1',
    'part6: a new-shape cover key is accepted');
  insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status, grandfathered, decided_at)
  select id, title, author_id, file_path, cover_path, 'approved', true, now() from public.books where id = 'e0750001-0000-4000-8000-0000000000a2';
  update public.books set status = 'published' where id = 'e0750001-0000-4000-8000-0000000000a2';
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      format($q$update public.pen_names set avatar_path = %L where id = %L$q$, a || '/avatar.png', pg_temp.dflt(a::uuid))) like '23514:%pen_names_avatar_path_check%',
    'part6: the account photo key is no longer accepted on a pen name (C8)');
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      format($q$update public.pen_names set avatar_path = 'e075a7a7-0000-4000-8000-000000000001/pen-name.jpg' where id = %L$q$, pg_temp.dflt(a::uuid))) = 'OK:1'
    and pg_temp.run_as('service_role', null,
      $q$update public.pen_names set avatar_path = 'e075a7a7-0000-4000-8000-000000000001/pen-name.jpg' where id = 'e0750002-0000-4000-8000-000000000001'$q$) like '23505:%pen_names_avatar_path_key%',
    'part6: a pen-name photo key is accepted once and cannot be shared (E7)');
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      $q$update public.pen_names set bio = repeat('x', 5001) where id = 'e0750002-0000-4000-8000-000000000001'$q$) like '23514:%pen_names_bio_check%'
    and pg_temp.run_as('service_role', null,
      $q$update public.pen_names set bio = repeat('x', 5000) where id = 'e0750002-0000-4000-8000-000000000001'$q$) = 'OK:1',
    'part6: a pen-name bio is at most 5000 characters (E4)');
  -- C8: the profile trigger no longer copies the photo (it still copies the bio)
  insert into auth.users (id, email, raw_user_meta_data) values
    ('e0750000-0000-4000-8000-0000000000f1', 'p075-f1@test', '{"role":"reader","display_name":"P075 Later"}');
  update public.profiles set bio = 'later bio', avatar_path = 'e0750000-0000-4000-8000-0000000000f1/avatar.jpg'
   where id = 'e0750000-0000-4000-8000-0000000000f1';
  update public.profiles set role = 'author', public_author_name = 'P075 Later' where id = 'e0750000-0000-4000-8000-0000000000f1';
  perform pg_temp.assert((select bio = 'later bio' and avatar_path is null from public.pen_names
                           where author_id = 'e0750000-0000-4000-8000-0000000000f1' and is_default),
    'part6: becoming an author copies the bio but not the photo (C8; the app copies the photo)');
end $$;

-- ============================================================
-- Part 7: books_enforce_pen_name (MF7, C11).
-- ============================================================
do $$
declare
  a text := 'e0750000-0000-4000-8000-00000000000a';
begin
  perform pg_temp.assert((select pg_get_triggerdef(t.oid) from pg_catalog.pg_trigger t
                           where t.tgrelid = 'public.books'::regclass and t.tgname = 'books_enforce_pen_name')
      = 'CREATE TRIGGER books_enforce_pen_name BEFORE INSERT OR UPDATE OF pen_name_id, author_id, series_id ON public.books FOR EACH ROW EXECUTE FUNCTION books_enforce_pen_name()',
    'part7: books_enforce_pen_name exists with the column list (pen_name_id, author_id, series_id)');
  perform pg_temp.assert(not exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.books'::regclass and attname = 'pen_name' and not attisdropped)
    and pg_catalog.pg_get_functiondef('public.books_enforce_pen_name()'::regprocedure) !~ '(new|old)\.pen_name[^_]'
    and pg_catalog.pg_get_functiondef('public.pen_names_after_update()'::regprocedure) !~ 'public\.books',
    'part7: books.pen_name and its text sync are gone');
  perform pg_temp.assert(pg_catalog.pg_get_functiondef('public.books_enforce_pen_name()'::regprocedure)
      ~ 'current_setting\(''role''\) in \(''anon'', ''authenticated''\)\s+and new\.author_id is distinct from auth\.uid\(\)',
    'part7: the data-API guard is in place');
  -- own rows are still checked (service_role writes)
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      format($q$insert into public.books (author_id, title, pen_name_id) values (%L, 'x', %L)$q$, a, pg_temp.dflt('e0750000-0000-4000-8000-00000000000b'::uuid)))
      like '42501:pen names: the pen name does not belong%',
    'part7: a pen name of another account is refused');
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      $q$update public.books set pen_name_id = 'e0750002-0000-4000-8000-000000000001' where id = 'e0750001-0000-4000-8000-0000000000a1'$q$) like 'LB452:%',
    'part7: 14a still holds');
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      $q$update public.books set series_id = 'e0750003-0000-4000-8000-000000000001' where id = 'e0750001-0000-4000-8000-0000000000a2'$q$) like 'LB451:%',
    'part7: 11a still holds');
  perform pg_temp.assert(pg_temp.run_as('service_role', null,
      format($q$insert into public.books (id, author_id, title) values ('e0750001-0000-4000-8000-0000000000a9', %L, 'x')$q$, a)) = 'OK:1',
    'part7: service_role inserts a book without pen_name_id');
  perform pg_temp.assert((select pen_name_id from public.books where id = 'e0750001-0000-4000-8000-0000000000a9') = pg_temp.dflt(a::uuid),
    'part7: a book without pen_name_id still gets the default');
  -- the author's own series unlink (deleteSeries) still works
  perform pg_temp.assert(pg_temp.run_as('authenticated', a,
      $q$update public.books set series_id = null, series_position = null where series_id = 'e0750003-0000-4000-8000-000000000001' and author_id = 'e0750000-0000-4000-8000-00000000000a'$q$) = 'OK:1',
    'part7: the author unlinks its own books from a series');
end $$;

-- ============================================================
-- Part 8: search_books.
-- ============================================================
do $$
begin
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select string_agg(book_id::text, '','' order by book_id) from public.search_books(''P075'') where book_id::text like ''e0750001-%''')
      = (select string_agg(id::text, ',' order by id) from public.books
          where id::text like 'e0750001-%' and status = 'published' and price_all is not null and title like 'P075%'),
    'part8: anon search gives the published, priced books as before');
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select string_agg(book_id::text, '','') from public.search_books(''P075 Owl'')') = 'e0750001-0000-4000-8000-0000000000a2',
    'part8: pen-name search still finds the book under that pen name only');
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select count(*)::text from public.search_books(''P075 Draft'')') = '0',
    'part8: drafts are never found');
end $$;

-- ============================================================
-- Part 9: reviews (C3, 22a).
-- ============================================================
do $$
declare
  r text := 'e0750000-0000-4000-8000-0000000000aa';
begin
  perform pg_temp.assert(pg_temp.run_as('authenticated', r,
      $q$insert into public.reviews (book_id, reader_id, rating, body) values ('e0750001-0000-4000-8000-0000000000a1', 'e0750000-0000-4000-8000-0000000000aa', 3, 'edited')
         on conflict (book_id, reader_id) do update set rating = excluded.rating, body = excluded.body, book_id = excluded.book_id, reader_id = excluded.reader_id$q$) = 'OK:1',
    'part9: the review upsert runs as the reader');
  perform pg_temp.assert((select body from public.reviews where reader_id = r::uuid) = 'edited',
    'part9: the review upsert updated the reader''s review');
  perform pg_temp.assert(pg_temp.run_as('authenticated', r, 'delete from public.reviews') like '42501:%',
    'part9: no review delete through the API');
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select string_agg(coalesce(reviewer_name, ''<null>'') || ''='' || body, '','' order by body) from public.public_reviews where book_id = ''e0750001-0000-4000-8000-0000000000a1''')
      = 'P075 Ben=B review,<null>=edited',
    'part9: a reviewer who is an author with a book shows their default pen name; a reader shows none (22a)');

  -- audit PEN-2 r1 F3: an author-role account with no book is not named
  -- (20261019154308). C is an author with a default pen name and no book.
  insert into public.reviews (book_id, reader_id, rating, body) values
    ('e0750001-0000-4000-8000-0000000000a1', 'e0750000-0000-4000-8000-00000000000c', 4, 'C review');
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select coalesce(reviewer_name, ''<null>'') from public.public_reviews where body = ''C review''') = '<null>'
    and (select count(*) from public.pen_names where author_id = 'e0750000-0000-4000-8000-00000000000c') = 1
    and (select role from public.profiles where id = 'e0750000-0000-4000-8000-00000000000c') = 'author',
    'part9: an author with a default pen name but no book shows no reviewer name (F3)');
  delete from public.reviews where body = 'C review';
end $$;

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 80,
    format('expected at least 80 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 075_pen_names_private_reads.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
