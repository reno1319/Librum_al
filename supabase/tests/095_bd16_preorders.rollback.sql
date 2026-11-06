-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- BD16 P1 ROLLBACK: undoes the behaviour of migration
-- 20261106120000_bd16_preorders.sql. Puts back, exactly as they were
-- before it (same definitions; CREATE OR REPLACE keeps their grants),
-- the fifteen functions it restated, the books status CHECK and
-- book_pending_changes.file_path NOT NULL, and removes its six new
-- functions and the books_preorder_rules trigger.
--
-- It refuses to run while any book is a pre-order or any waiting change
-- has no manuscript (only a pre-order has one): take the pre-orders
-- back to draft first (the app's cancel), or do not roll back.
--
-- Deliberately NOT removed (the residue, no row changed): the five books
-- columns and their CHECKs, public_books.release_date (taking a column
-- out of the view means dropping it, and public_reviews and the
-- book_contributors SELECT policy depend on it), book_reviews.release_date
-- and its looser checklist CHECK (approved listings keep their
-- three-item checklist), account_suspensions.preorder_book_ids, and the
-- table preorder_notify_requests with its policy and grants (readers'
-- requests are kept). supabase/tests/095_bd16_preorders_residue.sql is
-- exactly this residue; the catalog harness compares a rolled-back
-- database against base + that file.
--
-- After a rollback a cancelled pre-order that never came out no longer
-- keeps its pen name and series public (BD14's rule again).
--
-- Run only together with the app revert. Safe to run more than once.

begin;

do $$
begin
  if exists (select 1 from public.books where status = 'preorder') then
    raise exception 'BD16 rollback: a book is still a pre-order; take it back to draft first';
  end if;
  if exists (select 1 from public.book_pending_changes where file_path is null) then
    raise exception 'BD16 rollback: a waiting change has no manuscript; discard it first';
  end if;
end $$;

-- The public rules and the view first.
create or replace function public.book_makes_pen_name_public(b public.books)
returns boolean
language sql
immutable
parallel safe
as $$
  select (b.status operator(pg_catalog.=) 'published'
          or b.published_at is not null)
     -- BD15 Q1: a public-domain edition shows its uploader only as an
     -- editor, and only when staff gave that mention.
     and (b.pd_work_id is null or b.pd_editor_credit)
$$;

create or replace function public.book_is_publicly_listed(b public.books)
returns boolean
language sql
immutable
parallel safe
as $$
  -- A published public-domain edition is always its work's picked one
  -- (books_check_published_pd_edition), so status alone decides.
  select b.status operator(pg_catalog.=) 'published'
$$;

create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at,
         -- BD15 P7: null on a public-domain edition without an editor
         -- mention, for every reader (its author too).
         b.public_pen_name_id as pen_name_id,
         b.original_author,
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit,
         -- BD16 P1 residue: a view column is not dropped (see the header).
         b.release_date
  from public.books b
  where public.book_is_publicly_listed(b)
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

create or replace function public.books_lock_after_first_publish()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.published_at is not null
     and pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
  then
    if new.published_at is distinct from old.published_at then
      raise exception 'A book''s first publication date never changes.'
        using errcode = 'LB482';
    end if;
    if new.title is distinct from old.title then
      raise exception 'The title of a published book can''t be changed. Write to Librum''s support to correct it.'
        using errcode = 'LB480';
    end if;
    if new.pen_name_id is distinct from old.pen_name_id then
      raise exception 'The pen name of a published book can''t be changed.'
        using errcode = 'LB481';
    end if;
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

create or replace function public.books_take_pending_changes_offline()
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

create or replace function public.book_pending_changes_require_live_book()
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

create or replace function public.book_rights_declarations_keep_live_basis()
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

create or replace function public.books_refuse_publish_while_author_suspended()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published'
     and exists (
       select 1
         from public.account_suspensions s
        where s.user_id = new.author_id
          and s.lifted_at is null
     )
  then
    raise exception 'This account is suspended. Its books can''t be published until Librum lifts the suspension.'
      using errcode = 'LB464';
  end if;
  return new;
end;
$$;

create or replace function public.books_refuse_publish_while_taken_down()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published'
     and exists (
       select 1
         from public.book_takedowns t
        where t.book_id = new.id
          and t.lifted_at is null
     )
  then
    raise exception 'Librum took this book down. It can''t be published again until Librum allows it.'
      using errcode = 'LB460';
  end if;
  return new;
end;
$$;

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

create or replace function public.admin_suspend_account(p_user_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_reason text;
  v_book_ids uuid[];
  v_bundle_ids uuid[];
  v_choice_cleared boolean;
  v_suspension_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('people.manage') then
    raise exception 'not authorized';
  end if;

  if p_user_id is null then
    raise exception 'no account found for this id';
  end if;

  if p_user_id = v_actor_id then
    raise exception 'you cannot suspend yourself';
  end if;

  v_reason := pg_catalog.btrim(coalesce(p_reason, ''), E' \t\r\n');
  if pg_catalog.char_length(v_reason) < 1 or pg_catalog.char_length(v_reason) > 2000 then
    raise exception 'invalid reason';
  end if;

  -- The profile first: two staff suspending at once queue here.
  perform 1 from public.profiles p where p.id = p_user_id for update;
  if not found then
    raise exception 'no account found for this id';
  end if;

  if exists (select 1 from public.staff_members sm where sm.user_id = p_user_id) then
    raise exception 'staff cannot be suspended';
  end if;

  if exists (
    select 1 from public.account_suspensions s
     where s.user_id = p_user_id and s.lifted_at is null
  ) then
    raise exception 'this account is already suspended';
  end if;

  -- Every bundle, then every book, of every status: a publish racing
  -- this waits on the row lock and is then refused by the LB464 trigger.
  perform 1 from public.bundles bu where bu.author_id = p_user_id order by bu.id for update;
  perform 1 from public.books bo where bo.author_id = p_user_id order by bo.id for update;

  select coalesce(pg_catalog.array_agg(bu.id order by bu.id), '{}'::uuid[])
    into v_bundle_ids
    from public.bundles bu
   where bu.author_id = p_user_id and bu.status = 'published';

  select coalesce(pg_catalog.array_agg(bo.id order by bo.id), '{}'::uuid[]),
         coalesce(pg_catalog.bool_or(bo.librum_choice_at is not null), false)
    into v_book_ids, v_choice_cleared
    from public.books bo
   where bo.author_id = p_user_id and bo.status = 'published';

  if pg_catalog.cardinality(v_bundle_ids) > 0 then
    update public.bundles
       set status = 'draft'
     where id = any (v_bundle_ids);
  end if;

  if pg_catalog.cardinality(v_book_ids) > 0 then
    update public.books
       set status = 'draft',
           librum_choice_at = null
     where id = any (v_book_ids);
  end if;

  insert into public.account_suspensions (user_id, reason, book_ids, bundle_ids, suspended_by)
  values (p_user_id, v_reason, v_book_ids, v_bundle_ids, v_actor_id)
  returning id into v_suspension_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id,
    'account.suspended',
    'profiles',
    p_user_id,
    pg_catalog.jsonb_build_object(
      'reason', v_reason,
      'books_unpublished', pg_catalog.cardinality(v_book_ids),
      'bundles_unpublished', pg_catalog.cardinality(v_bundle_ids),
      'librum_choice_cleared', v_choice_cleared
    )
  );

  return v_suspension_id;
end;
$$;

create or replace function public.admin_lift_suspension(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_suspension public.account_suspensions%rowtype;
  v_book_id uuid;
  v_bundle_id uuid;
  v_restored_books uuid[] := '{}';
  v_draft_books uuid[] := '{}';
  v_restored_bundles uuid[] := '{}';
  v_draft_bundles uuid[] := '{}';
  v_sessions_deleted integer;
  v_refresh_tokens_deleted integer;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('people.manage') then
    raise exception 'not authorized';
  end if;

  -- The profile first, as admin_suspend_account locks it.
  perform 1 from public.profiles p where p.id = p_user_id for update;

  select * into v_suspension
    from public.account_suspensions s
   where s.user_id = p_user_id and s.lifted_at is null
     for update;

  if v_suspension.id is null then
    raise exception 'this account is not suspended';
  end if;

  update public.account_suspensions
     set lifted_at = pg_catalog.now(),
         lifted_by = v_actor_id
   where id = v_suspension.id;

  -- SECURITY-9A: sign the account out everywhere before it can sign in
  -- again (r2 audit F3, Renato "1. a"). While suspended nothing is
  -- deleted: the ban makes Supabase Auth answer "user is banned" to
  -- every refresh and Auth call, for active and idle devices alike, so
  -- the site's "This account is suspended" cut-off always shows. Here,
  -- in the same transaction as the lift and before the site removes the
  -- ban (src/app/admin/(protected)/people/[id]/actions.ts), every
  -- refresh token of the account goes (by user, so tokens without a
  -- session go too) and then every session (which also ends refresh
  -- tokens kept on the session row itself), so no device resumes after
  -- Lift; an old device finds itself signed out. An access token
  -- already issued stays valid until it expires (at most the JWT
  -- lifetime). auth.refresh_tokens.user_id is text in Supabase Auth.
  delete from auth.refresh_tokens rt where rt.user_id = p_user_id::text;
  get diagnostics v_refresh_tokens_deleted = row_count;
  delete from auth.sessions se where se.user_id = p_user_id;
  get diagnostics v_sessions_deleted = row_count;

  perform 1 from public.bundles bu where bu.author_id = p_user_id order by bu.id for update;
  perform 1 from public.books bo where bo.author_id = p_user_id order by bo.id for update;

  foreach v_book_id in array v_suspension.book_ids loop
    if exists (
         select 1 from public.books bo
          where bo.id = v_book_id
            and bo.author_id = p_user_id
            and bo.status = 'draft'
       )
       and not exists (
         select 1 from public.book_takedowns t
          where t.book_id = v_book_id and t.lifted_at is null
       )
    then
      begin
        update public.books set status = 'published' where id = v_book_id;
        v_restored_books := v_restored_books || v_book_id;
      exception when sqlstate 'LB462' then
        v_draft_books := v_draft_books || v_book_id;
      end;
    else
      v_draft_books := v_draft_books || v_book_id;
    end if;
  end loop;

  foreach v_bundle_id in array v_suspension.bundle_ids loop
    if exists (
         select 1 from public.bundles bu
          where bu.id = v_bundle_id
            and bu.author_id = p_user_id
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
      v_restored_bundles := v_restored_bundles || v_bundle_id;
    else
      v_draft_bundles := v_draft_bundles || v_bundle_id;
    end if;
  end loop;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id,
    'account.suspension_lifted',
    'profiles',
    p_user_id,
    pg_catalog.jsonb_build_object(
      'books_restored', pg_catalog.cardinality(v_restored_books),
      'books_kept_draft', pg_catalog.cardinality(v_draft_books),
      'bundles_restored', pg_catalog.cardinality(v_restored_bundles),
      'bundles_kept_draft', pg_catalog.cardinality(v_draft_bundles),
      'sessions_deleted', v_sessions_deleted,
      'refresh_tokens_deleted', v_refresh_tokens_deleted
    )
  );

  return pg_catalog.jsonb_build_object(
    'restored_book_ids', pg_catalog.to_jsonb(v_restored_books),
    'draft_book_ids', pg_catalog.to_jsonb(v_draft_books),
    'restored_bundle_ids', pg_catalog.to_jsonb(v_restored_bundles),
    'draft_bundle_ids', pg_catalog.to_jsonb(v_draft_bundles)
  );
end;
$$;

drop trigger if exists books_preorder_rules on public.books;
drop function if exists public.books_preorder_rules();
drop function if exists public.run_preorder_day(date);
drop function if exists public.push_preorder_release_date(uuid, date);
drop function if exists public.preorder_notify_remove(uuid);
drop function if exists public.preorder_notify_me(uuid);
drop function if exists public.tirana_today();

alter table public.books
  drop constraint if exists books_status_check,
  add constraint books_status_check
    check (status in ('draft', 'published'));

alter table public.book_pending_changes
  alter column file_path set not null;

commit;
