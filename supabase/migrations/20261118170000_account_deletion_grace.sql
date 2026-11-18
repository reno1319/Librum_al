-- DEL (Renato 11-18, del1 a .. del7 b): account deletion with 30 days to
-- change your mind.
--
-- Pressing delete no longer deletes at once. It
--   * hides the account from everyone: its published books, bundles and
--     live pre-orders go offline exactly as a suspension takes them
--     (admin_suspend_account), its pen names, series and reviews leave
--     the public views (del3 a);
--   * signs the account out everywhere;
--   * saves the optional "why are you leaving?" answer with no account
--     id (del4 a);
--   * and schedules the real deletion 30 days later (del6 a).
-- Signing in during those days shows only a Restore page (del2 b);
-- Restore brings the books, bundles and pre-orders back exactly as
-- admin_lift_suspension does. On day 30 the daily job deletes the
-- account the way deleteAccount always did (the app, as the service
-- role, after account_deletion_claim).
--
-- Reviews (del7 b): a deleted reader's APPROVED reviews stay, with the
-- review name they had; their not-yet-approved ones go with the account,
-- since nobody could decide them afterwards. reviews.reader_id becomes
-- nullable, ON DELETE SET NULL; a BEFORE DELETE trigger on profiles keeps
-- the name in reviews.deleted_reader_review_name first.
--
-- Rules that do not change: staff can't delete their own account; an
-- author any of whose books was ever acquired can't delete (purchases
-- ON DELETE RESTRICT stays the real guarantee).

-- ------------------------------------------------------------
-- 1. The pending deletions
-- ------------------------------------------------------------
create table public.account_deletion_requests (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  requested_at timestamptz not null default now(),
  delete_after timestamptz not null,
  -- What went offline, so Restore brings back exactly that.
  book_ids uuid[] not null default '{}',
  bundle_ids uuid[] not null default '{}',
  preorder_book_ids uuid[] not null default '{}',
  -- Set by the daily job as it starts the real deletion; Restore is
  -- refused from then on.
  processing_at timestamptz,
  constraint account_deletion_requests_after_check check (delete_after > requested_at)
);

create index account_deletion_requests_delete_after_idx
  on public.account_deletion_requests (delete_after);

alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public, anon, authenticated, service_role;
grant select on public.account_deletion_requests to service_role;

-- ------------------------------------------------------------
-- 2. Why people leave: no account id, no time of day (del4 a)
-- ------------------------------------------------------------
create table public.account_deletion_feedback (
  id uuid primary key default gen_random_uuid(),
  reason text
    constraint account_deletion_feedback_reason_check
    check (reason is null
           or reason in ('not_using', 'no_books', 'privacy', 'other_account', 'other')),
  note text
    constraint account_deletion_feedback_note_check
    check (note is null
           or (char_length(note) between 1 and 500 and note = btrim(note))),
  created_on date not null default current_date,
  constraint account_deletion_feedback_something_check check (reason is not null or note is not null)
);

alter table public.account_deletion_feedback enable row level security;
revoke all on public.account_deletion_feedback from public, anon, authenticated, service_role;
grant select on public.account_deletion_feedback to service_role;

-- ------------------------------------------------------------
-- 3. Reviews outlive a deleted reader (del7 b)
-- ------------------------------------------------------------
alter table public.reviews
  alter column reader_id drop not null;

alter table public.reviews
  drop constraint reviews_reader_id_fkey;

alter table public.reviews
  add constraint reviews_reader_id_fkey
  foreign key (reader_id) references public.profiles(id) on delete set null;

alter table public.reviews
  add column deleted_reader_review_name text;

create function public.profiles_keep_approved_reviews()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.reviews
   where reader_id = old.id
     and status <> 'approved';
  update public.reviews
     set deleted_reader_review_name = old.review_name
   where reader_id = old.id;
  return old;
end;
$$;

create trigger profiles_keep_approved_reviews
  before delete on public.profiles
  for each row
  execute function public.profiles_keep_approved_reviews();

revoke all on function public.profiles_keep_approved_reviews()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. The public views hide a pending account (del3 a). Same columns,
-- so CREATE OR REPLACE keeps every grant; only the deletion clause (and
-- the kept review name) is new.
-- ------------------------------------------------------------
create or replace view public.public_reviews
  with (security_barrier)
