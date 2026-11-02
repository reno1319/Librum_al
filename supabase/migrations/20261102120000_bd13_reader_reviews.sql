-- ============================================================
-- BD13 (migration 20261102120000): reader reviews get a public display
-- name, staff approval before they appear, and a verified-purchase
-- badge. Renato's answers 2026-11-01 (1b 2b 3a 4a 5a) and 2026-11-02
-- (Q1a Q2a Q3a Q4a Q5b Q6a Q7a):
--
--   * Every reviewer shows one public name per account
--     (profiles.review_name), chosen on the first review (Q2a). Only
--     staff change or clear it afterwards; a rejection for an
--     unsuitable name clears it, so the reader picks a new one when
--     they send the review again.
--   * Every new or changed review waits for staff (3a). An edit of a
--     published review takes it off the page until it is approved
--     again (Q1a). An identical resubmission of an approved review
--     changes nothing.
--   * Owner, admin and moderator decide (Q3a): exactly the roles
--     staff_has_permission('reports.resolve') allows, so no new
--     permission is added and that function is not touched.
--   * A rejection carries a reason from a fixed list plus an optional
--     note ('other' requires the note) (Q6a). "Negative" is not a
--     reason. The reader sees it on the book page (Q4a); no email.
--   * public_reviews shows approved reviews only, the chosen name only,
--     and two new last columns: `verified` (the reviewer paid more than
--     0 lek for this book, not refunded and not lost in a chargeback;
--     Q7a: a bundle share counts, a free claim or a 100% discount code
--     does not) and `reviewer_is_author` (the "Autor në Librum" tag,
--     frozen at approval).
--
-- Readers no longer write public.reviews directly: INSERT and UPDATE
-- are revoked from authenticated and every write goes through
-- submit_reader_review(), which checks ownership (user_owns_book()),
-- refuses the book's own author, validates the name and the text, and
-- always lands a changed review as 'pending'. The old insert/update
-- policies stay (they guard nothing now that the grants are gone).
--
-- Reviews that exist before this migration are kept as 'approved' (on
-- Staging and Production they are test data; BD8 deletes Production's).
-- ============================================================

-- ------------------------------------------------------------
-- 1. The public name, one per account
-- ------------------------------------------------------------
alter table public.profiles
  add column review_name text
    constraint profiles_review_name_check
    check (review_name is null
           or (char_length(review_name) between 2 and 40
               and review_name = btrim(review_name)
               and review_name !~ '[[:cntrl:]]'));

-- ------------------------------------------------------------
-- 2. Review status
-- ------------------------------------------------------------
-- Added with default 'approved' so every existing row is kept as
-- published, then the default becomes 'pending' for every new row.
alter table public.reviews
  add column status text not null default 'approved'
    constraint reviews_status_check
    check (status in ('pending', 'approved', 'rejected'));

alter table public.reviews alter column status set default 'pending';

alter table public.reviews
  add column rejection_reason text
    constraint reviews_rejection_reason_check
    check (rejection_reason is null
           or rejection_reason in ('abusive', 'personal_data', 'off_topic',
                                   'advertising', 'bad_name', 'other'));

alter table public.reviews
  add column rejection_note text
    constraint reviews_rejection_note_check
    check (rejection_note is null
           or (char_length(rejection_note) between 1 and 500
               and rejection_note = btrim(rejection_note)));

alter table public.reviews
  add column updated_at timestamptz not null default now();

update public.reviews set updated_at = created_at;

-- A reason exactly when rejected; a note only with a reason, and always
-- with 'other'.
alter table public.reviews
  add constraint reviews_rejection_consistent_check
    check ((status = 'rejected') = (rejection_reason is not null)
           and (rejection_note is null or rejection_reason is not null)
           and (rejection_reason is distinct from 'other' or rejection_note is not null));

-- 2b. The "Autor në Librum" tag (Renato's a, 2026-11-02, after audit r2
-- N1; frozen per his a after audit r3 F1). Set by
-- staff_approve_reader_review() from profiles.role at that moment and
-- never recomputed, so it never flips on an already-published review
-- when the reviewer later becomes an author or publishes, unpublishes
-- or loses a book: there is no public moment to line up with a pen
-- name. The page shows a neutral tag, never which pen name. Existing
-- rows get false.
alter table public.reviews
  add column reviewer_is_author boolean not null default false;

create index reviews_pending_idx
  on public.reviews (updated_at)
  where status = 'pending';

-- Readers write only through submit_reader_review() below.
revoke insert, update on public.reviews from authenticated;

-- ------------------------------------------------------------
-- 3. The public read path: approved only, the chosen name, the badge
-- ------------------------------------------------------------
-- reviewer_name: the account's review_name only, else null and the
-- page shows "Një lexues i Librum". Never the author's pen name: the
-- reviewer chooses the public name (1b, 2b), and a name staff cleared
-- must not fall back to a pen name the reviewer did not choose to show
-- (audit r1 R1).
-- reviewer_is_author: copied from reviews (section 2b), frozen when
-- staff approved the review.
-- verified: a paid purchase (amount > 0), not refunded and not lost in
-- a chargeback -- the same rule as user_owns_book() (Q7a, audit r1 S1).
-- payment_disputes is read directly: a view's function calls are
-- checked against the caller, and payment_intent_has_lost_dispute() is
-- not granted to anon or authenticated.
create or replace view public.public_reviews
  with (security_barrier)
as
  select r.id, r.book_id, r.rating, r.body, r.created_at,
         (select p.review_name from public.profiles p where p.id = r.reader_id) as reviewer_name,
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
    );

