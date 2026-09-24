-- CATALOG-STORAGE-PATH-AUTH-1 (Patch 8): authors can no longer name
-- public.books.file_path or public.books.cover_path in a direct INSERT.
--
-- ROLLOUT ORDER -- BINDING. Apply this migration ONLY AFTER the Patch 8
-- application is merged and READY on the target environment. The
-- application deployed before Patch 8 inserts every new book, with both
-- storage paths, through the author's own session; once this migration
-- is applied, that insert fails with a permission error and no book can
-- be created until the Patch 8 application is live. The Patch 8
-- application performs the insert through the server-only service-role
-- client and works against the ACL both before and after this migration,
-- so deploying the application first leaves no broken window.
--
-- WHY. Patch 7 (migration 20260924101853) left `file_path` and
-- `cover_path` in authenticated's column-level INSERT grant, because
-- createBook inserted them with the author's session. RLS on books checks
-- only `auth.uid() = author_id`, and nothing checks what a path points
-- at. An author could therefore insert, straight through the Data API, a
-- draft of their own whose `file_path` names another author's manuscript
-- object. /api/books/[id]/download then serves `file_path` through the
-- service-role client to the row's author, and account deletion removes
-- every path on the author's rows through the service-role client, so a
-- forged path could read, and on deletion destroy, someone else's file.
-- Row ownership does not protect a storage reference.
--
-- WHAT CHANGES, and nothing else: the books ACL of PUBLIC, anon and
-- authenticated is rewritten from a reset, exactly as Patch 7 left it
-- except that `cover_path` and `file_path` are no longer in
-- authenticated's INSERT column list:
--   * SELECT to anon; SELECT and DELETE to authenticated;
--   * authenticated INSERT on id, author_id, title, subtitle,
--     description, keywords, isbn, language, publisher, edition,
--     original_publication_date, genre, series_id, series_position,
--     price_all -- an ordinary pathless draft stays directly insertable;
--   * authenticated UPDATE on series_id and series_position only.
-- A direct insert that names either path column is refused whatever its
-- value, null included. createBook now inserts the row, with paths the
-- server derived from the authenticated user id and a server-generated
-- book id, through the trusted server-only writer after every gate.
--
-- UNCHANGED: public.bundles and every other table; every privilege of
-- service_role and of the table owner; RLS stays enabled with every
-- policy unchanged; every constraint, default and existing row. This
-- migration issues no DML, adds no constraint or trigger and rewrites no
-- path: rows created before it keep exactly the paths they have.
--
-- The declarative equivalent is in supabase/schema.sql;
-- 067_catalog_storage_path_authorization_catalog_equivalence.sh proves
-- the two build paths produce the same catalog, and
-- 067_catalog_storage_path_authorization.test.sql proves the behaviour.

revoke all on public.books from public, anon, authenticated;
grant select on public.books to anon;
grant select, delete on public.books to authenticated;

grant insert (
    id, author_id, title, subtitle, description, keywords, isbn, language,
    publisher, edition, original_publication_date, genre, series_id,
    series_position, price_all
  )
  on public.books
  to authenticated;

grant update (series_id, series_position)
  on public.books
  to authenticated;