as
  select r.id, r.book_id, r.rating, r.body, r.created_at,
         coalesce(
           (select p.review_name from public.profiles p where p.id = r.reader_id),
           r.deleted_reader_review_name
         ) as reviewer_name,
         exists (
           select 1 from public.purchases pu
            where pu.book_id = r.book_id
              and pu.reader_id = r.reader_id
              and pu.refunded_at is null
              and pu.amount_cents > 0
              and not exists (
                select 1 from public.payment_disputes d
                 where d.stripe_payment_intent_id = pu.stripe_payment_intent_id
                   and d.status = 'lost'
              )
         ) as verified,
         r.reviewer_is_author
  from public.reviews r
  where r.status = 'approved'
    and exists (select 1 from public.public_books pb where pb.id = r.book_id)
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = r.reader_id and sus.lifted_at is null
    )
    and not exists (
      select 1 from public.account_deletion_requests del
       where del.user_id = r.reader_id
    );

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
                       and (b.pd_work_id is null or b.pd_editor_credit)
                       and public.user_owns_book(b.id)))
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = pn.author_id and sus.lifted_at is null
    )
    and not exists (
      select 1 from public.account_deletion_requests del
       where del.user_id = pn.author_id
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
    )
    and not exists (
      select 1 from public.account_deletion_requests del
       where del.user_id = s.author_id
    );

-- ------------------------------------------------------------
-- 5. Nothing of a pending account goes live again except through Restore
-- ------------------------------------------------------------
create function public.books_refuse_publish_while_deletion_pending()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('published', 'preorder')
     and exists (
       select 1 from public.account_deletion_requests d
        where d.user_id = new.author_id
     )
  then
    raise exception 'This account is being deleted. Restore it before publishing.'
      using errcode = 'LB518';
  end if;
  return new;
end;
$$;

create trigger books_refuse_publish_while_deletion_pending
  before insert or update of status on public.books
  for each row
  execute function public.books_refuse_publish_while_deletion_pending();

revoke all on function public.books_refuse_publish_while_deletion_pending()
  from public, anon, authenticated, service_role;

create function public.bundles_refuse_publish_while_deletion_pending()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published'
     and exists (
       select 1 from public.account_deletion_requests d
        where d.user_id = new.author_id
     )
  then
    raise exception 'This account is being deleted. Restore it before publishing.'
      using errcode = 'LB518';
  end if;
  return new;
end;
$$;

create trigger bundles_refuse_publish_while_deletion_pending
  before insert or update of status on public.bundles
  for each row
  execute function public.bundles_refuse_publish_while_deletion_pending();

