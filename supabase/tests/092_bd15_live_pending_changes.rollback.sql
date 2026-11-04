-- BD15 P5b-1 ROLLBACK: undoes migration 20261104170000.
-- Puts back, exactly as they were before (CREATE OR REPLACE keeps their
-- grants): book_review_approval_valid(uuid, text, text, text),
-- books_require_review_approval(), books_refuse_live_file_change() and
-- its trigger's column list, request_book_review(), book_review_state()
-- and admin_approve_book_review(). Removes book_pending_changes, its
-- functions and triggers, save_book_pending_changes(),
-- discard_book_pending_changes(), books_keep_pending_rules,
-- books_take_pending_changes_offline, the rights-basis lock and the two
-- book_reviews snapshot columns.
--
-- DATA: every row of book_pending_changes (changes saved or waiting on a
-- live book) and the description/18+ snapshots in book_reviews are
-- dropped; the live books keep their approved versions. A review still
-- waiting on a live book is cancelled first (the restored functions can
-- only approve drafts, and P5a's lock would keep the book read-only). Their uploaded
-- files stay in Storage. Run only together with the app revert. Safe to
-- run more than once.

begin;

update public.book_reviews r
   set status = 'cancelled',
       decided_at = pg_catalog.now()
  from public.books bo
 where bo.id = r.book_id
   and bo.status = 'published'
   and r.status = 'pending';

drop trigger if exists book_pending_changes_require_live_book on public.book_pending_changes;
drop trigger if exists book_pending_changes_refuse_change_while_in_review on public.book_pending_changes;
drop trigger if exists books_keep_pending_rules on public.books;
drop trigger if exists books_take_pending_changes_offline on public.books;
drop trigger if exists book_rights_declarations_keep_live_basis on public.book_rights_declarations;
drop table if exists public.book_pending_changes;
drop function if exists public.book_pending_changes_require_live_book();
drop function if exists public.books_keep_pending_rules();
drop function if exists public.save_book_pending_changes(uuid, uuid, text, text, text, boolean, text);
drop function if exists public.discard_book_pending_changes(uuid, uuid);
drop function if exists public.books_take_pending_changes_offline();
drop function if exists public.book_rights_declarations_keep_live_basis();

create or replace function public.book_review_approval_valid(
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

drop trigger if exists books_refuse_live_file_change on public.books;

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

drop function if exists public.book_review_approval_valid(uuid, text, text, text, text, boolean);

alter table public.book_reviews
  drop column if exists description,
  drop column if exists is_adult;

commit;
