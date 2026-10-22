-- ADMIN-3-REVIEW ("In review"): new books, and a new book file or cover
-- on a live book, wait for staff approval before they are in the
-- Bookstore (Renato's answers 1a-11a, 2026-10-20).
--
-- RELEASE ORDER (M7). In EVERY environment this migration applies only
-- AFTER the full PEN-NAMES-2 sequence (expand, code, storage copy,
-- contract 20261019222600, delete-old) and after ADMIN-2
-- (20261020080000). The live-files guard below refuses PEN-2's storage
-- `copy` step (it repoints books.cover_path on published books), which
-- is safe only because the contract's C0 forces that copy to have run
-- first. Then: this migration on the environment BEFORE the app deploy.
-- Between the two, the old app's publish is refused by the gate (LB462)
-- unless the book has a matching approval (every book published at
-- migration time has one, see 10), and the old app's manuscript uploads
-- to final keys on the author's session are refused by the new storage
-- policies. Production gets it only at a release, through the
-- authorized route.
--
-- "In review" is NOT a new books.status value: a book in review is a
-- `draft` with a `pending` book_reviews row (the takedown pattern), so
-- public_books, the other public views, search_books, the sitemap, the
-- bookstore and the author pages need no change.
--
-- WHAT CHANGES, and nothing else:
--
--   1. staff_has_permission(): 'books.review' for admin (owner has
--      everything). Restated in full.
--   2. public.book_reviews: one row per submission, kept as history.
--      Each row snapshots the book's file_path and cover_path when it is
--      submitted; an approval is bound to exactly those two values.
--      RLS: an author reads their own rows. authenticated holds SELECT on
--      the author-facing columns only (no id, paths, checklist or staff
--      id); service_role SELECT only; nobody inserts, updates or
--      deletes: the SECURITY DEFINER functions below are the only
--      writers.
--   3. book_review_approval_valid(book, file, cover) (internal): an
--      approved review, not buyer_file_only, whose snapshot equals the
--      given paths, decided after the book's latest takedown. The ONE
--      place the rule lives.
--   4. The publish gate: BEFORE UPDATE OF status on books, a
--      draft -> published write needs a valid approval for the NEW
--      paths (LB462), for every role, service_role and the table owner
--      included. There is no INSERT trigger: authenticated cannot insert
--      books at all and createBook never names status, so a new row is
--      always a draft. (Staging fixtures insert published rows with the
--      service role directly: an accepted staging-only exception.)
--   5. The live-files guard: BEFORE UPDATE OF file_path, cover_path, a
--      published book's file or cover may only change in a write that
--      also sets it back to draft (LB463). No service_role exception.
--   6. On a book DELETE (direct or cascade) its pending review is
--      cancelled, so no review outlives its book as "pending".
--   7. request_book_review / withdraw_book_review (the author) and
--      book_review_state (the author's own view: pending, whether the
--      current files are approved, the latest send back).
--   8. admin_approve_book_review / admin_send_back_book_review
--      (books.review): approve publishes the book in the same
--      transaction; both write an audit row (never the message).
--   9. admin_unpublish_book() also cancels a pending review (restated
--      in full; one added statement).
--  10. Backfill (1a): one approved, grandfathered review per book that
--      is PUBLISHED now, with its current title and paths. A1 = a: one
--      approved, grandfathered, buyer_file_only review per DRAFT that has
--      any purchase, was published before, or was ever taken down (the
--      readers' copy; never valid for publishing). Other drafts get
--      nothing.
--  11. Storage: authors may write (insert, update, delete) in the
--      private manuscripts bucket only under their own "<uid>/tmp/"
--      folder; every final manuscript key is written and removed by the
--      server (service role). SELECT on own objects is unchanged. Same
--      policy names.
--  12. list_admin_audit_events(): 'book.review_approved' and
--      'book.review_sent_back' join the action allow-list.
--
-- New SQLSTATEs: LB462 (no valid approval), LB463 (live files changed
-- while published). LB460 (taken down) still fires first: its trigger
-- sorts before books_require_review_approval.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/077_book_reviews.test.sql and
-- 077_book_reviews_catalog_equivalence.sh.

-- ------------------------------------------------------------
-- 1. Permission
-- ------------------------------------------------------------
create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_members sm
    where sm.user_id = auth.uid()
      and (
        sm.role = 'owner'
        or (
          sm.role = 'admin'
          and p_permission in (
            'admin.access', 'reports.view', 'reports.resolve',
            'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view',
            'finance.view', 'finance.payout_export', 'finance.payout_operate',
            'blog.view', 'blog.manage', 'books.review'
          )
        )
        or (
          sm.role = 'editor'
          and p_permission in ('admin.access', 'blog.view', 'blog.manage')
        )
        or (
          sm.role = 'moderator'
          and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
        )
        or (
          sm.role = 'support'
          and p_permission in ('admin.access', 'refunds.view')
        )
      )
  );
$$;

-- ------------------------------------------------------------
-- 2. Review history
-- ------------------------------------------------------------
create table public.book_reviews (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references public.books(id) on delete set null,
  book_title text not null,
  author_id uuid references public.profiles(id) on delete set null,
  file_path text,
  cover_path text,
  status text not null
    constraint book_reviews_status_check
    check (status in ('pending', 'approved', 'sent_back', 'withdrawn', 'cancelled')),
  grandfathered boolean not null default false,
  submitted_at timestamptz not null default now(),
  reason text
    constraint book_reviews_reason_check
    check (reason in ('copyright', 'content_rules', 'broken_file', 'other')),
  message_to_author text
    constraint book_reviews_message_to_author_check
    check (char_length(message_to_author) between 1 and 2000
           and message_to_author = btrim(message_to_author, E' \t\r\n')),
  checklist jsonb
    constraint book_reviews_checklist_check
    check (checklist = '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}'::jsonb),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  -- A1 (Q1/R1): an approval recorded by the migration backfill for a
  -- draft that readers may already hold. It is the readers' copy (the N2a
  -- buyer rule and the N3 keep-set count it like any approval), but it
  -- never makes the book publishable: book_review_approval_valid() skips
  -- it. Only the migration backfill ever writes true; no function does.
  buyer_file_only boolean not null default false,
  constraint book_reviews_sent_back_check
    check ((status = 'sent_back') = (reason is not null)
           and (status = 'sent_back') = (message_to_author is not null)),
  constraint book_reviews_approved_checklist_check
    check ((status = 'approved' and not grandfathered) = (checklist is not null)),
  constraint book_reviews_grandfathered_check
    check (not grandfathered or status = 'approved'),
  constraint book_reviews_decided_at_check
    check ((status = 'pending') = (decided_at is null)),
  constraint book_reviews_buyer_file_only_check
    check (not buyer_file_only or grandfathered)
);

