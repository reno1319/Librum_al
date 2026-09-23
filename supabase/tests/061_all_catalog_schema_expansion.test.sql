-- Committed SQL regression suite for ALL-CATALOG-1
-- (supabase/migrations/20260921153012_all_catalog_schema_expansion.sql):
-- the additive, ALL-only catalog price and discount fields
-- `public.books.price_all`, `public.bundles.price_all` and
-- `public.discount_codes.amount_off_all`, and the three-way
-- exactly-one-discount-type constraint that replaces the anonymous
-- two-column exclusive-or.
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
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/061_all_catalog_schema_expansion.test.sql
--
-- It must also pass against the OTHER build path -- base schema.sql plus
-- the migration -- and
-- supabase/tests/061_all_catalog_schema_expansion_catalog_equivalence.sh
-- is what proves those two paths agree in the first place.
--
-- Everything below runs inside one transaction and is rolled back at the
-- end, so the file is repeatable with no manual cleanup. Part 8 reads
-- committed privilege state, the same discipline 037's and 057's suites
-- already use.
--
-- WHAT THIS SUITE IS FOR, stated plainly. Every assertion here is about
-- a value that must be UNREPRESENTABLE, not merely unwritten by today's
-- application. A price of 50 ALL is not "an input the form rejects"; it
-- is a row that could never be charged, because a paid checkout's final
-- price is at least 99.00 ALL, and a catalog that can hold one has a
-- book that is neither free nor sellable. The database is where that is
-- settled, because the database is the one layer every writer goes
-- through.

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs a statement that MUST be rejected, and requires it to be rejected
-- by a NAMED constraint -- not merely to fail.
--
-- Asserting the constraint name rather than "something raised" is the
-- whole point: a statement can fail for a null violation, a foreign key,
-- a typo in a column name, or a wholly unrelated CHECK, and a test that
-- only asks "did it raise?" reports a pass for every one of those. Each
-- call below therefore names the exact constraint that is supposed to be
-- doing the work, so a mutation that removes one branch and leaves
-- another to catch the row by accident still fails this suite.
create function pg_temp.assert_rejected(p_sql text, p_constraint text, p_message text)
  returns void language plpgsql as $$
declare
  v_constraint text;
begin
  begin
    execute p_sql;
  exception
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from p_constraint then
        raise exception 'FAIL: % -- rejected by constraint %, expected %',
          p_message, coalesce(v_constraint, '<none reported>'), p_constraint;
      end if;
      return;
  end;
  -- Reached only when the statement was ACCEPTED. A plain `raise
  -- exception` is SQLSTATE P0001, never check_violation, so it can never
  -- be swallowed by the handler above.
  raise exception 'FAIL: % -- the statement was ACCEPTED', p_message;
end;
$$;

-- ============================================================
-- Part 0: fixtures.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0610000-0000-0000-0000-000000000001', 'p061-author@test', now(), '{"role":"author","display_name":"P061 Author"}');

-- Inserted WITHOUT naming any new column, on purpose: Part 7 reads these
-- same rows back to prove the new columns default to null rather than to
-- a value.
insert into public.books (id, author_id, title, price_cents, status) values
  ('e0610001-0000-0000-0000-000000000001', 'e0610000-0000-0000-0000-000000000001', 'P061 Legacy Book', 799, 'draft');

insert into public.bundles (id, author_id, title, price_cents, status) values
  ('e0610002-0000-0000-0000-000000000001', 'e0610000-0000-0000-0000-000000000001', 'P061 Legacy Bundle', 1499, 'draft');

-- ============================================================
-- Part 1: column shape -- nullable integer, NO default, NO identity, NO
-- generated expression, appended in the position `add column` produces.
--
-- A default is the single most dangerous thing that could be added here
-- by accident: it would write a value into every row that has no
-- authored ALL price, which is exactly the inference ROADMAP.md's
-- decision record forbids. An identity or generated column would do the
-- same by another route.
-- ============================================================
do $$
declare
  v record;
  v_expected text[][] := array[
    array['books', 'price_all', 'updated_at'],
    array['bundles', 'price_all', 'updated_at'],
    array['discount_codes', 'amount_off_all', 'created_at']
  ];
  v_i integer;
  v_table text;
  v_column text;
  v_predecessor text;
  v_predecessor_attnum smallint;
