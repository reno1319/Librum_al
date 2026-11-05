-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- Rollback of supabase/migrations/20261105180000_bd15_pd_editions.sql
-- (BD15 P7). Safe to run twice. It removes the new functions and
-- triggers, puts public_books back to its BD15 P1 definition (pen_name_id
-- from books.pen_name_id), public_pen_names back to its BD14 definition,
-- and drops books.public_pen_name_id. It writes
-- no stored value: pd_works rows, links and editor mentions that staff
-- set stay (P1's tables and columns).
--
-- Before running it where real data exists: with the old view back, a
-- public-domain edition without an editor mention shows its uploader's
-- pen name again. Take such editions down first, or do not roll back.

begin;

drop function if exists public.pd_edition_redirect(uuid);
drop function if exists public.admin_approve_pd_edition(uuid, text, text, integer, jsonb);
drop function if exists public.staff_set_pd_edition(uuid, uuid, text, text, boolean);

drop trigger if exists books_require_pd_work_link on public.books;
drop function if exists public.books_require_pd_work_link();
drop trigger if exists book_contributors_freeze_picked_pd_edition on public.book_contributors;
drop function if exists public.book_contributors_freeze_picked_pd_edition();
drop trigger if exists books_freeze_picked_pd_edition on public.books;
drop function if exists public.books_freeze_picked_pd_edition();

create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at, b.pen_name_id,
         b.original_author,
         -- BD15 P1 (migration 20261103200000): appended last.
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

-- public_pen_names back to its BD14 definition (migration 20261103160000).
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

alter table public.books drop column if exists public_pen_name_id;

commit;
