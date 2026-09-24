-- CATALOG-WRITE-AUTH-1 (Patch 7): database-enforced authorization for the
-- protected catalog columns of public.books and public.bundles.
--
-- ROLLOUT ORDER -- BINDING. Apply this migration ONLY AFTER the Patch 7
-- application is merged and READY on the target environment. The
-- application deployed before Patch 7 writes `status`, `price_all` and
-- `published_at` with the author's own session; once this migration is
-- applied, every one of those writes (publish, unpublish, and every book
-- or bundle edit, because an edit always carries its price) fails with a
-- permission error until the Patch 7 application is live. The Patch 7
-- application performs those writes through the server-only service-role
-- client and works against the ACL both before and after this migration,
-- so deploying the application first leaves no broken window.
--
-- WHY. Until now `authenticated` held table-level INSERT and UPDATE on
-- both tables, and the only RLS check on either was
-- `auth.uid() = author_id`. An author could therefore, straight through
-- the Data API and around every Server Action gate:
--   * INSERT a row that is already `status = 'published'` with a paid
--     `price_all`;
--   * UPDATE their own row's `status`, `price_all` or `published_at`;
-- bypassing PAID_PUBLISHING_MODE and every Patch 6 repricing guard. The
-- database cannot see Vercel's paid-mode variables, so the only sound
-- boundary is privilege: authors lose direct write access to the
-- protected columns, and the Server Actions -- which can see those
-- variables -- write them through the service role after deciding.
--
-- WHAT CHANGES, and nothing else:
--
--   1. Every table privilege of PUBLIC, anon and authenticated on both
--      tables is reset (`revoke all`), and only what the application
--      uses is granted back: SELECT to anon; SELECT and DELETE to
--      authenticated (deleteBook, deleteBundle). So anon and
--      authenticated no longer hold INSERT, UPDATE, TRUNCATE, REFERENCES,
--      TRIGGER or MAINTAIN at table level, and anon no longer holds
--      DELETE. TRUNCATE is a data write that ignores RLS entirely;
--      REFERENCES (a foreign key pointing at these tables, which can then
--      block or probe their rows) and TRIGGER (a trigger on these tables)
--      are security-sensitive capabilities; MAINTAIN (VACUUM, ANALYZE,
--      REINDEX, REFRESH, CLUSTER, LOCK) is an operator privilege. No
--      Librum path uses any of the four. `revoke all` also removes every
--      column-level privilege those roles held, so every column grant
--      below is issued after the reset.
--   2. authenticated gets column-level INSERT on exactly the columns the
--      two create paths name:
--        books:   id, author_id, title, subtitle, description, keywords,
--                 isbn, language, publisher, edition,
--                 original_publication_date, genre, series_id,
--                 series_position, price_all, cover_path, file_path
--                 (createBook in dashboard/books/actions.ts)
--        bundles: author_id, title, description, price_all
--                 (createBundle in dashboard/bundles/actions.ts)
--      `price_all` is insertable because a paid DRAFT is legitimate:
--      publishing it is the protected transition, not pricing it.
--      `status` is NOT insertable, so every author-created row takes the
--      column default, which is and stays exactly 'draft'. Naming
--      `status` at all, even 'draft', is refused. Neither are
--      `price_cents` (legacy USD), `published_at`, `created_at`,
--      `updated_at`, or books.`preview_text` (no create path writes it).
--   3. authenticated gets column-level UPDATE on books.series_id and
--      books.series_position ONLY -- the one direct metadata write that
--      stays on the author's session (deleteSeries unlinking its books).
--      bundles gets no authenticated UPDATE at all: its only writer,
--      updateBundle, carries `price_all` and runs through the trusted
--      server path. Every other metadata edit (updateBook) carries
--      `price_all` in the same atomic row update as its metadata, so it
--      runs through the trusted path too.
--
-- UNCHANGED: the effective SELECT of anon and authenticated and the
-- DELETE of authenticated, re-granted in item 1; every privilege of
-- service_role and of the table owner; RLS stays enabled with every
-- policy unchanged, including the
-- insert/update `with check (auth.uid() = author_id)`; the `status`
-- default; every existing row. This migration issues no DML.
--
-- The declarative equivalent is in supabase/schema.sql, next to each
-- table's policies; 066_catalog_write_authorization_catalog_equivalence.sh
-- proves the two build paths produce the same catalog, and
-- 066_catalog_write_authorization.test.sql proves the behaviour.

revoke all on public.books from public, anon, authenticated;
grant select on public.books to anon;
grant select, delete on public.books to authenticated;

grant insert (
    id, author_id, title, subtitle, description, keywords, isbn, language,
    publisher, edition, original_publication_date, genre, series_id,
    series_position, price_all, cover_path, file_path
  )
  on public.books
  to authenticated;

grant update (series_id, series_position)
  on public.books
  to authenticated;

revoke all on public.bundles from public, anon, authenticated;
grant select on public.bundles to anon;
grant select, delete on public.bundles to authenticated;

grant insert (author_id, title, description, price_all)
  on public.bundles
  to authenticated;