begin
  for v_i in 1 .. array_length(v_expected, 1) loop
    v_table := v_expected[v_i][1];
    v_column := v_expected[v_i][2];
    v_predecessor := v_expected[v_i][3];

    select a.attnum, a.atttypid, a.atttypmod, a.attnotnull, a.atthasdef,
           a.attidentity, a.attgenerated
      into v
      from pg_catalog.pg_attribute a
     where a.attrelid = ('public.' || v_table)::regclass
       and a.attname = v_column
       and not a.attisdropped;

    perform pg_temp.assert(v is not null,
      format('part1: public.%I.%I does not exist', v_table, v_column));
    perform pg_temp.assert(v.atttypid = 'integer'::regtype,
      format('part1: public.%I.%I must be integer', v_table, v_column));
    perform pg_temp.assert(v.atttypmod = -1,
      format('part1: public.%I.%I must be plain integer with no typmod', v_table, v_column));
    perform pg_temp.assert(v.attnotnull = false,
      format('part1: public.%I.%I must be NULLABLE -- existing rows carry no authored ALL price', v_table, v_column));
    perform pg_temp.assert(v.atthasdef = false,
      format('part1: public.%I.%I must have NO DEFAULT -- a default writes an inferred price into every existing row', v_table, v_column));
    perform pg_temp.assert(v.attidentity = '',
      format('part1: public.%I.%I must not be an identity column', v_table, v_column));
    perform pg_temp.assert(v.attgenerated = '',
      format('part1: public.%I.%I must not be a generated column', v_table, v_column));

    -- No pg_attrdef row at all, independently of atthasdef.
    perform pg_temp.assert(
      not exists (select 1 from pg_catalog.pg_attrdef d
                   where d.adrelid = ('public.' || v_table)::regclass
                     and d.adnum = v.attnum),
      format('part1: public.%I.%I must have no pg_attrdef entry', v_table, v_column));

    -- Physical position. `add column` appends; schema.sql declares the
    -- column inline. The two build paths agree only if the declaration
    -- sits directly after the column that was last in the base table.
    -- Stated as "directly after <predecessor>" rather than "last", so a
    -- legitimate later migration that appends a further column does not
    -- turn this into a false failure.
    select a.attnum into v_predecessor_attnum
      from pg_catalog.pg_attribute a
     where a.attrelid = ('public.' || v_table)::regclass
       and a.attname = v_predecessor
       and not a.attisdropped;

    perform pg_temp.assert(v.attnum = v_predecessor_attnum + 1,
      format('part1: public.%I.%I must sit directly after %I (attnum %s), found attnum %s',
             v_table, v_column, v_predecessor, v_predecessor_attnum + 1, v.attnum));
  end loop;
end $$;

-- ============================================================
-- Part 2: constraint names and definitions, exactly.
--
-- Exact definition text, not "a constraint exists": this is the
-- assertion that catches a migration and a schema.sql that both look
-- right in isolation and disagree with each other -- the drift the
-- companion equivalence harness exists to rule out, asserted here too so
-- a single build path still carries the evidence.
-- ============================================================
do $$
declare
  v_expected text[][] := array[
    array['books', 'books_price_all_range_check',
          'CHECK (((price_all IS NULL) OR (price_all = 0) OR ((price_all >= 99) AND (price_all <= 100000))))'],
    array['bundles', 'bundles_price_all_range_check',
          'CHECK (((price_all IS NULL) OR (price_all = 0) OR ((price_all >= 99) AND (price_all <= 100000))))'],
    array['discount_codes', 'discount_codes_amount_off_all_range_check',
          'CHECK (((amount_off_all IS NULL) OR ((amount_off_all >= 1) AND (amount_off_all <= 100000))))'],
    array['discount_codes', 'discount_codes_exactly_one_discount_type_check',
          'CHECK ((num_nonnulls(percent_off, amount_off_cents, amount_off_all) = 1))']
  ];
  v_i integer;
  v_def text;
  v_validated boolean;
