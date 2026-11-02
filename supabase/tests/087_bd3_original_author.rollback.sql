-- BD3-P4 ROLLBACK: puts back, exactly as they were before migration
-- 20261101170000 (byte-identical bodies, same signatures; CREATE OR
-- REPLACE keeps their grants and invoker/definer rights):
--   * public.search_books(), so a search no longer matches
--     books.original_author;
--   * the review approval without the original author: the 3-argument
--     public.book_review_approval_valid(uuid, text, text) (created
--     again, no API role may run it), the publish gate and live-files
--     guard functions, the live-files trigger on file_path and
--     cover_path only, request_book_review(), book_review_state() and
--     admin_approve_book_review(); then the 4-argument function is
--     dropped.
--
-- Deliberately NOT removed: the books.original_author column, the
-- public_books view column and the book_reviews.original_author
-- column. Taking a column out of a view means dropping
-- public.public_books, which the book_contributors, bundle_books and
-- review policies depend on; nullable columns the reverted app and
-- functions never read are the safer state. No row is changed, so
-- nothing typed by an author is lost.
--
-- Run only together with the app revert (the patch 4 commit). Safe to
-- run more than once (CREATE OR REPLACE, DROP ... IF EXISTS, a guarded
-- DROP FUNCTION).
--
-- Known limits after a rollback (audit r1, L8):
--   * The live database then keeps books.original_author, its CHECK,
--     the public_books column and book_reviews.original_author, while
--     the reverted supabase/schema.sql (and test 075's column list) no
--     longer mention them. The next migration must start from the live
--     state: either keep the columns (put them back into schema.sql) or
--     drop them in a planned step that first drops and recreates
--     public.public_books with its grants and the policies that read
--     it.
--   * The forward migration cannot be re-run as is (ADD COLUMN would
--     fail on the existing columns). To apply patch 4 again, run it
--     without its two ADD COLUMN statements.
--   * After a rollback an approval no longer checks the original
--     author: a book whose original author changed while it was a
--     draft can be published again on its old approval.

create or replace function public.search_books(
  search_term text default null,
  genre_filter text default null,
  min_price_cents int default null,
  max_price_cents int default null,
  result_limit int default 500
)
returns table (book_id uuid)
language sql
security invoker
set search_path = ''
stable
as $$
  -- PEN-NAMES-2: public_books (no account columns), so this keeps working
  -- for anon after books' public SELECT is removed.
  select books.id as book_id
  from public.public_books books
  where books.status = 'published'
    and (genre_filter is null or books.genre = genre_filter)
    -- ALL-SEARCH-1: a row with no authored ALL price is not ALL-ready.
    -- Unconditional, never folded into the two bound checks below: a
    -- reader who applies no price filter at all must not be shown an
    -- unpriced book either.
    and books.price_all is not null
    -- ALL-SEARCH-1: whole-ALL catalog bounds. The parameter names still
    -- read "cents" and are deliberately not renamed here -- see the
    -- header. `price_cents` is never consulted: it is legacy USD minor
    -- units and its values are not lek.
    and (min_price_cents is null or books.price_all >= min_price_cents)
    and (max_price_cents is null or books.price_all <= max_price_cents)
    and (
      search_term is null
      or extensions.unaccent(books.title) ilike extensions.unaccent('%' || search_term || '%')
      or extensions.unaccent(books.description) ilike extensions.unaccent('%' || search_term || '%')
      or extensions.unaccent(books.keywords) ilike extensions.unaccent('%' || search_term || '%')
      or exists (
        -- PEN-NAMES-1 (5a): the book's OWN pen name, through the public
        -- view (no author_id). The account's public name finds only the
        -- books published under it (its default pen name), never a book
        -- under another pen name.
        select 1
        from public.public_pen_names pn
        where pn.id = books.pen_name_id
          and extensions.unaccent(pn.name)
            ilike extensions.unaccent('%' || search_term || '%')
      )
    )
  -- SEARCH CANDIDATE LIMIT (500) -- see the comment block above. NOT the
  -- 48-row VISIBLE SEARCH RESULT LIMIT the bookstore displays.
  limit least(greatest(coalesce(result_limit, 500), 1), 500);
$$;

-- The review approval, without the original author.
create or replace function public.book_review_approval_valid(
  p_book_id uuid,
  p_file_path text,
  p_cover_path text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.book_reviews r
     where r.book_id = p_book_id
       and r.status = 'approved'
       and not r.buyer_file_only
       and r.file_path is not distinct from p_file_path
       and r.cover_path is not distinct from p_cover_path
       and r.decided_at > coalesce(
             (select max(t.taken_down_at) from public.book_takedowns t where t.book_id = p_book_id),
             '-infinity'::timestamptz)
  );
$$;

revoke all on function public.book_review_approval_valid(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.books_require_review_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published'
     and old.status is distinct from 'published'
     and not public.book_review_approval_valid(new.id, new.file_path, new.cover_path)
  then
    raise exception 'This book needs Librum''s approval before it can be published.'
      using errcode = 'LB462';
  end if;
  return new;
end;
$$;

create or replace function public.books_refuse_live_file_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'published'
     and new.status = 'published'
     and (new.file_path is distinct from old.file_path
          or new.cover_path is distinct from old.cover_path)
  then
    raise exception 'A live book''s file or cover can only change when the book goes back to draft in the same write.'
      using errcode = 'LB463';
  end if;
  return new;
end;
$$;

drop trigger if exists books_refuse_live_file_change on public.books;

create trigger books_refuse_live_file_change
  before update of file_path, cover_path on public.books
  for each row
  execute function public.books_refuse_live_file_change();

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

  select bo.id, bo.title, bo.author_id, bo.status, bo.file_path, bo.cover_path
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

  if public.book_review_approval_valid(p_book_id, v_book.file_path, v_book.cover_path) then
    raise exception 'this book is already approved';
  end if;

  select r.id, r.file_path, r.cover_path
    into v_pending
    from public.book_reviews r
   where r.book_id = p_book_id
     and r.status = 'pending'
     for update;

  if found then
    if v_pending.file_path is not distinct from v_book.file_path
       and v_pending.cover_path is not distinct from v_book.cover_path then
      raise exception 'this book is already waiting for review';
    end if;
    update public.book_reviews
       set status = 'cancelled',
           decided_at = pg_catalog.now()
     where id = v_pending.id;
  end if;

  insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status)
  values (p_book_id, v_book.title, v_book.author_id, v_book.file_path, v_book.cover_path, 'pending')
  returning id into v_review_id;

  return v_review_id;
end;
$$;

create or replace function public.book_review_state(p_book_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_book record;
  v_latest record;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  select bo.id, bo.author_id, bo.file_path, bo.cover_path
    into v_book
    from public.books bo
   where bo.id = p_book_id;

  if not found or v_book.author_id is distinct from v_actor_id then
    raise exception 'no book found for this id';
  end if;

  select r.status, r.reason, r.message_to_author, r.decided_at
    into v_latest
    from public.book_reviews r
   where r.book_id = p_book_id
   order by r.submitted_at desc, coalesce(r.decided_at, 'infinity'::timestamptz) desc, r.id desc
   limit 1;

  return pg_catalog.jsonb_build_object(
    'pending', exists (
      select 1 from public.book_reviews r
       where r.book_id = p_book_id and r.status = 'pending'
    ),
    'approval_valid', public.book_review_approval_valid(p_book_id, v_book.file_path, v_book.cover_path),
    'latest_sent_back', case
      when v_latest.status = 'sent_back' then pg_catalog.jsonb_build_object(
        'reason', v_latest.reason,
        'message', v_latest.message_to_author,
        'decided_at', v_latest.decided_at
      )
      else null
    end
  );
end;
$$;

create or replace function public.admin_approve_book_review(
  p_review_id uuid,
  p_file_path text,
  p_cover_path text,
  p_price_all integer,
  p_checklist jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_book_id uuid;
  v_book record;
  v_review record;
  v_first boolean;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('books.review') then
    raise exception 'not authorized';
  end if;

  select r.book_id into v_book_id
    from public.book_reviews r
   where r.id = p_review_id;
  if not found or v_book_id is null then
    raise exception 'no review found for this id';
  end if;

  -- The book first, then the review (request_book_review's order).
  select bo.id, bo.status, bo.file_path, bo.cover_path, bo.price_all, bo.description, bo.published_at
    into v_book
    from public.books bo
   where bo.id = v_book_id
     for update;
  if not found then
    raise exception 'no review found for this id';
  end if;

  select r.id, r.status, r.file_path, r.cover_path
    into v_review
    from public.book_reviews r
   where r.id = p_review_id
     for update;

  if v_review.status <> 'pending' then
    raise exception 'this review is no longer waiting';
  end if;

  if v_book.status <> 'draft' then
    raise exception 'this book is already published';
  end if;

  if exists (
    select 1 from public.book_takedowns t
     where t.book_id = v_book_id and t.lifted_at is null
  ) then
    raise exception 'this book is taken down';
  end if;

  if v_book.file_path is distinct from v_review.file_path
     or v_book.cover_path is distinct from v_review.cover_path
     or p_file_path is distinct from v_review.file_path
     or p_cover_path is distinct from v_review.cover_path then
    raise exception 'the author changed the file or cover';
  end if;

  if v_book.price_all is null
     or v_book.price_all is distinct from p_price_all
     or pg_catalog.btrim(coalesce(v_book.description, '')) = '' then
    raise exception 'the author changed the book';
  end if;

  if p_checklist is distinct from '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}'::jsonb then
    raise exception 'invalid checklist';
  end if;

  update public.book_reviews
     set status = 'approved',
         checklist = p_checklist,
         decided_by = v_actor_id,
         decided_at = pg_catalog.now()
   where id = p_review_id;

  v_first := v_book.published_at is null;

  update public.books
     set status = 'published',
         published_at = coalesce(published_at, pg_catalog.now()),
         librum_choice_at = null
   where id = v_book_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'book.review_approved', 'books', v_book_id,
          pg_catalog.jsonb_build_object('first_publication', v_first));

  return v_first;
end;
$$;

-- Dropped only when present, so a second run prints nothing.
do $$
begin
  if pg_catalog.to_regprocedure('public.book_review_approval_valid(uuid,text,text,text)') is not null then
    drop function public.book_review_approval_valid(uuid, text, text, text);
  end if;
end;
$$;
