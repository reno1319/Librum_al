-- Committed SQL regression suite for migration 045
-- (profiles.public_author_name, the widened grant, search_books()'s
-- privacy-preserving author-name match, and -- as of AUTHOR-1C -- the
-- database-level SELECT/RLS boundary and the public_author_profiles
-- view). LIBRUM 2.0 AUTHOR-1A / AUTHOR-1C.
--
-- Not run automatically by any CI/build step in this repo (there is no
-- existing SQL test framework or Postgres-in-CI setup here) -- run it
-- manually against a disposable/local Postgres instance, AFTER applying
-- supabase/schema.sql and every migration through 045, from the repo
-- root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/045_public_author_name.test.sql
--
-- (schema.sql alone is sufficient here -- it is already at exact parity
-- with migration 045, per that migration's own header comment, and this
-- was directly verified during AUTHOR-1C: both [schema.sql alone] and
-- [the pre-AUTHOR-1 baseline + migration 045 alone] were built into
-- separate disposable databases and this exact suite passed identically
-- against both.)
--
-- Every SELECT/RLS assertion in Part 5 was run for real against a local
-- Postgres 16 instance while building AUTHOR-1C, under `set role anon`/
-- `set role authenticated` with `request.jwt.claim.sub` driving
-- auth.uid() -- not merely reasoned about. This is what caught two real
-- bugs a source-only review would have missed entirely: (1) the original
-- draft fix left search_books() querying public.profiles directly, which
-- -- being SECURITY INVOKER -- would have thrown "permission denied for
-- table profiles" for every anon/authenticated search call the moment
-- profiles' own SELECT grant was narrowed, breaking search outright; and
-- (2) exercising search_books() as anon at all requires anon to have
-- USAGE on the `extensions` schema, which schema.sql itself never grants
-- (it relies on the real Supabase platform's own ambient default) -- see
-- 00_stub_supabase_platform.sql's own AUTHOR-1C comment for how the stub
-- now replicates that.
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable against the same database
-- with no manual cleanup between runs.

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- ============================================================
-- Fixtures
-- ============================================================
-- Three authors:
--   - Pseudonymous: display_name (account) differs from
--     public_author_name (pen name) -- the load-bearing privacy case.
--   - Same-name: public_author_name explicitly set equal to display_name
--     (the common "no pen name" case, backfill's own target shape).
--   - Search-fixture: a second pseudonymous author, used only by Part 5's
--     SELECT/RLS/search assertions so they don't disturb Part 1-4's own
--     fixture state.
-- Two readers: one plain, one who will become a moderator with
-- reports.view (Part 5's staff-access case).
--
-- LIBRUM 2.0 AUTHOR-1C: there is no "legacy/unset public_author_name"
-- author fixture any more -- that state (an author profile that exists
-- with public_author_name still null) is now a real, enforced
-- impossibility: handle_new_user() initializes it at signup, and
-- public_author_name_required_for_authors (a CHECK constraint) rejects
-- any attempt to null it back out for an existing author row. Part 1
-- and Part 3 below test THAT invariant directly, replacing the old
-- "legacy author still findable via display_name fallback" coverage,
-- which described a state that can no longer occur.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'pseudonym-author@test', '{"role":"author","display_name":"Renato Kalemi"}'),
  ('22222222-2222-2222-2222-222222222222', 'samename-author@test', '{"role":"author","display_name":"Alma Hoxha"}'),
  ('55555555-5555-5555-5555-555555555555', 'search-author@test', '{"role":"author","display_name":"Search Fixture Author"}'),
  ('44444444-4444-4444-4444-444444444444', 'reader-r1@test', '{"role":"reader","display_name":"Reader R1"}'),
  ('66666666-6666-6666-6666-666666666666', 'reader-r2@test', '{"role":"reader","display_name":"Reader R2 Real Name"}'),
  ('77777777-7777-7777-7777-777777777777', 'moderator@test', '{"role":"reader","display_name":"Moderator Person"}');

update public.profiles set public_author_name = 'Arben Leka'
  where id = '11111111-1111-1111-1111-111111111111';
update public.profiles set public_author_name = 'Alma Hoxha'
  where id = '22222222-2222-2222-2222-222222222222';
update public.profiles set public_author_name = 'Search Pen Name'
  where id = '55555555-5555-5555-5555-555555555555';

insert into public.staff_members (user_id, role) values
  ('77777777-7777-7777-7777-777777777777', 'moderator');

insert into public.books (id, author_id, title, description, keywords, genre, status, price_cents) values
  ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Under a Pen Name', 'A pseudonymous novel.', 'fiction, drama', 'Fiction', 'published', 999),
  ('b0000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Same Name Book', 'No pen name here.', 'nonfiction', 'Non-Fiction', 'published', 500),
  ('b0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Zgjuar mendjen', 'Një libër shqip.', 'edukim', 'Non-Fiction', 'published', 300),
  ('b0000000-0000-0000-0000-000000000005', '55555555-5555-5555-5555-555555555555', 'Search Fixture Book', 'desc', 'kw', 'Fiction', 'published', 100);

-- ============================================================
-- Part 1: schema contract -- additive, length-checked, no uniqueness,
-- backfill scoped to role = 'author' only, and (AUTHOR-1C) NEVER null
-- for an author.
-- ============================================================
do $$
declare
  is_nullable text;
begin
  select c.is_nullable into is_nullable
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'profiles' and c.column_name = 'public_author_name';

  -- The COLUMN itself remains nullable (readers legitimately have it
  -- null forever) -- the NOT-NULL-FOR-AUTHORS rule is enforced by the
  -- separate CHECK constraint asserted in Part 3, not a column-level
  -- NOT NULL, which would incorrectly also forbid it for readers.
  perform pg_temp.assert(is_nullable = 'YES', 'part1: public_author_name column itself must remain nullable (readers keep it null)');

  perform pg_temp.assert(
    not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and tablename = 'profiles' and indexdef ilike '%unique%public_author_name%'
    ),
    'part1: public_author_name must not have a uniqueness constraint/index'
  );

  perform pg_temp.assert(
    (select public_author_name from public.profiles where id = '44444444-4444-4444-4444-444444444444') is null,
    'part1: a reader profile must never have public_author_name populated'
  );

  -- AUTHOR-1C: every author fixture inserted above got public_author_name
  -- auto-initialized at signup by handle_new_user() (before the explicit
  -- UPDATEs above overrode two of them with an intentionally-different
  -- pen name) -- proving the trigger itself, not just the explicit test
  -- fixtures, satisfies the invariant.
  perform pg_temp.assert(
    (select public_author_name from public.profiles where id = '55555555-5555-5555-5555-555555555555') is not null,
    'part1: handle_new_user() must auto-initialize public_author_name for a new author'
  );
end $$;

-- ============================================================
-- Part 2: length CHECK constraint (mirrors the 120-char app-level limit).
-- ============================================================
do $$
begin
  begin
    update public.profiles
    set public_author_name = repeat('x', 121)
    where id = '11111111-1111-1111-1111-111111111111';
    perform pg_temp.assert(false, 'part2: a public_author_name over 120 characters must violate a CHECK constraint');
  exception when check_violation then
    null;
  end;

  -- Exactly 120 characters is valid.
  update public.profiles
  set public_author_name = repeat('x', 120)
  where id = '11111111-1111-1111-1111-111111111111';

  -- Restore the real fixture value for the search tests below.
  update public.profiles set public_author_name = 'Arben Leka'
  where id = '11111111-1111-1111-1111-111111111111';
end $$;

-- ============================================================
-- Part 3: AUTHOR-1C's required-for-authors CHECK constraint --
-- an author's public_author_name can never be nulled back out, whether
-- by trying to null the column directly or by promoting a reader (who
-- legitimately has it null) to 'author' without also setting it.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select count(*) from pg_catalog.pg_constraint where conname = 'public_author_name_required_for_authors') = 1,
    'part3: the public_author_name_required_for_authors constraint must exist'
  );

  begin
    update public.profiles set public_author_name = null
    where id = '11111111-1111-1111-1111-111111111111';
    perform pg_temp.assert(false, 'part3: nulling an existing author''s public_author_name must violate the CHECK constraint');
  exception when check_violation then
    null;
  end;

  begin
    update public.profiles set role = 'author'
    where id = '44444444-4444-4444-4444-444444444444'; -- reader, public_author_name still null
    perform pg_temp.assert(false, 'part3: promoting a reader (null public_author_name) to author must violate the CHECK constraint');
  exception when check_violation then
    null;
  end;