-- ------------------------------------------------------------
-- 4. The reader's write: submit_reader_review()
-- ------------------------------------------------------------
-- Returns one word the app turns into a message:
--   'pending'      saved, waiting for staff
--   'unchanged'    identical to the approved review; nothing changed
--   'not_owner'    the caller does not own the book
--   'own_book'     the caller is the book's author
--   'bad_rating'   not 1..5
--   'too_long'     text over 4,000 characters
--   'name_required' no name on the account and none given
--   'bad_name'     the given name breaks the rules (2..40, no control
--                  characters) after trimming
create function public.submit_reader_review(
  p_book_id uuid,
  p_rating integer,
  p_body text,
  p_review_name text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := pg_catalog.btrim(coalesce(p_body, ''));
  v_name text;
  v_given text := pg_catalog.btrim(coalesce(p_review_name, ''));
  v_existing public.reviews%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    return 'bad_rating';
  end if;

  if pg_catalog.char_length(v_body) > 4000 then
    return 'too_long';
  end if;

  if exists (select 1 from public.books b where b.id = p_book_id and b.author_id = v_uid) then
    return 'own_book';
  end if;

  if not public.user_owns_book(p_book_id) then
    return 'not_owner';
  end if;

  select * into v_existing
    from public.reviews
   where book_id = p_book_id and reader_id = v_uid
     for update;

  -- An identical resubmission of an approved review is a no-op, even
  -- for a review kept from before BD13 whose account has no name yet.
  if found
     and v_existing.status = 'approved'
     and v_existing.rating = p_rating
     and v_existing.body = v_body then
    return 'unchanged';
  end if;

  select review_name into v_name from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'no profile for this account';
  end if;

  if v_name is null then
    if v_given = '' then
      return 'name_required';
    end if;
    if pg_catalog.char_length(v_given) < 2
       or pg_catalog.char_length(v_given) > 40
       or v_given ~ '[[:cntrl:]]' then
      return 'bad_name';
    end if;
    update public.profiles set review_name = v_given where id = v_uid;
  end if;

  if v_existing.id is not null then
    update public.reviews
       set rating = p_rating,
           body = v_body,
           status = 'pending',
           rejection_reason = null,
           rejection_note = null,
           updated_at = now()
     where id = v_existing.id;
  else
    insert into public.reviews (book_id, reader_id, rating, body, status, updated_at)
    values (p_book_id, v_uid, p_rating, v_body, 'pending', now());
  end if;

  return 'pending';
end;
$$;

revoke all on function public.submit_reader_review(uuid, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.submit_reader_review(uuid, integer, text, text) to authenticated;

-- ------------------------------------------------------------
-- 5. Staff: the queue, approve, reject, set or clear a name
-- ------------------------------------------------------------
-- Each checks staff_has_permission('reports.resolve') (owner, admin,
-- moderator) and writes admin_audit_log, like
-- staff_remove_pen_name_links(). Approve and reject take the
-- updated_at the staff member saw, so a review the reader changed in
-- the meantime is never decided unseen ('changed').

create function public.staff_list_pending_reader_reviews()
returns table (
  review_id uuid,
  book_id uuid,
  book_title text,
  reader_id uuid,
  rating integer,
  body text,
  review_name text,
  updated_at timestamptz,
  account_created_at timestamptz,
  email_confirmed boolean,
  reviews_total bigint,
  reviews_approved bigint,
  verified boolean,
  reviewer_is_author boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  return query
    select r.id, r.book_id, b.title, r.reader_id, r.rating, r.body,
           p.review_name, r.updated_at, p.created_at,
           u.email_confirmed_at is not null,
           (select count(*) from public.reviews r2 where r2.reader_id = r.reader_id),
           (select count(*) from public.reviews r2
             where r2.reader_id = r.reader_id and r2.status = 'approved'),
           exists (
             select 1 from public.purchases pu
              where pu.book_id = r.book_id
                and pu.reader_id = r.reader_id
                and pu.refunded_at is null
                and pu.amount_cents > 0
                and not public.payment_intent_has_lost_dispute(pu.stripe_payment_intent_id)
           ),
           exists (select 1 from public.books b2 where b2.author_id = r.reader_id)
      from public.reviews r
      join public.books b on b.id = r.book_id
      join public.profiles p on p.id = r.reader_id
      left join auth.users u on u.id = r.reader_id
     where r.status = 'pending'
     order by r.updated_at asc, r.id asc;
end;
$$;

create function public.staff_approve_reader_review(
  p_review_id uuid,
  p_seen_updated_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.reviews%rowtype;
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  select * into v_row from public.reviews where id = p_review_id for update;
  if not found then
    return 'not_found';
  end if;
  -- Staff never decide their own review (audit r1 S3).
  if v_row.reader_id = v_actor then
    return 'own_review';
  end if;
  if v_row.status <> 'pending' or v_row.updated_at is distinct from p_seen_updated_at then
    return 'changed';
  end if;

  update public.reviews
     set status = 'approved', rejection_reason = null, rejection_note = null,
         -- Frozen now, never recomputed (audit r3 F1).
         reviewer_is_author = coalesce(
           (select p.role = 'author' from public.profiles p where p.id = v_row.reader_id),
           false)
   where id = p_review_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'review.approved', 'reviews', p_review_id,
          pg_catalog.jsonb_build_object('book_id', v_row.book_id, 'rating', v_row.rating));

  return 'approved';
end;
$$;

create function public.staff_reject_reader_review(
  p_review_id uuid,
  p_seen_updated_at timestamptz,
  p_reason text,
  p_note text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.reviews%rowtype;
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  if p_reason is null
     or p_reason not in ('abusive', 'personal_data', 'off_topic',
                         'advertising', 'bad_name', 'other') then
    return 'bad_reason';
  end if;
  if p_reason = 'other' and v_note is null then
    return 'note_required';
  end if;
  if v_note is not null and pg_catalog.char_length(v_note) > 500 then
    return 'note_too_long';
  end if;

  select * into v_row from public.reviews where id = p_review_id for update;
  if not found then
    return 'not_found';
  end if;
  -- Staff never decide their own review (audit r1 S3).
  if v_row.reader_id = v_actor then
    return 'own_review';
  end if;
  if v_row.status <> 'pending' or v_row.updated_at is distinct from p_seen_updated_at then
    return 'changed';
  end if;

  update public.reviews
     set status = 'rejected', rejection_reason = p_reason, rejection_note = v_note
   where id = p_review_id;

  -- An unsuitable name is cleared, so the reader chooses a new one when
  -- they send the review again (Q2a: readers cannot change it otherwise).
  if p_reason = 'bad_name' then
    update public.profiles set review_name = null where id = v_row.reader_id;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'review.rejected', 'reviews', p_review_id,
          pg_catalog.jsonb_build_object('book_id', v_row.book_id, 'reason', p_reason));

  return 'rejected';
end;
$$;

-- Staff change or clear a reader's public name (Q2a: the reader asks
-- support). Owner and admin only: it needs people.view (the People page
-- it lives on) as well as reports.resolve (audit r1 S4). A null or
-- empty p_name clears it. The person's approved
-- reviews show the new name at once; a cleared name makes them show
-- "Një lexues i Librum" until the reader reviews again.
create function public.staff_set_review_name(
  p_user_id uuid,
  p_name text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  v_old text;
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('reports.resolve')
     or not public.staff_has_permission('people.view') then
    raise exception 'not authorized';
  end if;

  if v_name is not null
     and (pg_catalog.char_length(v_name) < 2
          or pg_catalog.char_length(v_name) > 40
          or v_name ~ '[[:cntrl:]]') then
    return 'bad_name';
  end if;

  select review_name into v_old from public.profiles where id = p_user_id for update;
  if not found then
    return 'not_found';
  end if;

  update public.profiles set review_name = v_name where id = p_user_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor, case when v_name is null then 'review_name.cleared' else 'review_name.changed' end,
          'profiles', p_user_id,
          pg_catalog.jsonb_build_object('old_name', v_old, 'new_name', v_name));

  return 'saved';
end;
$$;

revoke all on function public.staff_list_pending_reader_reviews() from public, anon, authenticated, service_role;
revoke all on function public.staff_approve_reader_review(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.staff_reject_reader_review(uuid, timestamptz, text, text) from public, anon, authenticated, service_role;
revoke all on function public.staff_set_review_name(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.staff_list_pending_reader_reviews() to authenticated;
grant execute on function public.staff_approve_reader_review(uuid, timestamptz) to authenticated;
grant execute on function public.staff_reject_reader_review(uuid, timestamptz, text, text) to authenticated;
grant execute on function public.staff_set_review_name(uuid, text) to authenticated;
