-- BD3-P4 (Renato 2026-11-01, patch 4 answers 1a-6a, 16:05Z 1a 2a 3a):
-- the "Autori origjinal" of a translated or public-domain book.
--
-- WHAT CHANGES (no row is updated):
--   1. books.original_author: a new nullable text column, added last,
--      with a named CHECK (trimmed, 1..200 characters, no control
--      characters). Every existing row gets null, which the CHECK
--      accepts. Required-ness (both public-domain bases, 5a) is the
--      app's check: the rights choice lives in another table.
--   2. public.public_books: the same definer view, same rows, same
--      options, with original_author appended as its LAST column
--      (CREATE OR REPLACE VIEW may only append). Its grants (anon and
--      authenticated SELECT only, service_role all) and the policies
--      that read it are kept as they are.
--   3. public.search_books(): the same function, signature, grants and
--      invoker rights; its search term also matches original_author
--      (3a). unaccent(null) is null, so a book without one matches
--      exactly as before.
--   4. The review approval binds to the original author (16:37Z 2b,
--      16:45Z a): book_reviews.original_author (new, nullable, last),
--      a 4-argument book_review_approval_valid() replacing the
--      3-argument one, and the publish gate, live-files guard (and its
--      trigger's column list), request_book_review(),
--      book_review_state() and admin_approve_book_review() updated.
--      See section 4 below.
--
-- books' table and column grants are unchanged: anon has none,
-- authenticated has SELECT (RLS: own rows) and UPDATE on series_id and
-- series_position only, so only the server-only catalog writer
-- (service role) writes original_author.
--
-- ROLLBACK (supabase/tests/087_bd3_original_author.rollback.sql, proven
-- by the 087 harness): restores the previous search_books() body and
-- the previous review functions, trigger and 3-argument approval
-- function. The columns and the view column stay (nullable, unread once
-- the app is reverted): removing a view column means dropping
-- public.public_books, which the contributor, bundle and review policies
-- depend on.

alter table public.books
  add column original_author text
    constraint books_original_author_check
    check (original_author is null
           or (char_length(original_author) between 1 and 200
               and original_author = btrim(original_author)
               and original_author !~ '[[:cntrl:]]'));

create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at, b.pen_name_id,
         -- BD3-P4 (migration 20261101170000): appended last.
         b.original_author
  from public.books b
  where b.status = 'published'
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

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
      -- BD3-P4 (migration 20261101170000, 3a): the original author too.
      or extensions.unaccent(books.original_author) ilike extensions.unaccent('%' || search_term || '%')
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

-- ------------------------------------------------------------
-- 4. The review approval binds to the original author (Renato 1 Nov,
--    16:37Z 2b, 16:45Z a)
-- ------------------------------------------------------------
-- A changed original author on a live book takes it off the store and
-- back to review, like a new file or cover, and an approval is valid
-- only for the original author it was given for:
--   a. book_reviews.original_author: the snapshot, a new nullable text
--      column, added last. Existing rows get null, and every existing
--      book's original_author is null (step 1), so every approval valid
--      before this migration stays valid.
--   b. book_review_approval_valid() gains a fourth argument,
--      p_original_author, compared like the file and cover. The new
--      4-argument function is created, every caller moved to it, then
--      the 3-argument one is dropped. Internal: no API role may run it.
--   c. The publish gate (LB462) passes new.original_author.
--   d. The live-files guard (LB463) also refuses a changed original
--      author on a live book unless the same write takes it to draft;
--      its trigger fires on original_author too (dropped and created
--      again, since a trigger's column list cannot be altered).
--   e. request_book_review() snapshots it, compares it in its "already
--      approved" and "already waiting" checks; book_review_state()
--      passes it; admin_approve_book_review() refuses ('the author
--      changed the book') when the book's original author is no longer
--      the snapshot's. Signatures and grants of these three are
--      unchanged (CREATE OR REPLACE keeps their ACLs).
--
-- book_reviews' grants are unchanged: authenticated reads only its
-- eight listed columns (not this one); service_role reads all.

alter table public.book_reviews
  add column original_author text;

create function public.book_review_approval_valid(
  p_book_id uuid,
  p_file_path text,
  p_cover_path text,
  p_original_author text
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
       and r.original_author is not distinct from p_original_author
       and r.decided_at > coalesce(
             (select max(t.taken_down_at) from public.book_takedowns t where t.book_id = p_book_id),
             '-infinity'::timestamptz)
  );
$$;

revoke all on function public.book_review_approval_valid(uuid, text, text, text)
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
     and not public.book_review_approval_valid(new.id, new.file_path, new.cover_path, new.original_author)
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
          or new.cover_path is distinct from old.cover_path
          or new.original_author is distinct from old.original_author)
  then
    raise exception 'A live book''s file, cover or original author can only change when the book goes back to draft in the same write.'
      using errcode = 'LB463';
  end if;
  return new;
end;
$$;

drop trigger books_refuse_live_file_change on public.books;

create trigger books_refuse_live_file_change
  before update of file_path, cover_path, original_author on public.books
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

  select bo.id, bo.author_id, bo.file_path, bo.cover_path, bo.original_author
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
    'approval_valid', public.book_review_approval_valid(p_book_id, v_book.file_path, v_book.cover_path, v_book.original_author),
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
  select bo.id, bo.status, bo.file_path, bo.cover_path, bo.price_all, bo.description, bo.published_at,
         bo.original_author
    into v_book
    from public.books bo
   where bo.id = v_book_id
     for update;
  if not found then
    raise exception 'no review found for this id';
  end if;

  select r.id, r.status, r.file_path, r.cover_path, r.original_author
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
     or pg_catalog.btrim(coalesce(v_book.description, '')) = ''
     or v_book.original_author is distinct from v_review.original_author then
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

drop function public.book_review_approval_valid(uuid, text, text);