begin
  for v_i in 1 .. array_length(v_expected, 1) loop
    select pg_catalog.pg_get_constraintdef(con.oid), con.convalidated
      into v_def, v_validated
      from pg_catalog.pg_constraint con
     where con.conrelid = ('public.' || v_expected[v_i][1])::regclass
       and con.conname = v_expected[v_i][2]
       and con.contype = 'c';

    perform pg_temp.assert(v_def is not null,
      format('part2: public.%I has no CHECK constraint named %I', v_expected[v_i][1], v_expected[v_i][2]));
    perform pg_temp.assert(v_def = v_expected[v_i][3],
      format('part2: public.%I.%I is %s, expected %s', v_expected[v_i][1], v_expected[v_i][2], v_def, v_expected[v_i][3]));
    -- A NOT VALID constraint has the same definition and a different
    -- meaning: it admits every row that already exists.
    perform pg_temp.assert(v_validated,
      format('part2: public.%I.%I must be VALIDATED, not NOT VALID', v_expected[v_i][1], v_expected[v_i][2]));
  end loop;

  -- The constraint the migration replaced must be GONE. Leaving it in
  -- place would keep demanding one of the two LEGACY discount columns,
  -- making an ALL-only discount code unrepresentable -- and the failure
  -- would look like "the new constraint works" from every other angle.
  perform pg_temp.assert(
    not exists (select 1 from pg_catalog.pg_constraint
                 where conrelid = 'public.discount_codes'::regclass
                   and conname = 'discount_codes_check'),
    'part2: the anonymous two-column discount exclusive-or discount_codes_check must no longer exist');

  -- And no OTHER anonymous table-level CHECK crept onto discount_codes
  -- in its place: an anonymous one is auto-named from declaration order,
  -- which the two build paths do not share.
  perform pg_temp.assert(
    not exists (select 1 from pg_catalog.pg_constraint
                 where conrelid = 'public.discount_codes'::regclass
                   and contype = 'c'
                   and conname ~ '^discount_codes_check[0-9]*$'),
    'part2: discount_codes must carry no auto-named table-level CHECK');
end $$;

-- ============================================================
-- Part 3: books.price_all -- the accepted domain, and everything
-- outside it.
-- ============================================================
do $$
declare
  v_price integer;
begin
  -- Accepted: null (already inserted in Part 0), 0, 99, 100000.
  foreach v_price in array array[0, 99, 100000] loop
    insert into public.books (author_id, title, price_all)
      values ('e0610000-0000-0000-0000-000000000001', format('P061 accept %s', v_price), v_price);
  end loop;

  perform pg_temp.assert(
    (select count(*) from public.books
      where author_id = 'e0610000-0000-0000-0000-000000000001' and price_all in (0, 99, 100000)) = 3,
    'part3: 0, 99 and 100000 must all be accepted as books.price_all');
end $$;

-- Explicit null is accepted, not merely an omitted column.
insert into public.books (author_id, title, price_all)
  values ('e0610000-0000-0000-0000-000000000001', 'P061 accept explicit null', null);

do $$
declare
  v_price integer;
begin
  -- The whole forbidden band, every value, not a sample. 1..98 can never
  -- be charged: a paid checkout's final price is at least 99.00 ALL, so
  -- such a row is neither free nor sellable. Testing all 98 rather than
  -- the two endpoints is what catches an off-by-one introduced anywhere
  -- inside the band rather than only at its edges.
  for v_price in 1 .. 98 loop
    perform pg_temp.assert_rejected(
      format('insert into public.books (author_id, title, price_all) values (%L, %L, %s)',
             'e0610000-0000-0000-0000-000000000001', format('P061 reject %s', v_price), v_price),
      'books_price_all_range_check',
      format('part3: books.price_all = %s is below the 99 ALL paid floor and must be rejected', v_price));
  end loop;

  -- Negative, just above the ceiling, and far outside in both
  -- directions.
  foreach v_price in array array[-2147483648, -100000, -1, 100001, 100002, 2147483647] loop
    perform pg_temp.assert_rejected(
      format('insert into public.books (author_id, title, price_all) values (%L, %L, %s)',
             'e0610000-0000-0000-0000-000000000001', format('P061 reject %s', v_price), v_price),
      'books_price_all_range_check',
      format('part3: books.price_all = %s is outside the valid domain and must be rejected', v_price));
  end loop;

  -- The constraint must also hold on UPDATE, not only on INSERT.
  perform pg_temp.assert_rejected(
    format('update public.books set price_all = 50 where id = %L', 'e0610001-0000-0000-0000-000000000001'),
    'books_price_all_range_check',
    'part3: an UPDATE into the forbidden band must be rejected too');
end $$;

-- ============================================================
-- Part 4: bundles.price_all -- the same domain, asserted
-- independently. Two constraints that happen to share a definition are
-- still two constraints, and a patch can get one right and the other
-- wrong.
-- ============================================================
do $$
declare
  v_price integer;