end $$;

-- ============================================================
-- Part 4: search_books() -- the load-bearing privacy invariant.
-- Run as the connecting (superuser/table-owner) role here -- Part 5
-- below re-runs the load-bearing cases AS anon/authenticated, which is
-- what actually exercises this SECURITY INVOKER function's real
-- privilege boundary (see this file's own top-of-file note about the
-- bug that distinction caught).
-- ============================================================
do $$
declare
  matched uuid[];
begin
  -- A: pseudonym matches.
  select array_agg(book_id) into matched from public.search_books('Arben Leka');
  perform pg_temp.assert(
    matched @> array['b0000000-0000-0000-0000-000000000001'::uuid, 'b0000000-0000-0000-0000-000000000004'::uuid],
    'part4A: searching the PUBLIC pen name must match every published book by that author'
  );

  -- B: the private account name must NOT match once a pseudonym is set.
  select array_agg(book_id) into matched from public.search_books('Renato Kalemi');
  perform pg_temp.assert(
    matched is null or not (matched @> array['b0000000-0000-0000-0000-000000000001'::uuid]),
    'part4B: searching the PRIVATE account name must NOT match once public_author_name differs from it -- this is the whole point of AUTHOR-1'
  );

  -- Same-name author: public_author_name explicitly equals display_name
  -- -- must match either way (they're the same string).
  select array_agg(book_id) into matched from public.search_books('Alma Hoxha');
  perform pg_temp.assert(
    matched @> array['b0000000-0000-0000-0000-000000000002'::uuid],
    'part4C: same-name author (public_author_name = display_name) must still be searchable'
  );

  -- D: title/description/keywords matching is unchanged.
  select array_agg(book_id) into matched from public.search_books('pseudonymous');
  perform pg_temp.assert(
    matched @> array['b0000000-0000-0000-0000-000000000001'::uuid],
    'part4D: description-text matching must be unaffected by the author-name clause change'
  );
  select array_agg(book_id) into matched from public.search_books('drama');
  perform pg_temp.assert(
    matched @> array['b0000000-0000-0000-0000-000000000001'::uuid],
    'part4D: keywords matching must be unaffected'
  );

  -- E: genre/price filters unchanged.
  select array_agg(book_id) into matched from public.search_books(null, 'Non-Fiction', null, null);
  perform pg_temp.assert(
    matched @> array['b0000000-0000-0000-0000-000000000002'::uuid, 'b0000000-0000-0000-0000-000000000004'::uuid]
    and not (matched @> array['b0000000-0000-0000-0000-000000000001'::uuid]),
    'part4E: genre_filter must still scope results exactly as before'
  );

  -- F: Albanian unaccent() normalization is unchanged -- an unaccented
  -- query still matches an accented title/description, AND an
  -- unaccented query still matches an accented PUBLIC author name.
  select array_agg(book_id) into matched from public.search_books('Zgjuar');
  perform pg_temp.assert(
    matched @> array['b0000000-0000-0000-0000-000000000004'::uuid],
    'part4F: title unaccent() normalization must be unaffected'
  );
  update public.profiles set public_author_name = 'Ëngjëll Çela' where id = '11111111-1111-1111-1111-111111111111';
  select array_agg(book_id) into matched from public.search_books('Engjell Cela');
  perform pg_temp.assert(
    matched @> array['b0000000-0000-0000-0000-000000000001'::uuid, 'b0000000-0000-0000-0000-000000000004'::uuid],
    'part4F: an unaccented query must still match an accented PUBLIC author name via unaccent()'
  );
  update public.profiles set public_author_name = 'Arben Leka' where id = '11111111-1111-1111-1111-111111111111';
end $$;

-- ============================================================
-- Part 5: AUTHOR-1C -- the database-level SELECT/RLS/grant boundary
-- itself, exercised AS the actual querying role (anon/authenticated),
-- never merely as the connecting superuser/table-owner. This is the
-- part of the suite that actually proves the privacy invariant the
-- AUTHOR-1C audit set out to close.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.profiles', 'SELECT'),
    'part5: anon must have NO SELECT privilege at all on the base profiles table'
  );
  perform pg_temp.assert(
    has_table_privilege('anon', 'public.public_author_profiles', 'SELECT'),
    'part5: anon must still be able to SELECT from the safe public_author_profiles view'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'public_author_profiles' and column_name = 'display_name'
    ),
    'part5: public_author_profiles must not expose display_name as a column at all'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'public_author_profiles'
        and column_name in ('stripe_account_id', 'stripe_payouts_enabled', 'role')
    ),
    'part5: public_author_profiles must not expose role or any Stripe column'
  );
