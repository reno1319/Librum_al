-- BD15 P5a ROLLBACK: undoes migration 20261104120000.
-- Puts back request_book_review() exactly as it was before (CREATE OR
-- REPLACE keeps its grants, restated anyway), and removes the four
-- review-lock triggers and their three functions. The migration added
-- no column, table or row, so there is no residue and no row changes.
--
-- Run only together with the app revert (the reverted app's updateBook
-- swaps the file of a book in review again). Safe to run more than once.

begin;

drop trigger if exists books_refuse_change_while_in_review on public.books;
drop trigger if exists book_contributors_refuse_change_while_in_review on public.book_contributors;
drop trigger if exists book_ai_disclosures_refuse_change_while_in_review on public.book_ai_disclosures;
drop trigger if exists book_rights_declarations_refuse_while_in_review on public.book_rights_declarations;
drop function if exists public.books_refuse_change_while_in_review();
drop function if exists public.book_children_refuse_change_while_in_review();
drop function if exists public.book_is_locked_for_review(uuid);

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

revoke all on function public.request_book_review(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_book_review(uuid) to authenticated;

commit;