begin
  foreach v_price in array array[0, 99, 100000] loop
    insert into public.bundles (author_id, title, price_all)
      values ('e0610000-0000-0000-0000-000000000001', format('P061 bundle accept %s', v_price), v_price);
  end loop;

  perform pg_temp.assert(
    (select count(*) from public.bundles
      where author_id = 'e0610000-0000-0000-0000-000000000001' and price_all in (0, 99, 100000)) = 3,
    'part4: 0, 99 and 100000 must all be accepted as bundles.price_all');

  insert into public.bundles (author_id, title, price_all)
    values ('e0610000-0000-0000-0000-000000000001', 'P061 bundle accept explicit null', null);

  for v_price in 1 .. 98 loop
    perform pg_temp.assert_rejected(
      format('insert into public.bundles (author_id, title, price_all) values (%L, %L, %s)',
             'e0610000-0000-0000-0000-000000000001', format('P061 bundle reject %s', v_price), v_price),
      'bundles_price_all_range_check',
      format('part4: bundles.price_all = %s is below the 99 ALL paid floor and must be rejected', v_price));
  end loop;

  foreach v_price in array array[-2147483648, -1, 100001, 2147483647] loop
    perform pg_temp.assert_rejected(
      format('insert into public.bundles (author_id, title, price_all) values (%L, %L, %s)',
             'e0610000-0000-0000-0000-000000000001', format('P061 bundle reject %s', v_price), v_price),
      'bundles_price_all_range_check',
      format('part4: bundles.price_all = %s is outside the valid domain and must be rejected', v_price));
  end loop;

  perform pg_temp.assert_rejected(
    format('update public.bundles set price_all = 98 where id = %L', 'e0610002-0000-0000-0000-000000000001'),
    'bundles_price_all_range_check',
    'part4: an UPDATE into the forbidden band must be rejected too');
end $$;

-- ============================================================
-- Part 5: discount_codes.amount_off_all -- the fixed-ALL discount
-- domain.
--
-- The lower bound is 1, not 0, and that is a product invariant rather
-- than a convention: a zero fixed discount is a code that does nothing,
-- indistinguishable at checkout from a code that failed to apply, and a
-- discount may never be the mechanism that makes a paid book free.
-- ============================================================
do $$
declare
  v_amount integer;
begin
  foreach v_amount in array array[1, 99, 100, 100000] loop
    insert into public.discount_codes (author_id, book_id, code, amount_off_all)
      values ('e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001',
              format('P061-ALL-OK-%s', v_amount), v_amount);
  end loop;

  perform pg_temp.assert(
    (select count(*) from public.discount_codes
      where book_id = 'e0610001-0000-0000-0000-000000000001' and amount_off_all is not null) = 4,
    'part5: 1, 99, 100 and 100000 must all be accepted as amount_off_all');

  foreach v_amount in array array[0, -1, -100000, 100001, 2147483647] loop
    perform pg_temp.assert_rejected(
      format('insert into public.discount_codes (author_id, book_id, code, amount_off_all) values (%L, %L, %L, %s)',
             'e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001',
             format('P061-ALL-BAD-%s', v_amount), v_amount),
      'discount_codes_amount_off_all_range_check',
      format('part5: amount_off_all = %s is outside the valid domain and must be rejected', v_amount));
  end loop;
end $$;

-- ============================================================
-- Part 6: exactly one discount type, over three columns.
--
-- Legacy rows of BOTH surviving shapes must remain insertable -- this
-- migration expands the catalog, it does not narrow what already exists
-- -- and every way of naming more than one type, or none, must be
-- rejected by the one named constraint.
-- ============================================================
insert into public.discount_codes (author_id, book_id, code, percent_off) values
  ('e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001', 'P061-LEGACY-PCT', 10);

insert into public.discount_codes (author_id, book_id, code, amount_off_cents) values
  ('e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001', 'P061-LEGACY-CENTS', 500);