end $$;

-- ANON: can read the pen name via the view, cannot read display_name at
-- all (not merely "the row looks empty" -- the base table is
-- unreachable to it, full stop).
set role anon;
select pg_temp.assert(
  (select public_author_name from public.public_author_profiles where id = '11111111-1111-1111-1111-111111111111') = 'Arben Leka',
  'part5 (anon): must read the pen name via public_author_profiles'
);
reset role;

-- ORDINARY AUTHENTICATED reader (reader-r1): cannot read ANOTHER
-- author's row via the base table at all, but can via the view.
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select pg_temp.assert(
  (select count(*) from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 0,
  'part5 (authenticated, other user): must see ZERO rows for another user via the base table'
);
select pg_temp.assert(
  (select public_author_name from public.public_author_profiles where id = '11111111-1111-1111-1111-111111111111') = 'Arben Leka',
  'part5 (authenticated, other user): must still read the pen name via the view'
);
reset role;

-- SELF: the author can read AND update their own full row, including
-- display_name and public_author_name.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select pg_temp.assert(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'Renato Kalemi',
  'part5 (self): author must be able to read their OWN display_name directly'
);
update public.profiles set public_author_name = 'Temp Pen Name' where id = '11111111-1111-1111-1111-111111111111';
select pg_temp.assert(
  (select public_author_name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'Temp Pen Name',
  'part5 (self): author must be able to update their own public_author_name'
);
update public.profiles set public_author_name = 'Arben Leka' where id = '11111111-1111-1111-1111-111111111111';
reset role;

-- STAFF (moderator, reports.view): CAN read another user's display_name
-- via the base table, for moderation.
set role authenticated;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select pg_temp.assert(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'Renato Kalemi',
  'part5 (staff): a moderator (reports.view) must be able to read another user''s account display_name for moderation'
);
reset role;

-- REVIEWS-SHAPED EMBED: the join pattern used by
-- src/app/(public)/books/[id]/page.tsx's reviewer-identity nested embed
-- -- a pseudonymous author reviewing elsewhere as a reader must resolve
-- to their PEN NAME, never their private display_name; a plain
-- reader-reviewer (no public surface) must resolve to NULL, never their
-- real name.
set role anon;
select pg_temp.assert(
  (
    select p.public_author_name
    from (select '11111111-1111-1111-1111-111111111111'::uuid as reader_id) r
    left join public.public_author_profiles p on p.id = r.reader_id
  ) = 'Arben Leka',
  'part5 (reviews-shaped embed): a pseudonymous author reviewing as a reader must resolve to their pen name, never their real name'
);
select pg_temp.assert(
  (
    select p.public_author_name
    from (select '66666666-6666-6666-6666-666666666666'::uuid as reader_id) r
    left join public.public_author_profiles p on p.id = r.reader_id
  ) is null,
  'part5 (reviews-shaped embed): a plain reader-reviewer must resolve to NULL, never their real display_name'
);
reset role;

-- SEARCH, exercised AS THE ACTUAL CALLING ROLE -- this is what caught
-- the real bug this suite's own top-of-file note describes (the
-- earlier draft still queried public.profiles directly inside
-- search_books(), which is SECURITY INVOKER, and would have thrown a
-- hard permission error here instead of returning results).
set role anon;
select pg_temp.assert(
  exists (select 1 from public.search_books('Search Pen Name')),
  'part5 (anon search): must match the public pen name'
);
select pg_temp.assert(
  not exists (select 1 from public.search_books('Search Fixture Author')),
  'part5 (anon search): must NOT match the private display_name'
);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select pg_temp.assert(
  exists (select 1 from public.search_books('Search Pen Name')),
  'part5 (authenticated search, other user): must match the public pen name'
);
reset role;

-- ============================================================
-- Part 6: grants -- authenticated may update public_author_name; anon
-- may not. Mirrors the same has_column_privilege check style already
-- used for display_name/bio/avatar_path (migration 033's own
-- reasoning), extended to the one new column.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    has_column_privilege('authenticated', 'public.profiles', 'public_author_name', 'UPDATE'),
    'part6: authenticated must have UPDATE on profiles.public_author_name'
  );
  perform pg_temp.assert(
    not has_column_privilege('anon', 'public.profiles', 'public_author_name', 'UPDATE'),
    'part6: anon must not have UPDATE on profiles.public_author_name'
  );
  -- Unchanged columns keep their existing grant -- this migration must
  -- not have narrowed anything beyond profiles' own SELECT policy/grant.
  perform pg_temp.assert(
    has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE'),
    'part6: authenticated must still have UPDATE on profiles.display_name (unchanged by this migration)'
  );
end $$;

select 'ALL PASSED: 045_public_author_name.test.sql' as result;

rollback;