create unique index book_reviews_one_pending_per_book
  on public.book_reviews (book_id)
  where status = 'pending';

create index book_reviews_book_id_decided_at_idx
  on public.book_reviews (book_id, decided_at desc);

create index book_reviews_author_id_idx
  on public.book_reviews (author_id);

alter table public.book_reviews enable row level security;

create policy "Authors can read their own reviews"
  on public.book_reviews for select
  to authenticated
  using (auth.uid() = author_id);

revoke all on public.book_reviews from public, anon, authenticated, service_role;
grant select (
    book_id, book_title, author_id, status, submitted_at, reason,
    message_to_author, decided_at
  )
  on public.book_reviews
  to authenticated;
grant select on public.book_reviews to service_role;

-- ------------------------------------------------------------
-- 3. The approval rule, in one place
-- ------------------------------------------------------------
create function public.book_review_approval_valid(
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

-- ------------------------------------------------------------
-- 4. The publish gate
-- ------------------------------------------------------------
create function public.books_require_review_approval()
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

create trigger books_require_review_approval
  before update of status on public.books
  for each row
  execute function public.books_require_review_approval();

revoke all on function public.books_require_review_approval()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. The live-files guard
-- ------------------------------------------------------------
create function public.books_refuse_live_file_change()
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

create trigger books_refuse_live_file_change
  before update of file_path, cover_path on public.books
  for each row
  execute function public.books_refuse_live_file_change();

revoke all on function public.books_refuse_live_file_change()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 6. A deleted book's pending review is cancelled
-- ------------------------------------------------------------
-- Runs on a direct delete and on a cascade (account deletion) alike. It
-- deletes no book, so books_refuse_delete_while_taken_down's depth test
-- is unaffected; if that lock refuses the delete, this update rolls back
-- with it.
create function public.books_cancel_pending_review_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- In an account deletion the author's profile may already be gone when
  -- this runs (the cascade's order is not fixed); author_id is cleared
  -- then, as its own ON DELETE SET NULL would do, so the row never points
  -- at a deleted profile.
  update public.book_reviews r
     set status = 'cancelled',
         decided_at = pg_catalog.now(),
         author_id = case
           when exists (select 1 from public.profiles pr where pr.id = r.author_id) then r.author_id
           else null
         end
   where r.book_id = old.id
     and r.status = 'pending';
  return old;
end;
$$;

create trigger books_cancel_pending_review_on_delete
  before delete on public.books
  for each row
  execute function public.books_cancel_pending_review_on_delete();

revoke all on function public.books_cancel_pending_review_on_delete()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 7. The author's side
-- ------------------------------------------------------------
-- Sends the book's CURRENT title, file and cover for review. The app
-- runs every publish-readiness check before calling this. A pending
-- review whose snapshot no longer equals the book's paths (a new file
-- or cover since) is never rewritten in place: it is cancelled and the
-- new pending row inserted, in this one transaction.
create function public.request_book_review(p_book_id uuid)
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

revoke all on function public.request_book_review(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_book_review(uuid) to authenticated;

create function public.withdraw_book_review(p_book_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_review_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  perform 1
    from public.books bo
   where bo.id = p_book_id
     and bo.author_id = v_actor_id
     for update;
  if not found then
    raise exception 'no book found for this id';
  end if;

  update public.book_reviews
     set status = 'withdrawn',
         decided_at = pg_catalog.now(),
         decided_by = v_actor_id
   where book_id = p_book_id
     and status = 'pending'
  returning id into v_review_id;

  if v_review_id is null then
    raise exception 'this book is not waiting for review';
  end if;
end;
$$;

revoke all on function public.withdraw_book_review(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.withdraw_book_review(uuid) to authenticated;

-- The author's own view of one book: whether a review is pending,
-- whether the book's CURRENT files carry a valid approval (the gate's
-- own rule), and the latest send back -- only when the newest review
-- row of the book is that send back.
create function public.book_review_state(p_book_id uuid)
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

revoke all on function public.book_review_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.book_review_state(uuid) to authenticated;

-- ------------------------------------------------------------
-- 8. Staff: approve, send back
-- ------------------------------------------------------------
-- Approve binds to the exact files staff looked at (the snapshot, the
-- book's current paths and the values the page rendered must all be
-- equal) and to the price and description the app's readiness check
-- saw. The review becomes 'approved' FIRST, then the book is published
-- in the same transaction (the gate sees the approval). Librum's choice
-- is always cleared, as performPublish's draft -> published self-heal
-- does.
create function public.admin_approve_book_review(
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

revoke all on function public.admin_approve_book_review(uuid, text, text, integer, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_approve_book_review(uuid, text, text, integer, jsonb) to authenticated;

-- The book stays a draft. The audit row carries the reason, never the
-- message.
create function public.admin_send_back_book_review(
  p_review_id uuid,
  p_reason text,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_book_id uuid;
  v_message text;
  v_status text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('books.review') then
    raise exception 'not authorized';
  end if;

  if p_reason is null or p_reason not in ('copyright', 'content_rules', 'broken_file', 'other') then
    raise exception 'invalid reason';
  end if;

  v_message := pg_catalog.btrim(coalesce(p_message, ''), E' \t\r\n');
  if pg_catalog.char_length(v_message) < 1 or pg_catalog.char_length(v_message) > 2000 then
    raise exception 'invalid message';
  end if;

  select r.book_id into v_book_id
    from public.book_reviews r
   where r.id = p_review_id;
  if not found or v_book_id is null then
    raise exception 'no review found for this id';
  end if;

  perform 1 from public.books bo where bo.id = v_book_id for update;

  select r.status into v_status
    from public.book_reviews r
   where r.id = p_review_id
     for update;
  if v_status <> 'pending' then
    raise exception 'this review is no longer waiting';
  end if;

  update public.book_reviews
     set status = 'sent_back',
         reason = p_reason,
         message_to_author = v_message,
         decided_by = v_actor_id,
         decided_at = pg_catalog.now()
   where id = p_review_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'book.review_sent_back', 'books', v_book_id,
          pg_catalog.jsonb_build_object('reason', p_reason));
end;
$$;

revoke all on function public.admin_send_back_book_review(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_send_back_book_review(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- 9. A takedown cancels a pending review (ADMIN-2's function, restated
--    in full; the only change is the book_reviews update after the book
--    is drafted).
-- ------------------------------------------------------------
create or replace function public.admin_unpublish_book(
  p_book_id uuid,
  p_reason text,
  p_message text,
  p_report_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_reason_label text;
  v_message text;
  v_title text;
  v_author_id uuid;
  v_choice_cleared boolean;
  v_bundle_ids uuid[];
  v_takedown_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  -- The labels staff see (src/lib/takedown-reasons.ts); the report's
  -- admin_notes get the label, the takedown row the code.
  v_reason_label := case p_reason
    when 'copyright' then 'Copyright complaint'
    when 'content_rules' then 'Breaks content rules'
    when 'broken_file' then 'Wrong or broken file'
    when 'author_asked' then 'Author asked'
    when 'other' then 'Other'
  end;
  if v_reason_label is null then
    raise exception 'invalid reason';
  end if;

  v_message := pg_catalog.btrim(coalesce(p_message, ''), E' \t\r\n');
  if pg_catalog.char_length(v_message) < 1 or pg_catalog.char_length(v_message) > 2000 then
    raise exception 'invalid message';
  end if;

  -- Lock order: the published bundles holding the book (by id), then the
  -- book -- update_bundle_with_membership locks a bundle, then its books.
  perform 1
    from public.bundles b
   where b.status = 'published'
     and exists (
       select 1 from public.bundle_books bb
        where bb.bundle_id = b.id and bb.book_id = p_book_id
     )
   order by b.id
     for update of b;

  select bo.title, bo.author_id, bo.librum_choice_at is not null
    into v_title, v_author_id, v_choice_cleared
    from public.books bo
   where bo.id = p_book_id
     for update;

  if not found then
    raise exception 'no book found for this id';
  end if;

  if exists (
    select 1 from public.book_takedowns t
     where t.book_id = p_book_id and t.lifted_at is null
  ) then
    raise exception 'this book is already taken down';
  end if;

  if p_report_id is not null then
    perform 1
      from public.book_reports r
     where r.id = p_report_id
       and r.book_id = p_book_id
       and r.status = 'open'
       for update;
    if not found then
      raise exception 'no open report for this book';
    end if;
  end if;

  -- Re-selected under the book lock, so a bundle published between the
  -- two lock steps is drafted too. Exactly this set is drafted and
  -- recorded.
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'::uuid[])
    into v_bundle_ids
    from (
      select b.id
        from public.bundles b
       where b.status = 'published'
         and exists (
           select 1 from public.bundle_books bb
            where bb.bundle_id = b.id and bb.book_id = p_book_id
         )
       order by b.id
         for update of b
    ) x;

  update public.books
     set status = 'draft',
         librum_choice_at = null
   where id = p_book_id;

  -- ADMIN-3-REVIEW (10): a book waiting for review stops waiting.
  update public.book_reviews
     set status = 'cancelled',
         decided_at = pg_catalog.now()
   where book_id = p_book_id
     and status = 'pending';

  if pg_catalog.cardinality(v_bundle_ids) > 0 then
    update public.bundles
       set status = 'draft'
     where id = any (v_bundle_ids);
  end if;

  insert into public.book_takedowns (
    book_id, book_title, author_id, reason, message_to_author, report_id,
    bundle_ids, taken_down_by
  )
  values (
    p_book_id, v_title, v_author_id, p_reason, v_message, p_report_id,
    v_bundle_ids, v_actor_id
  )
  returning id into v_takedown_id;

  -- 5a: the report this came from is resolved exactly as
  -- review_book_report resolves one, with its own audit row.
  if p_report_id is not null then
    update public.book_reports
       set status = 'resolved',
           reviewed_at = pg_catalog.now(),
           reviewed_by = v_actor_id,
           admin_notes = v_reason_label
     where id = p_report_id
       and status = 'open';

    insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
    values (
      v_actor_id,
      'report.resolved',
      'book_reports',
      p_report_id,
      jsonb_build_object('old_status', 'open', 'new_status', 'resolved', 'notes_added', true)
    );
  end if;

  -- Never the message text itself.
  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id,
    'book.unpublished',
    'books',
    p_book_id,
    jsonb_build_object(
      'reason', p_reason,
      'report_id', p_report_id,
      'bundles_unpublished', pg_catalog.cardinality(v_bundle_ids),
      'librum_choice_cleared', v_choice_cleared
    )
  );

  return v_takedown_id;
end;
$$;

-- ------------------------------------------------------------
-- 10. Backfill (1a): books live now stay live, with no review.
-- ------------------------------------------------------------
insert into public.book_reviews (
  book_id, book_title, author_id, file_path, cover_path, status,
  grandfathered, submitted_at, decided_at
)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, 'approved',
       true, pg_catalog.now(), pg_catalog.now()
  from public.books bo
 where bo.status = 'published';

-- A1 = a (Q1/R3): drafts that readers may already hold also get one
-- approved, grandfathered row snapshotting their current title and
-- files, marked buyer_file_only. Readers keep that file (N2a) and it is
-- kept in storage (N3), but it never satisfies the publish gate, so the
-- draft goes through review before it is live again. Qualifying: a draft
-- with ANY purchases row (refunded, disputed, free claims and bundle
-- sales included), or one that was published before (published_at set),
-- or one with any takedown. Drafts never sold, published or taken down
-- get nothing. Exactly one row per qualifying draft.
insert into public.book_reviews (
  book_id, book_title, author_id, file_path, cover_path, status,
  grandfathered, submitted_at, decided_at, buyer_file_only
)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, 'approved',
       true, pg_catalog.now(), pg_catalog.now(), true
  from public.books bo
 where bo.status = 'draft'
   and (exists (select 1 from public.purchases pu where pu.book_id = bo.id)
        or bo.published_at is not null
        or exists (select 1 from public.book_takedowns t where t.book_id = bo.id));

-- ------------------------------------------------------------
-- 11. Storage: final manuscript keys are server-written only
-- ------------------------------------------------------------
drop policy "Authors can upload their own manuscripts" on storage.objects;
drop policy "Authors can replace their own manuscripts" on storage.objects;
drop policy "Authors can delete their own manuscripts" on storage.objects;

create policy "Authors can upload their own manuscripts"
  on storage.objects for insert
  with check (bucket_id = 'manuscripts'
              and auth.uid()::text = (storage.foldername(name))[1]
              and (storage.foldername(name))[2] = 'tmp');

create policy "Authors can replace their own manuscripts"
  on storage.objects for update
  using (bucket_id = 'manuscripts'
         and auth.uid()::text = (storage.foldername(name))[1]
         and (storage.foldername(name))[2] = 'tmp')
  with check (bucket_id = 'manuscripts'
              and auth.uid()::text = (storage.foldername(name))[1]
              and (storage.foldername(name))[2] = 'tmp');

create policy "Authors can delete their own manuscripts"
  on storage.objects for delete
  using (bucket_id = 'manuscripts'
         and auth.uid()::text = (storage.foldername(name))[1]
         and (storage.foldername(name))[2] = 'tmp');

-- ------------------------------------------------------------
-- 12. Audit filter allow-lists
-- ------------------------------------------------------------
create or replace function public.list_admin_audit_events(
  p_action text default null,
  p_actor_id uuid default null,
  p_target_type text default null,
  p_created_after timestamptz default null,
  p_created_before timestamptz default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  actor_id uuid,
  actor_display_name text,
  action text,
  target_type text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('audit.view') then
    raise exception 'not authorized';
  end if;

  if p_action is not null and p_action not in (
    'staff.added', 'staff.role_changed', 'staff.removed',
    'report.resolved', 'report.dismissed',
    'refund.review_approved', 'refund.review_rejected',
    'refund.issuance_submitted',
    'blog_post.published', 'blog_post.unpublished', 'blog_post.deleted',
    'pen_name.links_removed',
    'book.unpublished', 'book.allowed_again',
    'book.review_approved', 'book.review_sent_back'
  ) then
    raise exception 'invalid action filter';
  end if;

  if p_target_type is not null and p_target_type not in (
    'staff_members', 'book_reports', 'refund_requests', 'blog_posts',
    'pen_names', 'books'
  ) then
    raise exception 'invalid target_type filter';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  if p_created_after is not null and p_created_before is not null
     and p_created_after >= p_created_before then
    raise exception 'invalid date range';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      aal.id,
      aal.actor_id,
      p.display_name as actor_display_name,
      aal.action,
      aal.target_type,
      aal.target_id,
      aal.metadata,
      aal.created_at
    from public.admin_audit_log aal
    left join public.profiles p on p.id = aal.actor_id
    where (p_action is null or aal.action = p_action)
      and (p_actor_id is null or aal.actor_id = p_actor_id)
      and (p_target_type is null or aal.target_type = p_target_type)
      and (p_created_after is null or aal.created_at >= p_created_after)
      and (p_created_before is null or aal.created_at < p_created_before)
      and (
        p_cursor_created_at is null
        or (aal.created_at, aal.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by aal.created_at desc, aal.id desc
    limit v_limit;
end;
$$;