do $$
begin
  perform pg_temp.assert(
    (select count(*) from public.discount_codes
      where code in ('P061-LEGACY-PCT', 'P061-LEGACY-CENTS')) = 2,
    'part6: legacy percentage and legacy fixed-cent discount rows must both remain valid');

  -- None of the three.
  perform pg_temp.assert_rejected(
    format('insert into public.discount_codes (author_id, book_id, code) values (%L, %L, %L)',
           'e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001', 'P061-NONE'),
    'discount_codes_exactly_one_discount_type_check',
    'part6: a discount code naming NO discount type must be rejected');

  -- Each pair.
  perform pg_temp.assert_rejected(
    format('insert into public.discount_codes (author_id, book_id, code, percent_off, amount_off_cents) values (%L, %L, %L, 10, 500)',
           'e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001', 'P061-PCT-CENTS'),
    'discount_codes_exactly_one_discount_type_check',
    'part6: percent_off together with amount_off_cents must be rejected');

  perform pg_temp.assert_rejected(
    format('insert into public.discount_codes (author_id, book_id, code, percent_off, amount_off_all) values (%L, %L, %L, 10, 100)',
           'e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001', 'P061-PCT-ALL'),
    'discount_codes_exactly_one_discount_type_check',
    'part6: percent_off together with amount_off_all must be rejected');

  perform pg_temp.assert_rejected(
    format('insert into public.discount_codes (author_id, book_id, code, amount_off_cents, amount_off_all) values (%L, %L, %L, 500, 100)',
           'e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001', 'P061-CENTS-ALL'),
    'discount_codes_exactly_one_discount_type_check',
    'part6: amount_off_cents together with amount_off_all must be rejected');

  -- All three.
  perform pg_temp.assert_rejected(
    format('insert into public.discount_codes (author_id, book_id, code, percent_off, amount_off_cents, amount_off_all) values (%L, %L, %L, 10, 500, 100)',
           'e0610000-0000-0000-0000-000000000001', 'e0610001-0000-0000-0000-000000000001', 'P061-ALL-THREE'),
    'discount_codes_exactly_one_discount_type_check',
    'part6: naming all three discount types must be rejected');

  -- And on UPDATE: adding a second type to a valid single-type row.
  perform pg_temp.assert_rejected(
    format('update public.discount_codes set amount_off_all = 100 where code = %L', 'P061-LEGACY-PCT'),
    'discount_codes_exactly_one_discount_type_check',
    'part6: adding a second discount type by UPDATE must be rejected');

  -- And clearing the only type an existing row has.
  perform pg_temp.assert_rejected(
    format('update public.discount_codes set percent_off = null where code = %L', 'P061-LEGACY-PCT'),
    'discount_codes_exactly_one_discount_type_check',
    'part6: clearing a row''s only discount type must be rejected');
end $$;

-- ============================================================
-- Part 7: rows written without naming the new columns carry NULL.
--
-- This is the mechanical form of "existing rows are not backfilled":
-- with no default and no backfill, a row that does not name the column
-- gets null and nothing else. The migration-over-populated-data proof --
-- rows that existed BEFORE the migration ran -- is in the companion
-- harness, which can build a base database, populate it and then apply
-- the migration; a suite that runs against an already-built schema
-- cannot.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select price_all from public.books where id = 'e0610001-0000-0000-0000-000000000001') is null,
    'part7: a book inserted without naming price_all must have null price_all');
  perform pg_temp.assert(
    (select price_cents from public.books where id = 'e0610001-0000-0000-0000-000000000001') = 799,
    'part7: the legacy price_cents value must be untouched');
  perform pg_temp.assert(
    (select price_all from public.bundles where id = 'e0610002-0000-0000-0000-000000000001') is null,
    'part7: a bundle inserted without naming price_all must have null price_all');
  perform pg_temp.assert(
    (select price_cents from public.bundles where id = 'e0610002-0000-0000-0000-000000000001') = 1499,
    'part7: the legacy bundles.price_cents value must be untouched');
  perform pg_temp.assert(
    (select amount_off_all from public.discount_codes where code = 'P061-LEGACY-PCT') is null,
    'part7: a legacy percentage code must have null amount_off_all');
  perform pg_temp.assert(
    (select amount_off_cents from public.discount_codes where code = 'P061-LEGACY-CENTS') = 500,
    'part7: the legacy amount_off_cents value must be untouched');
end $$;

-- ============================================================
-- Part 8: RLS, policies, ownership and privileges are UNCHANGED.
--
-- An additive column change has no business touching any of these, which
-- is exactly why it is worth asserting: the failure mode is silent. A
-- column added under a table whose RLS was switched off, or whose
-- discount grants widened to anon, is a data-exposure change that every
-- assertion above would pass over.
-- ============================================================
do $$
declare
  v_table text;
  v_owner oid;
  v_profiles_owner oid;
