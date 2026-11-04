-- ============================================================
-- BD15 P5a (migration 20261104120000): the review guard. Plan:
-- PLAN-BD15-r1.md section 4 (P5), split by Renato on 4 Nov 2026
-- (10:33 UTC, option a): this part is the guard; a live book keeping
-- its old version while a change waits is P5b, with its own migration.
--
-- What it changes, and nothing else:
--   1. request_book_review() refuses a book with no manuscript, no
--      cover, or no "AI used" answer (LB489). Restated in full; the new
--      check is the only change.
--   2. A book waiting for review is read-only (Renato, 4 Nov, Q2 a and
--      Q3 a): while it has a pending review, the app's roles cannot
--      change its content columns, its contributors, its "AI used"
--      answer or its rights choice (LB490). The author cancels the
--      review, edits, and sends it again. This also closes the P3
--      audit's F3 race (a Content save landing after "Send for review"
--      in another tab).
--      Its pen name, series and series position are locked too, except
--      that a deleted series still clears series_id through its foreign
--      key (a cascade, so pg_trigger_depth() > 1). Not locked: status,
--      published_at, librum_choice_at and the staff-only pd_* columns.
--      Librum's own SQL session and migrations are not checked (P1's
--      rule). A write to a child table (contributors, the AI answer, a
--      rights choice) first takes a key-share lock on the book row, so
--      it waits for a "Send for review" in flight and then sees its
--      pending review (audit r1, F2).
--
-- New SQLSTATEs: LB489 (incomplete book sent for review), LB490 (book
-- changed while waiting for review).
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/091_bd15_review_guard.test.sql and
-- 091_bd15_review_guard_catalog_equivalence.sh.
-- Rollback: supabase/tests/091_bd15_review_guard.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Only a complete book is sent for review
-- ------------------------------------------------------------
create or replace function public.request_book_review(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_book record;
  v_pending record;
  v_review_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  select bo.id, bo.title, bo.author_id, bo.status, bo.file_path, bo.cover_path, bo.original_author
    into v_book
    from public.books bo
   where bo.id = p_book_id
     for update;

  if not found or v_book.author_id is distinct from v_actor_id then
    raise exception 'no book found for this id';
  end if;

  if v_book.status <> 'draft' then
    raise exception 'this book is already published';
  end if;

  if exists (
    select 1 from public.book_takedowns t
     where t.book_id = p_book_id and t.lifted_at is null
  ) then
    raise exception 'Librum took this book down. It can''t be published again until Librum allows it.'
      using errcode = 'LB460';
  end if;

  if public.book_review_approval_valid(p_book_id, v_book.file_path, v_book.cover_path, v_book.original_author) then
    raise exception 'this book is already approved';
  end if;

  -- BD15 P5a: the Content tab's three answers (manuscript, cover, "AI
  -- used") are required before Librum is asked to look at the book. An
  -- already approved book is answered above (it needs no new review).
  if v_book.file_path is null
     or v_book.cover_path is null
     or not exists (select 1 from public.book_ai_disclosures d where d.book_id = p_book_id)
  then
    raise exception 'this book needs a manuscript, a cover and the AI answer before review'
      using errcode = 'LB489';
  end if;

  select r.id, r.file_path, r.cover_path, r.original_author
    into v_pending
    from public.book_reviews r
   where r.book_id = p_book_id
     and r.status = 'pending'
     for update;

  if found then
    if v_pending.file_path is not distinct from v_book.file_path
       and v_pending.cover_path is not distinct from v_book.cover_path
       and v_pending.original_author is not distinct from v_book.original_author then
      raise exception 'this book is already waiting for review';
    end if;
    update public.book_reviews
       set status = 'cancelled',
           decided_at = pg_catalog.now()
     where id = v_pending.id;
  end if;

  insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, status)
  values (p_book_id, v_book.title, v_book.author_id, v_book.file_path, v_book.cover_path, v_book.original_author, 'pending')
  returning id into v_review_id;

  return v_review_id;
end;
$$;

