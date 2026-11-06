-- ============================================================
-- BD15 P5b-1 (migration 20261104170000): live books stay live.
-- Plan: PLAN-BD15-r1.md section 2.7. Renato, 4 Nov 2026: P5b split in
-- three (Q1 a, 16:29 UTC); this part is the database only.
--
-- A live book keeps its approved version while changes that need
-- review (manuscript, cover, description, 18+ label, original author)
-- wait in book_pending_changes, one row per book, written by the app's
-- catalog writer (service_role). Sending them for review snapshots them
-- into book_reviews; staff approval copies them onto the book in the
-- same transaction. Sending back or withdrawing leaves the live book and
-- the pending row as they are; the author fixes and sends again, or
-- deletes the row ("Hidh poshtë ndryshimet").
--
-- What it changes, and nothing else:
--   1. book_reviews snapshots description and is_adult too, and an
--      approval binds to them (book_review_approval_valid gains two
--      arguments). Existing pending and approved rows whose file, cover
--      and original author equal their book's take its description and
--      18+ label (staging test data; Production has no books). So a book
--      taken offline and published again needs review when its
--      description or 18+ label changed in between.
--   2. book_pending_changes: only a live book has one (LB491). While a
--      review is pending it is read-only (P5a's LB490 rule). An 18+
--      pending change never meets a children/teen category (LB493),
--      and its cover is never another book's (LB495), from either side.
--      The catalog writer writes it only through
--      save_book_pending_changes() and discard_book_pending_changes(),
--      which lock the book first.
--   3. The live-book guard (LB463) now covers description and is_adult
--      too, and lets through only the write admin_approve_book_review
--      makes for an approved review whose snapshot equals the new
--      values.
--   4. request_book_review() sends a live book's pending changes
--      (nothing to send: LB494; the AI answer is still required, LB489).
--      admin_approve_book_review() applies them to the live book.
--      book_review_state() checks the approval with the new rule.
--   5. Renato Q3 a (16:30 UTC): a live book going offline (the
--      author's unpublish, a staff takedown, a suspension) cancels its
--      pending review, and its pending changes become the draft's
--      values in the same write. Takedown history, the approval rule
--      (approvals older than the last takedown never count) and the
--      buyers' file (their latest approved review) are unchanged.
--   6. Renato Q4 a (16:31 UTC): while a book is live its rights basis
--      can't change (LB492); the author takes it offline first.
--
-- New SQLSTATEs: LB491, LB492, LB493, LB494, LB495.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/092_bd15_live_pending_changes.test.sql and
-- 092_bd15_live_pending_changes_catalog_equivalence.sh.
-- Rollback: supabase/tests/092_bd15_live_pending_changes.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The review snapshot carries description and the 18+ label
-- ------------------------------------------------------------
alter table public.book_reviews
  add column description text,
  add column is_adult boolean;

update public.book_reviews r
   set description = bo.description,
       is_adult = bo.is_adult
  from public.books bo
 where bo.id = r.book_id
   and r.status in ('pending', 'approved')
   and r.file_path is not distinct from bo.file_path
   and r.cover_path is not distinct from bo.cover_path
   and r.original_author is not distinct from bo.original_author;

create function public.book_review_approval_valid(
  p_book_id uuid,
  p_file_path text,
  p_cover_path text,
  p_original_author text,
  p_description text,
  p_is_adult boolean
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
       -- A row from before this migration that the backfill could not
       -- match keeps a null snapshot; it binds the files only.
       and (r.description is null or r.description = p_description)
       and (r.is_adult is null or r.is_adult = p_is_adult)
       and r.decided_at > coalesce(
             (select max(t.taken_down_at) from public.book_takedowns t where t.book_id = p_book_id),
             '-infinity'::timestamptz)
  );
$$;

revoke all on function public.book_review_approval_valid(uuid, text, text, text, text, boolean)
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
     and not public.book_review_approval_valid(new.id, new.file_path, new.cover_path, new.original_author,
                                               new.description, new.is_adult)
  then
    raise exception 'This book needs Librum''s approval before it can be published.'
      using errcode = 'LB462';
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 2. Pending changes of a live book
-- ------------------------------------------------------------
create table public.book_pending_changes (
  book_id uuid primary key references public.books(id) on delete cascade,
  file_path text not null,
  -- books_cover_path_check's rule.
  cover_path text not null
    constraint book_pending_changes_cover_path_check
    check (cover_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/cover\.(jpg|png)$'),
  -- A live book always has a description; an empty one could be sent
  -- but never approved (audit r1, F5).
  description text not null
    constraint book_pending_changes_description_check
    check (pg_catalog.btrim(description) <> ''),
  is_adult boolean not null,
  original_author text
    constraint book_pending_changes_original_author_check
    check (original_author is null
           or (char_length(original_author) between 1 and 200
               and original_author = btrim(original_author)
               and original_author !~ '[[:cntrl:]]')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- books.cover_path is unique too: going offline copies this value
  -- onto the book (audit r1, F2).
  constraint book_pending_changes_cover_path_key unique (cover_path)
);

alter table public.book_pending_changes enable row level security;

-- The catalog writer (service_role) reads it, and writes it only through
-- save_book_pending_changes() / discard_book_pending_changes() below,
-- which lock the book first: the same order as an unpublish, a takedown
-- or an approval, so a save never deadlocks with them (audit r1, F1).
-- Staff functions and triggers write it as its owner.
revoke all on public.book_pending_changes from public, anon, authenticated, service_role;
grant select on public.book_pending_changes to service_role;

create function public.book_pending_changes_require_live_book()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_categories text[];
begin
  if tg_op = 'UPDATE' and new.book_id is distinct from old.book_id then
    raise exception 'Pending changes belong to one book.'
      using errcode = 'LB491';
  end if;
  -- FOR SHARE waits for a book update in flight (an unpublish), so a
  -- pending row is never left behind by a book that just went offline.
  select bo.status, bo.categories
    into v_status, v_categories
    from public.books bo
   where bo.id = new.book_id
     for share;
  if v_status is distinct from 'published' then
    raise exception 'Only a live book keeps pending changes.'
      using errcode = 'LB491';
  end if;
  if new.is_adult and v_categories && array['Për fëmijë', 'Për të rinj']::text[] then
    raise exception 'An 18+ book can''t be in the children''s or teen categories.'
      using errcode = 'LB493';
  end if;
  if exists (
    select 1 from public.books bo
     where bo.cover_path = new.cover_path and bo.id <> new.book_id
  ) then
    raise exception 'This cover belongs to another book.'
      using errcode = 'LB495';
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create trigger book_pending_changes_require_live_book
  before insert or update on public.book_pending_changes
  for each row
  execute function public.book_pending_changes_require_live_book();

revoke all on function public.book_pending_changes_require_live_book()
  from public, anon, authenticated, service_role;

-- P5a's rule: read-only while a review is pending.
create trigger book_pending_changes_refuse_change_while_in_review
  before insert or update or delete on public.book_pending_changes
  for each row
  execute function public.book_children_refuse_change_while_in_review();

-- The other side of LB493 (a children/teen category while an 18+
-- change waits) and of LB495 (a book taking a cover that another book's
-- pending change holds).
create function public.books_keep_pending_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- genre too: books_sync_categories (which copies a new genre into
  -- categories) runs after this trigger.
  if (new.categories && array['Për fëmijë', 'Për të rinj']::text[]
      or new.genre in ('Për fëmijë', 'Për të rinj'))
     and exists (
       select 1 from public.book_pending_changes c
        where c.book_id = new.id and c.is_adult
     )
  then
    raise exception 'An 18+ book can''t be in the children''s or teen categories.'
      using errcode = 'LB493';
  end if;
  if new.cover_path is not null
     and exists (
       select 1 from public.book_pending_changes c
        where c.cover_path = new.cover_path and c.book_id <> new.id
     )
  then
    raise exception 'This cover belongs to another book.'
      using errcode = 'LB495';
  end if;
  return new;
end;
$$;

create trigger books_keep_pending_rules
  before insert or update of genre, categories, cover_path on public.books
  for each row
  execute function public.books_keep_pending_rules();

revoke all on function public.books_keep_pending_rules()
  from public, anon, authenticated, service_role;

-- The catalog writer's two writes. p_author_id is the session's verified
-- user: a book of another account is answered as missing.
create function public.save_book_pending_changes(
  p_author_id uuid,
  p_book_id uuid,
  p_file_path text,
  p_cover_path text,
  p_description text,
  p_is_adult boolean,
  p_original_author text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.books bo
   where bo.id = p_book_id and bo.author_id = p_author_id
     for share;
  if not found or p_author_id is null then
    raise exception 'no book found for this id';
  end if;
  insert into public.book_pending_changes as c
         (book_id, file_path, cover_path, description, is_adult, original_author)
  values (p_book_id, p_file_path, p_cover_path, p_description, p_is_adult, p_original_author)
  on conflict (book_id) do update
     set file_path = excluded.file_path,
         cover_path = excluded.cover_path,
         description = excluded.description,
         is_adult = excluded.is_adult,
         original_author = excluded.original_author;
end;
$$;

revoke all on function public.save_book_pending_changes(uuid, uuid, text, text, text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_book_pending_changes(uuid, uuid, text, text, text, boolean, text)
  to service_role;

-- "Hidh poshtë ndryshimet". True when there was something to discard.
create function public.discard_book_pending_changes(p_author_id uuid, p_book_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  perform 1 from public.books bo
   where bo.id = p_book_id and bo.author_id = p_author_id
     for share;
  if not found or p_author_id is null then
    raise exception 'no book found for this id';
  end if;
  delete from public.book_pending_changes where book_id = p_book_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.discard_book_pending_changes(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.discard_book_pending_changes(uuid, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 3. The live-book guard
-- ------------------------------------------------------------
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
          or new.original_author is distinct from old.original_author
          or new.description is distinct from old.description
          or new.is_adult is distinct from old.is_adult)
     -- The one write that may: admin_approve_book_review applying an
     -- approved review whose snapshot is exactly the new values.
     and not exists (
       select 1 from public.book_reviews r
        where r.id::text = pg_catalog.current_setting('librum.applying_review', true)
          and r.book_id = new.id
          and r.status = 'approved'
          -- approved in this very transaction (audit r1, F4)
          and r.decided_at = pg_catalog.now()
          and r.file_path is not distinct from new.file_path
          and r.cover_path is not distinct from new.cover_path
          and r.original_author is not distinct from new.original_author
          and r.description is not distinct from new.description
          and r.is_adult is not distinct from new.is_adult
     )
  then
    raise exception 'A live book''s manuscript, cover, description, 18+ label or original author changes only through Librum''s review.'
      using errcode = 'LB463';
  end if;
  return new;
end;
$$;

drop trigger books_refuse_live_file_change on public.books;

create trigger books_refuse_live_file_change
  before update of file_path, cover_path, original_author, description, is_adult on public.books
  for each row
  execute function public.books_refuse_live_file_change();

-- ------------------------------------------------------------
-- 4. Going offline: the pending changes become the draft (Q3 a)
-- ------------------------------------------------------------
-- Changes made here to NEW are not in the UPDATE's column list, so the
-- column triggers (the live guard, P5a's lock) do not see them; the
-- table's CHECK constraints do. The pending review is cancelled first,
-- so the pending row is no longer locked when it is deleted.
create function public.books_take_pending_changes_offline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change record;
begin
  if old.status = 'published' and new.status is distinct from 'published' then
    update public.book_reviews
       set status = 'cancelled',
           decided_at = pg_catalog.now()
     where book_id = old.id
       and status = 'pending';

    select c.file_path, c.cover_path, c.description, c.is_adult, c.original_author
      into v_change
      from public.book_pending_changes c
     where c.book_id = old.id
       for update;
    if found then
      new.file_path := v_change.file_path;
      new.cover_path := v_change.cover_path;
      new.description := v_change.description;
      new.is_adult := v_change.is_adult;
      new.original_author := v_change.original_author;
      -- books_sync_categories' rule, which does not run for this.
      if new.is_adult then
        new.reading_age_min := 18;
      end if;
      delete from public.book_pending_changes where book_id = old.id;
    end if;
  end if;
  return new;
end;
$$;

create trigger books_take_pending_changes_offline
  before update of status on public.books
  for each row
  execute function public.books_take_pending_changes_offline();

revoke all on function public.books_take_pending_changes_offline()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. A live book keeps its rights basis (Q4 a)
-- ------------------------------------------------------------
create function public.book_rights_declarations_keep_live_basis()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_previous text;
begin
  if pg_catalog.current_setting('role') not in ('anon', 'authenticated', 'service_role') then
    return null;
  end if;
  select bo.status into v_status
    from public.books bo
   where bo.id = new.book_id
     for share;
  if v_status is distinct from 'published' then
    return null;
  end if;
  select d.basis into v_previous
    from public.book_rights_declarations d
   where d.book_id = new.book_id
     and d.id <> new.id
   order by d.declared_at desc, d.id desc
   limit 1;
  if new.basis is distinct from coalesce(v_previous, 'own_rights') then
    raise exception 'A live book''s rights basis can''t change. Take the book off sale first.'
      using errcode = 'LB492';
  end if;
  return null;
end;
$$;

-- AFTER, so the basis CHECK answers an unknown value first.
create trigger book_rights_declarations_keep_live_basis
  after insert on public.book_rights_declarations
  for each row
  execute function public.book_rights_declarations_keep_live_basis();

revoke all on function public.book_rights_declarations_keep_live_basis()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Sending for review
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
  v_change record;
  v_pending record;
  v_review_id uuid;
  v_file_path text;
  v_cover_path text;
  v_original_author text;
  v_description text;
  v_is_adult boolean;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  select bo.id, bo.title, bo.author_id, bo.status, bo.file_path, bo.cover_path, bo.original_author,
         bo.description, bo.is_adult, bo.categories
    into v_book
    from public.books bo
   where bo.id = p_book_id
     for update;

  if not found or v_book.author_id is distinct from v_actor_id then
    raise exception 'no book found for this id';
  end if;

  if v_book.status not in ('draft', 'published') then
    raise exception 'this book is already published';
  end if;

  if exists (
    select 1 from public.book_takedowns t
     where t.book_id = p_book_id and t.lifted_at is null
  ) then
    raise exception 'Librum took this book down. It can''t be published again until Librum allows it.'
      using errcode = 'LB460';
  end if;

  if v_book.status = 'published' then
    -- BD15 P5b-1: a live book sends its pending changes; it stays live.
    select c.file_path, c.cover_path, c.original_author, c.description, c.is_adult
      into v_change
      from public.book_pending_changes c
     where c.book_id = p_book_id;
    if not found
       or (v_change.file_path, v_change.cover_path, v_change.original_author, v_change.description, v_change.is_adult)
          is not distinct from
          (v_book.file_path, v_book.cover_path, v_book.original_author, v_book.description, v_book.is_adult)
    then
      raise exception 'this live book has no changes to send'
        using errcode = 'LB494';
    end if;
    v_file_path := v_change.file_path;
    v_cover_path := v_change.cover_path;
    v_original_author := v_change.original_author;
    v_description := v_change.description;
    v_is_adult := v_change.is_adult;
    if v_is_adult and v_book.categories && array['Për fëmijë', 'Për të rinj']::text[] then
      raise exception 'An 18+ book can''t be in the children''s or teen categories.'
        using errcode = 'LB493';
    end if;
  else
    v_file_path := v_book.file_path;
    v_cover_path := v_book.cover_path;
    v_original_author := v_book.original_author;
    v_description := v_book.description;
    v_is_adult := v_book.is_adult;
    if public.book_review_approval_valid(p_book_id, v_file_path, v_cover_path, v_original_author,
                                         v_description, v_is_adult) then
      raise exception 'this book is already approved';
    end if;
  end if;

  -- BD15 P5a: the Content tab's three answers (manuscript, cover, "AI
  -- used") are required before Librum is asked to look at the book. An
  -- already approved draft is answered above (it needs no new review).
  if v_file_path is null
     or v_cover_path is null
     or not exists (select 1 from public.book_ai_disclosures d where d.book_id = p_book_id)
  then
    raise exception 'this book needs a manuscript, a cover and the AI answer before review'
      using errcode = 'LB489';
  end if;

  select r.id, r.file_path, r.cover_path, r.original_author, r.description, r.is_adult
    into v_pending
    from public.book_reviews r
   where r.book_id = p_book_id
     and r.status = 'pending'
     for update;

  if found then
    if (v_pending.file_path, v_pending.cover_path, v_pending.original_author, v_pending.description, v_pending.is_adult)
       is not distinct from
       (v_file_path, v_cover_path, v_original_author, v_description, v_is_adult) then
      raise exception 'this book is already waiting for review';
    end if;
    update public.book_reviews
       set status = 'cancelled',
           decided_at = pg_catalog.now()
     where id = v_pending.id;
  end if;

  insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author,
                                   description, is_adult, status)
  values (p_book_id, v_book.title, v_book.author_id, v_file_path, v_cover_path, v_original_author,
          v_description, v_is_adult, 'pending')
  returning id into v_review_id;

  return v_review_id;
end;
$$;

-- ------------------------------------------------------------
-- 7. The author's view
-- ------------------------------------------------------------
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

  select bo.id, bo.author_id, bo.file_path, bo.cover_path, bo.original_author, bo.description, bo.is_adult
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
    'approval_valid', public.book_review_approval_valid(p_book_id, v_book.file_path, v_book.cover_path,
                                                        v_book.original_author, v_book.description, v_book.is_adult),
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

-- ------------------------------------------------------------
-- 8. Staff approval
-- ------------------------------------------------------------
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
  v_change record;
  v_first boolean;
  v_live boolean;
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
         bo.original_author, bo.is_adult
    into v_book
    from public.books bo
   where bo.id = v_book_id
     for update;
  if not found then
    raise exception 'no review found for this id';
  end if;

  select r.id, r.status, r.file_path, r.cover_path, r.original_author, r.description, r.is_adult
    into v_review
    from public.book_reviews r
   where r.id = p_review_id
     for update;

  if v_review.status <> 'pending' then
    raise exception 'this review is no longer waiting';
  end if;

  if v_book.status not in ('draft', 'published') then
    raise exception 'this book is already published';
  end if;
  v_live := v_book.status = 'published';

  if exists (
    select 1 from public.book_takedowns t
     where t.book_id = v_book_id and t.lifted_at is null
  ) then
    raise exception 'this book is taken down';
  end if;

  if p_file_path is distinct from v_review.file_path
     or p_cover_path is distinct from v_review.cover_path then
    raise exception 'the author changed the file or cover';
  end if;

  if v_live then
    -- BD15 P5b-1: the live book's pending changes are exactly what was
    -- sent.
    select c.file_path, c.cover_path, c.original_author, c.description, c.is_adult
      into v_change
      from public.book_pending_changes c
     where c.book_id = v_book_id
       for update;
    if not found
       or (v_change.file_path, v_change.cover_path) is distinct from (v_review.file_path, v_review.cover_path) then
      raise exception 'the author changed the file or cover';
    end if;
    if (v_change.original_author, v_change.description, v_change.is_adult)
       is distinct from (v_review.original_author, v_review.description, v_review.is_adult) then
      raise exception 'the author changed the book';
    end if;
  else
    if v_book.file_path is distinct from v_review.file_path
       or v_book.cover_path is distinct from v_review.cover_path then
      raise exception 'the author changed the file or cover';
    end if;
    if (v_book.original_author, v_book.description, v_book.is_adult)
       is distinct from (v_review.original_author, v_review.description, v_review.is_adult) then
      raise exception 'the author changed the book';
    end if;
  end if;

  if v_book.price_all is null
     or v_book.price_all is distinct from p_price_all
     or pg_catalog.btrim(coalesce(v_review.description, '')) = '' then
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

  if v_live then
    -- The live book takes the approved version; it never goes offline.
    -- Librum's choice stays.
    perform pg_catalog.set_config('librum.applying_review', p_review_id::text, true);
    update public.books
       set file_path = v_review.file_path,
           cover_path = v_review.cover_path,
           original_author = v_review.original_author,
           description = v_review.description,
           is_adult = v_review.is_adult
     where id = v_book_id;
    perform pg_catalog.set_config('librum.applying_review', '', true);
    delete from public.book_pending_changes where book_id = v_book_id;
  else
    update public.books
       set status = 'published',
           published_at = coalesce(published_at, pg_catalog.now()),
           librum_choice_at = null
     where id = v_book_id;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'book.review_approved', 'books', v_book_id,
          case when v_live
               then pg_catalog.jsonb_build_object('first_publication', v_first, 'live_update', true)
               else pg_catalog.jsonb_build_object('first_publication', v_first)
          end);

  return v_first;
end;
$$;

drop function public.book_review_approval_valid(uuid, text, text, text);
