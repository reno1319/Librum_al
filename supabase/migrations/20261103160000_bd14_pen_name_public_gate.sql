-- ============================================================
-- BD14 (migration 20261103160000): a pen name is public only with a
-- published book. Views and one helper function only; no data changes.
-- The app keeps working before and after (same view columns).
-- Rollback: supabase/tests/089_bd14_pen_name_public_gate.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- BD14 (migration 20261103160000): a pen name goes public only with a
-- published book. Before BD14 any books, series or bundles row made it
-- public, so a DRAFT published the pen name (often the real name typed
-- at sign-up), its bio, photo and links (BD13 audit r4, S1). Renato's
-- answers 2026-11-03:
--   Q1a  a pen name with no published book is still seen by its own
--        author and by a reader who owns one of its books (as
--        public_books does), nobody else.
--   Q2a  a series is public only once it has a published book; until
--        then its author (and an owner of one of its books) sees it.
--   Q3a  once a book has been published, it keeps its pen name public
--        while the book exists, even unpublished or taken down
--        (books.published_at is set once and never cleared). Only
--        deleting every such book hides the pen name again.
--   Q4a  BD15's live pre-order will count as published: it extends
--        book_makes_pen_name_public() below, the one place the rule
--        lives.
-- A suspended account stays hidden (PEOPLE-1). Both views now filter
-- on the caller, so they are security_barrier, like public_books.
-- Same columns, so CREATE OR REPLACE keeps every existing grant.
-- ------------------------------------------------------------
create function public.book_makes_pen_name_public(b public.books)
returns boolean
language sql
immutable
parallel safe
as $$
  select b.status operator(pg_catalog.=) 'published'
      or b.published_at is not null
$$;

-- A view's function calls are checked against the caller, so anon and
-- authenticated (and service_role, which reads public_books) need
-- EXECUTE. The function only reads the row it is handed.
revoke all on function public.book_makes_pen_name_public(public.books)
  from public, anon, authenticated, service_role;
grant execute on function public.book_makes_pen_name_public(public.books)
  to anon, authenticated, service_role;

create or replace view public.public_pen_names
  with (security_barrier)
as
  select pn.id, pn.name, pn.bio, pn.avatar_path, pn.links
  from public.pen_names pn
  where (
    -- A series or bundle holds books of its own pen name only (LB451
    -- triggers), so the book carries the rule for them too.
       exists (select 1 from public.books b
                where b.pen_name_id = pn.id
                  and public.book_makes_pen_name_public(b))
    -- Q1a: the author, and a reader who owns one of its books.
    or pn.author_id = auth.uid()
    or (auth.uid() is not null
        and exists (select 1 from public.books b
                     where b.pen_name_id = pn.id
                       and public.user_owns_book(b.id)))
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = pn.author_id and sus.lifted_at is null
    );

create or replace view public.public_series
  with (security_barrier)
as
  select s.id, s.title, s.pen_name_id, s.created_at
  from public.series s
  where (
       exists (select 1 from public.books b
                where b.series_id = s.id
                  and public.book_makes_pen_name_public(b))
    -- Q2a: the author, and a reader who owns one of its books.
    or s.author_id = auth.uid()
    or (auth.uid() is not null
        and exists (select 1 from public.books b
                     where b.series_id = s.id
                       and public.user_owns_book(b.id)))
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = s.author_id and sus.lifted_at is null
    );