revoke all on function public.bundles_refuse_publish_while_deletion_pending()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Asking to delete
-- ------------------------------------------------------------
-- Returns the time the account will really be deleted. Refusals are
-- raised with their own codes so the page can say why:
--   LB519 staff, LB520 already pending, LB521 suspended,
--   LB522 a book of this account was acquired, LB523 bad feedback.
create function public.request_account_deletion(
  p_reason text,
  p_note text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_note text;
  v_book_ids uuid[];
  v_bundle_ids uuid[];
  v_preorder_ids uuid[];
  v_delete_after timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  v_note := nullif(pg_catalog.btrim(coalesce(p_note, ''), E' \t\r\n'), '');
  if (p_reason is not null
      and p_reason not in ('not_using', 'no_books', 'privacy', 'other_account', 'other'))
     or pg_catalog.char_length(coalesce(v_note, '')) > 500
  then
    raise exception 'invalid feedback' using errcode = 'LB523';
  end if;

  -- The profile first, as admin_suspend_account locks it.
  perform 1 from public.profiles p where p.id = v_uid for update;
  if not found then
    raise exception 'no account found';
  end if;

  if exists (select 1 from public.staff_members sm where sm.user_id = v_uid) then
    raise exception 'staff cannot delete their account' using errcode = 'LB519';
  end if;
  if exists (select 1 from public.account_deletion_requests d where d.user_id = v_uid) then
    raise exception 'this account is already being deleted' using errcode = 'LB520';
  end if;
  if exists (
    select 1 from public.account_suspensions s
     where s.user_id = v_uid and s.lifted_at is null
  ) then
    raise exception 'this account is suspended' using errcode = 'LB521';
  end if;

  -- Every bundle, then every book, of every status, as a suspension.
  perform 1 from public.bundles bu where bu.author_id = v_uid order by bu.id for update;
  perform 1 from public.books bo where bo.author_id = v_uid order by bo.id for update;

  if exists (
    select 1 from public.purchases pu
      join public.books bo on bo.id = pu.book_id
     where bo.author_id = v_uid
  ) then
    raise exception 'a book of this account was acquired' using errcode = 'LB522';
  end if;

  select coalesce(pg_catalog.array_agg(bu.id order by bu.id), '{}'::uuid[])
    into v_bundle_ids
    from public.bundles bu
   where bu.author_id = v_uid and bu.status = 'published';

  select coalesce(pg_catalog.array_agg(bo.id order by bo.id), '{}'::uuid[])
    into v_book_ids
    from public.books bo
   where bo.author_id = v_uid and bo.status = 'published';

  select coalesce(pg_catalog.array_agg(bo.id order by bo.id), '{}'::uuid[])
    into v_preorder_ids
    from public.books bo
   where bo.author_id = v_uid and bo.status = 'preorder';

  if pg_catalog.cardinality(v_bundle_ids) > 0 then
    update public.bundles set status = 'draft' where id = any (v_bundle_ids);
  end if;

  if pg_catalog.cardinality(v_book_ids) > 0 then
    update public.books
       set status = 'draft',
           librum_choice_at = null
     where id = any (v_book_ids);
  end if;

  -- Paused, not cancelled: Restore brings them back.
  if pg_catalog.cardinality(v_preorder_ids) > 0 then
    perform pg_catalog.set_config('librum.preorder_write', 'pause', true);
    update public.books
       set status = 'draft',
           librum_choice_at = null
     where id = any (v_preorder_ids);
    perform pg_catalog.set_config('librum.preorder_write', '', true);
  end if;

  v_delete_after := pg_catalog.now() + interval '30 days';

  insert into public.account_deletion_requests
    (user_id, delete_after, book_ids, bundle_ids, preorder_book_ids)
  values (v_uid, v_delete_after, v_book_ids, v_bundle_ids, v_preorder_ids);

  if p_reason is not null or v_note is not null then
    insert into public.account_deletion_feedback (reason, note)
    values (p_reason, v_note);
  end if;

  -- Signed out everywhere, so a phone left signed in shows the Restore
  -- page at most, never the account (as admin_lift_suspension does).
  delete from auth.refresh_tokens rt where rt.user_id = v_uid::text;
  delete from auth.sessions se where se.user_id = v_uid;

  return v_delete_after;
end;
$$;

revoke all on function public.request_account_deletion(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_account_deletion(text, text) to authenticated;

-- ------------------------------------------------------------
-- 7. Restore (del2 b): brings back what went offline, as
-- admin_lift_suspension does. Returns 'restored', 'not_pending',
-- 'too_late' (the real deletion has started) or 'suspended'.
-- ------------------------------------------------------------
create function public.restore_my_account()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_request public.account_deletion_requests%rowtype;
  v_book_id uuid;
  v_bundle_id uuid;
  v_cancelled_preorders uuid[] := '{}';
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  perform 1 from public.profiles p where p.id = v_uid for update;

  select * into v_request
    from public.account_deletion_requests d
   where d.user_id = v_uid
     for update;

  if v_request.user_id is null then
    return 'not_pending';
  end if;
  if v_request.processing_at is not null then
    return 'too_late';
  end if;
  if exists (
    select 1 from public.account_suspensions s
     where s.user_id = v_uid and s.lifted_at is null
  ) then
    return 'suspended';
  end if;

  delete from public.account_deletion_requests where user_id = v_uid;

  perform 1 from public.bundles bu where bu.author_id = v_uid order by bu.id for update;
  perform 1 from public.books bo where bo.author_id = v_uid order by bo.id for update;

  foreach v_book_id in array v_request.book_ids loop
    if exists (
         select 1 from public.books bo
          where bo.id = v_book_id
            and bo.author_id = v_uid
            and bo.status = 'draft'
       )
       and not exists (
         select 1 from public.book_takedowns t
          where t.book_id = v_book_id and t.lifted_at is null
       )
    then
      begin
        update public.books set status = 'published' where id = v_book_id;
      exception when sqlstate 'LB462' then
        null; -- stays a draft
      end;
    end if;
  end loop;

  foreach v_book_id in array v_request.preorder_book_ids loop
    if exists (
         select 1 from public.books bo
          where bo.id = v_book_id
            and bo.author_id = v_uid
            and bo.status = 'draft'
            and bo.release_date is not null
            and bo.preorder_listed_at is not null
       )
       and not exists (
         select 1 from public.book_takedowns t
          where t.book_id = v_book_id and t.lifted_at is null
       )
    then
      begin
        perform pg_catalog.set_config('librum.preorder_write', 'on', true);
        update public.books set status = 'preorder' where id = v_book_id;
      exception when sqlstate 'LB462' then
        v_cancelled_preorders := v_cancelled_preorders || v_book_id;
      end;
    else
      v_cancelled_preorders := v_cancelled_preorders || v_book_id;
    end if;
  end loop;

  if pg_catalog.cardinality(v_cancelled_preorders) > 0 then
    perform pg_catalog.set_config('librum.preorder_write', 'on', true);
    update public.books bo
       set file_path = c.file_path,
           cover_path = c.cover_path,
           description = c.description,
           is_adult = c.is_adult,
           original_author = c.original_author,
           reading_age_min = case when c.is_adult then 18 else bo.reading_age_min end
      from public.book_pending_changes c
     where c.book_id = bo.id
       and bo.id = any (v_cancelled_preorders)
       and bo.author_id = v_uid
       and bo.status = 'draft';
    delete from public.book_pending_changes c
     using public.books bo
     where bo.id = c.book_id
       and bo.id = any (v_cancelled_preorders)
       and bo.author_id = v_uid
       and bo.status = 'draft';
    update public.books
       set release_date = null,
           preorder_cancelled_at = pg_catalog.now()
     where id = any (v_cancelled_preorders)
       and author_id = v_uid
       and status = 'draft'
       and release_date is not null;
    update public.preorder_notify_requests
       set book_cancelled_at = pg_catalog.now()
     where book_id = any (v_cancelled_preorders)
       and notified_at is null
       and book_cancelled_at is null;
  end if;
  perform pg_catalog.set_config('librum.preorder_write', '', true);

  foreach v_bundle_id in array v_request.bundle_ids loop
    if exists (
         select 1 from public.bundles bu
          where bu.id = v_bundle_id
            and bu.author_id = v_uid
            and bu.status = 'draft'
       )
       and exists (select 1 from public.bundle_books bb where bb.bundle_id = v_bundle_id)
       and not exists (
         select 1
           from public.bundle_books bb
           join public.books bo on bo.id = bb.book_id
          where bb.bundle_id = v_bundle_id
            and bo.status <> 'published'
       )
    then
      update public.bundles set status = 'published' where id = v_bundle_id;
    end if;
  end loop;

  return 'restored';
end;
$$;

revoke all on function public.restore_my_account()
  from public, anon, authenticated, service_role;
grant execute on function public.restore_my_account() to authenticated;

-- ------------------------------------------------------------
-- 8. The per-request gate (src/lib/supabase/middleware.ts): one call
-- answers both questions. 'active', 'suspended' or 'deletion_pending'
-- (a suspension wins). my_account_is_suspended() stays for the app
-- version deployed before this one.
-- ------------------------------------------------------------
create function public.my_account_status()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then null
    when exists (
      select 1 from public.account_suspensions s
       where s.user_id = auth.uid() and s.lifted_at is null
    ) then 'suspended'
    when exists (
      select 1 from public.account_deletion_requests d
       where d.user_id = auth.uid()
    ) then 'deletion_pending'
    else 'active'
  end;
$$;

revoke all on function public.my_account_status()
  from public, anon, authenticated, service_role;
grant execute on function public.my_account_status() to authenticated;

-- The Restore page's date.
create function public.my_account_deletion_date()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select d.delete_after
    from public.account_deletion_requests d
   where d.user_id = auth.uid();
$$;

revoke all on function public.my_account_deletion_date()
  from public, anon, authenticated, service_role;
grant execute on function public.my_account_deletion_date() to authenticated;

-- ------------------------------------------------------------
-- 9. The daily job (service role) claims a due account before deleting
-- it; from then on Restore says 'too_late'. True only for a due row of
-- an account that is neither staff nor suspended now: someone made
-- staff, or suspended, during the 30 days is left as it is (Restore
-- still works), the same two rules request_account_deletion checks.
-- A row another run claimed less than an hour ago is refused too, so two
-- runs at once never work on the same account (AUDIT S2); a failed
-- deletion is claimed again by the next day's run.
-- ------------------------------------------------------------
create function public.account_deletion_claim(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.account_deletion_requests r
     set processing_at = pg_catalog.now()
   where r.user_id = p_user_id
     and r.delete_after <= pg_catalog.now()
     and (r.processing_at is null or r.processing_at < pg_catalog.now() - interval '1 hour')
     and not exists (select 1 from public.staff_members sm where sm.user_id = r.user_id)
     and not exists (
       select 1 from public.account_suspensions sus
        where sus.user_id = r.user_id and sus.lifted_at is null
     );
  return found;
end;
$$;

revoke all on function public.account_deletion_claim(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_claim(uuid) to service_role;