begin
  select relowner into v_profiles_owner from pg_catalog.pg_class where oid = 'public.profiles'::regclass;

  foreach v_table in array array['books', 'bundles', 'discount_codes'] loop
    perform pg_temp.assert(
      (select relrowsecurity from pg_catalog.pg_class where oid = ('public.' || v_table)::regclass),
      format('part8: row level security must still be ENABLED on public.%I', v_table));
    perform pg_temp.assert(
      (select relforcerowsecurity from pg_catalog.pg_class where oid = ('public.' || v_table)::regclass) = false,
      format('part8: FORCE row level security must still be off on public.%I', v_table));

    -- Ownership is asserted relative to an untouched table rather than
    -- against a literal role name, which differs between a local
    -- disposable instance and a real Supabase project.
    select relowner into v_owner from pg_catalog.pg_class where oid = ('public.' || v_table)::regclass;
    perform pg_temp.assert(v_owner = v_profiles_owner,
      format('part8: public.%I must still be owned by the same role as public.profiles', v_table));

    -- No ACL was attached to the new column itself. A column-level grant
    -- here would be a privilege this change never asked for.
    -- ALL-DISCOUNT-3 (migration 20260923112502) later granted
    -- authenticated a column-level INSERT on discount_codes.amount_off_all
    -- on purpose; 064_all_discount_codes_acl.test.sql pins that exact
    -- column ACL, so this check now covers price_all only.
    perform pg_temp.assert(
      not exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = ('public.' || v_table)::regclass
                     and a.attname = 'price_all'
                     and a.attacl is not null),
      format('part8: the new column on public.%I must carry no column-level ACL', v_table));
  end loop;
end $$;

do $$
declare
  v_actual text;
begin
  -- Table privileges, per grantee, exactly. books and bundles carry the
  -- ambient Supabase grants; discount_codes is deliberately NARROWER --
  -- anon has nothing at all, and authenticated has no UPDATE. That
  -- asymmetry is the invariant worth pinning: it is the kind of thing a
  -- careless `grant all on all tables` in a later migration erases
  -- without any error.
  select string_agg(grantee || ':' || privs, ' | ' order by grantee)
    into v_actual
    from (
      select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'books'
         and grantee in ('anon', 'authenticated', 'service_role')
       group by grantee
    ) s;
  perform pg_temp.assert(v_actual =
    'anon:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
    || ' | authenticated:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
    || ' | service_role:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part8: public.books table privileges changed -- found %s', v_actual));

  select string_agg(grantee || ':' || privs, ' | ' order by grantee)
    into v_actual
    from (
      select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'bundles'
         and grantee in ('anon', 'authenticated', 'service_role')
       group by grantee
    ) s;
  perform pg_temp.assert(v_actual =
    'anon:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
    || ' | authenticated:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
    || ' | service_role:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part8: public.bundles table privileges changed -- found %s', v_actual));

  select string_agg(grantee || ':' || privs, ' | ' order by grantee)
    into v_actual
    from (
      select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'discount_codes'
         and grantee in ('anon', 'authenticated', 'service_role')
       group by grantee
    ) s;
  -- ALL-DISCOUNT-3: authenticated's INSERT is column-level since
  -- migration 20260923112502, so it no longer appears at table level.
  perform pg_temp.assert(v_actual =
    'authenticated:DELETE,SELECT'
    || ' | service_role:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part8: public.discount_codes table privileges changed -- anon must have NONE and authenticated no UPDATE -- found %s', v_actual));
end $$;

do $$
declare
  v_actual text;
begin
  -- Every policy on the three tables, by name and command. A policy
  -- dropped or added by an "additive" schema change is a visibility
  -- change.
  select string_agg(tablename || '/' || policyname || '/' || cmd, ' | ' order by tablename, policyname)
    into v_actual
    from pg_catalog.pg_policies
   where schemaname = 'public' and tablename in ('books', 'bundles', 'discount_codes');

  perform pg_temp.assert(v_actual = (
      'books/Authors can delete their own books/DELETE'
      || ' | books/Authors can insert their own books/INSERT'
      || ' | books/Authors can update their own books/UPDATE'
      || ' | books/Owners can view books they''ve acquired/SELECT'
      || ' | books/Published books are viewable by everyone, drafts by their autho/SELECT'
      || ' | bundles/Authors can delete their own bundles/DELETE'
      || ' | bundles/Authors can insert their own bundles/INSERT'
      || ' | bundles/Authors can update their own bundles/UPDATE'
      || ' | bundles/Published bundles are viewable by everyone, drafts by their aut/SELECT'
      || ' | discount_codes/Authors can create discount codes for their own books/INSERT'
      || ' | discount_codes/Authors can delete their own discount codes/DELETE'
      || ' | discount_codes/Authors can update their own discount codes/UPDATE'
      || ' | discount_codes/Authors can view their own discount codes/SELECT'),
    format('part8: the policy set on books/bundles/discount_codes changed -- found %s', v_actual));
end $$;

rollback;