revoke all on function public.request_book_review(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_book_review(uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. A book waiting for review is read-only
-- ------------------------------------------------------------
-- The one place the rule lives: the app's roles, and a pending review.
create function public.book_is_locked_for_review(p_book_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
     and exists (
       select 1 from public.book_reviews r
        where r.book_id = p_book_id
          and r.status = 'pending'
     );
$$;

revoke all on function public.book_is_locked_for_review(uuid)
  from public, anon, authenticated, service_role;

create function public.books_refuse_change_while_in_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if ((new.title, new.subtitle, new.description, new.keywords, new.isbn, new.language,
       new.publisher, new.edition, new.original_publication_date, new.genre, new.categories,
       new.cover_path, new.file_path, new.price_all, new.original_author, new.is_adult,
       new.reading_age_min, new.edition_number, new.pen_name_id)
      is distinct from
      (old.title, old.subtitle, old.description, old.keywords, old.isbn, old.language,
       old.publisher, old.edition, old.original_publication_date, old.genre, old.categories,
       old.cover_path, old.file_path, old.price_all, old.original_author, old.is_adult,
       old.reading_age_min, old.edition_number, old.pen_name_id)
      -- A deleted series clears series_id through its foreign key (ON
      -- DELETE SET NULL, run by a trigger, so depth > 1): allowed.
      or ((new.series_id, new.series_position) is distinct from (old.series_id, old.series_position)
          and not (pg_catalog.pg_trigger_depth() > 1 and new.series_id is null)))
     and public.book_is_locked_for_review(old.id)
  then
    raise exception 'This book is waiting for review. Cancel the review to change it.'
      using errcode = 'LB490';
  end if;
  -- Audit r2 (N2): a deleted series clears series_id through its foreign
  -- key; its position goes with it, on every book of the series, so no
  -- book keeps a position without a series (the app's own unlink before
  -- the delete fails as a whole when one book is in review).
  if pg_catalog.pg_trigger_depth() > 1 and new.series_id is null and old.series_id is not null then
    new.series_position := null;
  end if;
  return new;
end;
$$;

create trigger books_refuse_change_while_in_review
  before update of title, subtitle, description, keywords, isbn, language, publisher, edition,
    original_publication_date, genre, categories, cover_path, file_path, price_all,
    original_author, is_adult, reading_age_min, edition_number, pen_name_id, series_id,
    series_position
  on public.books
  for each row
  execute function public.books_refuse_change_while_in_review();

revoke all on function public.books_refuse_change_while_in_review()
  from public, anon, authenticated, service_role;

-- Contributors, the "AI used" answer and the rights choice belong to
-- the book's content too. A delete that cascades from the book itself is not refused: the
-- book's own delete trigger cancels its pending review first.
create function public.book_children_refuse_change_while_in_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Audit r2 (N3): no error oracle for another account's book. A caller
  -- who owns neither book is answered by RLS, as book_contributors_limit
  -- does; nothing is locked or read for them.
  if pg_catalog.current_setting('role') in ('anon', 'authenticated')
     and not exists (
       select 1 from public.books b
        where b.id in (case when tg_op = 'DELETE' then old.book_id else new.book_id end,
                       case when tg_op = 'UPDATE' then old.book_id end)
          and b.author_id = auth.uid()
     )
  then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Audit r1 (F2): wait for a "Send for review" in flight on the book
  -- (request_book_review holds the book row FOR UPDATE), so the check
  -- below sees the pending review it creates. Both books of an UPDATE
  -- that moves the row, in id order.
  perform 1 from public.books bo
   where bo.id in (case when tg_op = 'DELETE' then old.book_id else new.book_id end,
                   case when tg_op = 'UPDATE' then old.book_id end)
   order by bo.id
     for key share;
  if public.book_is_locked_for_review(case when tg_op = 'DELETE' then old.book_id else new.book_id end)
     or (tg_op = 'UPDATE' and public.book_is_locked_for_review(old.book_id))
  then
    raise exception 'This book is waiting for review. Cancel the review to change it.'
      using errcode = 'LB490';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger book_contributors_refuse_change_while_in_review
  before insert or update or delete on public.book_contributors
  for each row
  execute function public.book_children_refuse_change_while_in_review();

create trigger book_ai_disclosures_refuse_change_while_in_review
  before insert or update or delete on public.book_ai_disclosures
  for each row
  execute function public.book_children_refuse_change_while_in_review();

-- A new rights choice is a change too (the declarations are append-only,
-- so only an insert can change it).
create trigger book_rights_declarations_refuse_while_in_review
  before insert on public.book_rights_declarations
  for each row
  execute function public.book_children_refuse_change_while_in_review();

revoke all on function public.book_children_refuse_change_while_in_review()
  from public, anon, authenticated, service_role;
