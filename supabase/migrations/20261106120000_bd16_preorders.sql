-- ============================================================
-- BD16 P1 (migration 20261106120000): pre-orders ("Parapublikim"),
-- the database part. Plan: PLAN-BD16-r1.md sections 3.1-3.6 (6 Nov
-- 2026), with Renato's answers Q1 a, Q2 a, Q3 b + Q3b a, Q4 a, Q5 a.
-- This is the only BD16 migration; P2-P5 are app code.
--
-- What it adds:
--   1. books.status 'preorder', a third value. About 40 places allow
--      buying, downloading, bundles and reviews only for 'published', so
--      they keep refusing a pre-order with no change (fail closed).
--   2. books columns release_date, preorder_listed_at (set once, never
--      changes: it makes the pen name and series public "ever"),
--      preorder_slip_used, preorder_count (at most 2, Q3b a),
--      preorder_cancelled_at. The file due date is release_date - 3.
--   3. book_reviews.release_date: the date a pre-order listing review
--      asks for (null on every other review).
--   4. preorder_notify_requests ("Më njofto"): one row per reader and
--      book. A reader reads their own rows; adding and removing go
--      through preorder_notify_me() / preorder_notify_remove().
--   5. books_preorder_rules: only Librum's own functions move a book
--      into, out of (to published) or around a pre-order (LB503); a
--      pre-order is not deleted (LB507); when a pre-order ends (the
--      author's cancel, a second missed deadline, a staff takedown) its
--      date is cleared, preorder_cancelled_at is set and every waiting
--      reader's row is marked for the one "cancelled" email (Q4 a).
--   6. request_book_review(): a draft with a release_date asks for a
--      pre-order listing: 14 days to 6 months ahead (Q1 a, LB500), at
--      most 2 per book (LB501), never a public-domain book (D3, LB502);
--      the manuscript is optional (D5). A pre-order sends its waiting
--      changes like a live book; its manuscript stays optional until
--      the final file comes.
--   7. admin_approve_book_review(): approving a listing makes the book
--      a pre-order (refused when its date or file due date has passed,
--      LB506; a listing without a file has no "file opens" item); a
--      pre-order's changes are applied like a live book's, and a final
--      file approved on or after the release day releases the book at
--      once (BD15 Q3). Returns true only when the book was published
--      for the first time in this call (followers' email, D2).
--   8. push_preorder_release_date(): the author pushes the date once,
--      by up to 30 days, before the file due date; that is the slip
--      (Q2 a, LB504).
--   9. run_preorder_day(): the daily job's database step (service role
--      only, safe to run twice): releases due books with an approved
--      file, applies missed deadlines (first: +30 days, second: cancel;
--      a send-back gives 3 more days, Q5 a), lists overdue ones.
--  10. Suspension: a live pre-order is paused (back to draft, recorded
--      in account_suspensions.preorder_book_ids) and comes back as a
--      pre-order when the suspension is lifted; one that can't come
--      back ends as cancelled.
--  11. The public rules: book_is_publicly_listed and
--      book_makes_pen_name_public count a pre-order (still IMMUTABLE,
--      so the views keep inlining them), search_books lists pre-orders,
--      the title / pen name lock starts at the listing, a pre-order
--      keeps its rights basis, its waiting changes and the live guard
--      (LB463) work as for a live book, public_books shows release_date.
--
-- New SQLSTATEs: LB500-LB508.
--
-- Rollback: supabase/tests/095_bd16_preorders.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The new status value and columns
-- ------------------------------------------------------------
alter table public.books
  drop constraint books_status_check,
  add constraint books_status_check
    check (status in ('draft', 'published', 'preorder'));

alter table public.books
  -- The day (Tirana) the book comes out. On a draft it is the date the
  -- author asks for; on a pre-order the current release day.
  add column release_date date,
  add column preorder_listed_at timestamptz,
  add column preorder_slip_used boolean not null default false,
  add column preorder_count smallint not null default 0
    constraint books_preorder_count_check
    check (preorder_count between 0 and 2),
  add column preorder_cancelled_at timestamptz;

alter table public.books
  add constraint books_preorder_check
    check (status <> 'preorder'
           or (release_date is not null
               and preorder_listed_at is not null
               and preorder_count >= 1
               and pd_work_id is null));

alter table public.book_reviews
  add column release_date date,
  -- A listing sent without a manuscript is approved with no "file opens".
  drop constraint book_reviews_checklist_check,
  add constraint book_reviews_checklist_check
    check (checklist = '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}'::jsonb
           or (file_path is null
               and checklist = '{"cover_is_fine": true, "not_someone_elses_work": true, "rights_declared": true}'::jsonb));

alter table public.account_suspensions
  add column preorder_book_ids uuid[] not null default '{}';

-- Today in Tirana, where every pre-order date lives.
create function public.tirana_today()
returns date
language sql
stable
parallel safe
set search_path = ''
as $$
  select (pg_catalog.now() at time zone 'Europe/Tirane')::date
$$;

revoke all on function public.tirana_today()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2. "Më njofto"
-- ------------------------------------------------------------
create table public.preorder_notify_requests (
  book_id uuid not null references public.books(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Set by the job (P5) just before it sends this reader's one email.
  notified_at timestamptz,
  -- Set when the pre-order ended; the email is then the "cancelled" one.
  book_cancelled_at timestamptz,
  primary key (book_id, user_id)
);

create index preorder_notify_requests_user_id_idx
  on public.preorder_notify_requests (user_id);

alter table public.preorder_notify_requests enable row level security;

-- A reader reads their own rows ("Njoftimet e mia"); the author never
-- sees who asked. The job (service role) marks and clears rows.
revoke all on public.preorder_notify_requests from public, anon, authenticated, service_role;
grant select on public.preorder_notify_requests to authenticated;
grant select, update, delete on public.preorder_notify_requests to service_role;

create policy "Readers see their own pre-order notices"
  on public.preorder_notify_requests
  for select
  to authenticated
  using (auth.uid() = user_id);

create function public.preorder_notify_me(p_book_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_rows integer;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;
  -- FOR SHARE waits for a release or a cancel in flight.
  perform 1 from public.books bo
   where bo.id = p_book_id and bo.status = 'preorder'
     for share;
  if not found then
    raise exception 'This book is not a pre-order.'
      using errcode = 'LB508';
  end if;
  -- A row left by an earlier, cancelled pre-order of the same book
  -- becomes a fresh request.
  insert into public.preorder_notify_requests as n (book_id, user_id)
  values (p_book_id, v_actor_id)
  on conflict (book_id, user_id) do update
     set created_at = pg_catalog.now(),
         notified_at = null,
         book_cancelled_at = null
   where n.book_cancelled_at is not null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.preorder_notify_me(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.preorder_notify_me(uuid) to authenticated;

-- "Hiq". True when there was a row.
create function public.preorder_notify_remove(p_book_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_rows integer;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;
  delete from public.preorder_notify_requests
   where book_id = p_book_id and user_id = v_actor_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.preorder_notify_remove(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.preorder_notify_remove(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. Who may move a pre-order (LB503, LB507), and what ending one does
-- ------------------------------------------------------------
-- Librum's own functions set librum.preorder_write for their write:
-- 'on', or 'pause' for a suspension (the pre-order comes back on lift,
-- so nothing is cancelled). The app's roles without it may not touch a
-- pre-order's state; Librum's own SQL session (role none) is not checked.
create function public.books_preorder_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app boolean;
  v_write text;
begin
  v_app := pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role');
  v_write := coalesce(pg_catalog.current_setting('librum.preorder_write', true), '');

  if tg_op = 'DELETE' then
    -- An account deletion (a cascade) still deletes it.
    if v_app and pg_catalog.pg_trigger_depth() <= 1 and old.status = 'preorder' then
      raise exception 'Cancel the pre-order before deleting this book.'
        using errcode = 'LB507';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if v_app
       and (new.status = 'preorder' or new.preorder_listed_at is not null or new.preorder_count <> 0
            or new.preorder_slip_used or new.preorder_cancelled_at is not null)
    then
      raise exception 'A pre-order changes only through Librum''s pre-order steps.'
        using errcode = 'LB503';
    end if;
    return new;
  end if;

  -- Never, for anyone: a live book does not become a pre-order, and the
  -- first listing time never changes (like published_at, LB482).
  if old.status = 'published' and new.status = 'preorder' then
    raise exception 'A published book can''t become a pre-order.'
      using errcode = 'LB503';
  end if;
  if v_app and old.preorder_listed_at is not null
     and new.preorder_listed_at is distinct from old.preorder_listed_at then
    raise exception 'A pre-order changes only through Librum''s pre-order steps.'
      using errcode = 'LB503';
  end if;

  if v_app and v_write not in ('on', 'pause')
     and ((new.status = 'preorder' and old.status <> 'preorder')
          or (old.status = 'preorder' and new.status = 'published')
          or (new.preorder_listed_at, new.preorder_count, new.preorder_slip_used, new.preorder_cancelled_at)
             is distinct from
             (old.preorder_listed_at, old.preorder_count, old.preorder_slip_used, old.preorder_cancelled_at)
          or (old.status = 'preorder' and new.status = 'preorder'
              and new.release_date is distinct from old.release_date))
  then
    raise exception 'A pre-order changes only through Librum''s pre-order steps.'
      using errcode = 'LB503';
  end if;

  -- The pre-order ended (Q3 b, Q4 a). Its waiting review and changes go
  -- the way of any book going offline (books_take_pending_changes_offline).
  if old.status = 'preorder' and new.status = 'draft' and v_write <> 'pause' then
    new.release_date := null;
    new.preorder_cancelled_at := pg_catalog.now();
    update public.preorder_notify_requests
       set book_cancelled_at = pg_catalog.now()
     where book_id = old.id
       and notified_at is null
       and book_cancelled_at is null;
  end if;

  return new;
end;
$$;

create trigger books_preorder_rules
  before insert or update or delete on public.books
  for each row
  execute function public.books_preorder_rules();

revoke all on function public.books_preorder_rules()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. The public rules (still IMMUTABLE: the daily job, not now(),
--    turns a pre-order into a published book)
-- ------------------------------------------------------------
create or replace function public.book_makes_pen_name_public(b public.books)
returns boolean
language sql
immutable
parallel safe
as $$
  select (b.status operator(pg_catalog.=) 'published'
          or b.published_at is not null
          -- BD16: a live pre-order counts as published, "ever" (BD14 Q4a).
          or b.status operator(pg_catalog.=) 'preorder'
          or b.preorder_listed_at is not null)
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
  -- BD16 (D1): a pre-order is listed wherever books are.
  select b.status operator(pg_catalog.=) any (array['published', 'preorder'])
$$;

-- Same columns, one appended: CREATE OR REPLACE keeps every grant and
-- the policies that read it. Every column stays a plain books column.
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
         -- BD16 P1 (migration 20261106120000): appended last.
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
  -- BD16 (D1): pre-orders are found too.
  where books.status in ('published', 'preorder')
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
-- 5. A pre-order behaves like a live book for its locks
-- ------------------------------------------------------------
-- D4: title and pen name lock at the listing, like after a publish.
create or replace function public.books_lock_after_first_publish()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.published_at is not null or old.preorder_listed_at is not null)
     and pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
  then
    -- A pre-order gets its publication date when it comes out.
    if old.published_at is not null and new.published_at is distinct from old.published_at then
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
  -- BD16: a pre-order (and a pre-order coming out) is live too.
  if old.status in ('published', 'preorder')
     and new.status in ('published', 'preorder')
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
  -- BD16: a pre-order going back to draft too (a cancel, a pause).
  if old.status in ('published', 'preorder') and new.status = 'draft' then
    update public.book_reviews
       set status = 'cancelled',
           decided_at = pg_catalog.now()
     where book_id = old.id
       and status = 'pending';
    -- BD16 (audit r1 F1): a suspension pauses a pre-order. The book keeps
    -- its approved version and the waiting change stays saved, so the
    -- lift brings the pre-order back; the author sends it again then.
    if old.status = 'preorder'
       and coalesce(pg_catalog.current_setting('librum.preorder_write', true), '') = 'pause' then
      return new;
    end if;
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

-- A pre-order without its final file keeps waiting changes without one;
-- the file comes as a waiting change too.
alter table public.book_pending_changes
  alter column file_path drop not null;

create or replace function public.book_pending_changes_require_live_book()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_categories text[];
  v_file_path text;
begin
  if tg_op = 'UPDATE' and new.book_id is distinct from old.book_id then
    raise exception 'Pending changes belong to one book.'
      using errcode = 'LB491';
  end if;
  -- FOR SHARE waits for a book update in flight (an unpublish), so a
  -- pending row is never left behind by a book that just went offline.
  select bo.status, bo.categories, bo.file_path
    into v_status, v_categories, v_file_path
    from public.books bo
   where bo.id = new.book_id
     for share;
  if v_status is null or v_status not in ('published', 'preorder') then
    raise exception 'Only a live book keeps pending changes.'
      using errcode = 'LB491';
  end if;
  -- BD16: only a pre-order still waiting for its final file has none.
  if new.file_path is null and not (v_status = 'preorder' and v_file_path is null) then
    raise exception 'A live book''s waiting changes keep a manuscript.'
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
  -- BD16: a pre-order keeps its rights basis too.
  if v_status is null or v_status not in ('published', 'preorder') then
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

-- A pre-order is listed like a published book: never while its author
-- is suspended or the book is taken down.
create or replace function public.books_refuse_publish_while_author_suspended()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('published', 'preorder')
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
  if new.status in ('published', 'preorder')
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

-- A pre-order is listed only with Librum's approval of exactly what it
-- shows; a book that was a pre-order is published only with a
-- manuscript (a listing approved without one never publishes it).
create or replace function public.books_require_review_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('published', 'preorder')
     and old.status is distinct from new.status
     and (not public.book_review_approval_valid(new.id, new.file_path, new.cover_path, new.original_author,
                                                new.description, new.is_adult)
          or (new.status = 'published' and new.file_path is null and new.preorder_listed_at is not null))
  then
    raise exception 'This book needs Librum''s approval before it can be published.'
      using errcode = 'LB462';
  end if;
  return new;
end;
$$;

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
  v_release_date date;
  v_today date;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  select bo.id, bo.title, bo.author_id, bo.status, bo.file_path, bo.cover_path, bo.original_author,
         bo.description, bo.is_adult, bo.categories, bo.release_date, bo.preorder_count, bo.pd_work_id
    into v_book
    from public.books bo
   where bo.id = p_book_id
     for update;

  if not found or v_book.author_id is distinct from v_actor_id then
    raise exception 'no book found for this id';
  end if;

  if v_book.status not in ('draft', 'published', 'preorder') then
    raise exception 'this book is already published';
  end if;

  if exists (
    select 1 from public.book_takedowns t
     where t.book_id = p_book_id and t.lifted_at is null
  ) then
    raise exception 'Librum took this book down. It can''t be published again until Librum allows it.'
      using errcode = 'LB460';
  end if;

  v_release_date := null;
  if v_book.status in ('published', 'preorder') then
    -- BD15 P5b-1: a live book sends its pending changes; it stays live.
    -- BD16: so does a pre-order (its final file comes this way).
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
    if v_book.release_date is not null then
      -- BD16: a draft with a release date asks for a pre-order listing.
      if v_book.preorder_count >= 2 then
        raise exception 'This book has had its 2 pre-orders. It can still be published normally.'
          using errcode = 'LB501';
      end if;
      if v_book.pd_work_id is not null
         or (select d.basis
               from public.book_rights_declarations d
              where d.book_id = p_book_id
              order by d.declared_at desc, d.id desc
              limit 1) = 'public_domain'
      then
        raise exception 'A public-domain book can''t be a pre-order.'
          using errcode = 'LB502';
      end if;
      v_today := public.tirana_today();
      if v_book.release_date < v_today + 14
         or v_book.release_date > (v_today + interval '6 months')::date
      then
        raise exception 'A pre-order''s release date is 14 days to 6 months from today.'
          using errcode = 'LB500';
      end if;
      v_release_date := v_book.release_date;
    elsif public.book_review_approval_valid(p_book_id, v_file_path, v_cover_path, v_original_author,
                                            v_description, v_is_adult) then
      raise exception 'this book is already approved';
    end if;
  end if;

  -- BD15 P5a: the Content tab's three answers (manuscript, cover, "AI
  -- used") are required before Librum is asked to look at the book. An
  -- already approved draft is answered above (it needs no new review).
  -- BD16 (D5): a pre-order's manuscript may come later.
  if (v_file_path is null and v_release_date is null and v_book.status <> 'preorder')
     or v_cover_path is null
     or not exists (select 1 from public.book_ai_disclosures d where d.book_id = p_book_id)
  then
    raise exception 'this book needs a manuscript, a cover and the AI answer before review'
      using errcode = 'LB489';
  end if;

  select r.id, r.file_path, r.cover_path, r.original_author, r.description, r.is_adult, r.release_date
    into v_pending
    from public.book_reviews r
   where r.book_id = p_book_id
     and r.status = 'pending'
     for update;

  if found then
    if (v_pending.file_path, v_pending.cover_path, v_pending.original_author, v_pending.description,
        v_pending.is_adult, v_pending.release_date)
       is not distinct from
       (v_file_path, v_cover_path, v_original_author, v_description, v_is_adult, v_release_date) then
      raise exception 'this book is already waiting for review';
    end if;
    update public.book_reviews
       set status = 'cancelled',
           decided_at = pg_catalog.now()
     where id = v_pending.id;
  end if;

  insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author,
                                   description, is_adult, release_date, status)
  values (p_book_id, v_book.title, v_book.author_id, v_file_path, v_cover_path, v_original_author,
          v_description, v_is_adult, v_release_date, 'pending')
  returning id into v_review_id;

  return v_review_id;
end;
$$;

-- ------------------------------------------------------------
-- 7. Staff approval
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
  v_listing boolean;
  v_released boolean := false;
  v_today date;
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
         bo.original_author, bo.is_adult, bo.release_date, bo.preorder_count
    into v_book
    from public.books bo
   where bo.id = v_book_id
     for update;
  if not found then
    raise exception 'no review found for this id';
  end if;

  select r.id, r.status, r.file_path, r.cover_path, r.original_author, r.description, r.is_adult,
         r.release_date
    into v_review
    from public.book_reviews r
   where r.id = p_review_id
     for update;

  if v_review.status <> 'pending' then
    raise exception 'this review is no longer waiting';
  end if;

  if v_book.status not in ('draft', 'published', 'preorder') then
    raise exception 'this book is already published';
  end if;
  v_live := v_book.status in ('published', 'preorder');
  v_listing := v_book.status = 'draft' and v_review.release_date is not null;

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
    -- BD16: the release date asked for is part of what was sent.
    if (v_book.original_author, v_book.description, v_book.is_adult, v_book.release_date)
       is distinct from (v_review.original_author, v_review.description, v_review.is_adult, v_review.release_date) then
      raise exception 'the author changed the book';
    end if;
  end if;

  if v_book.price_all is null
     or v_book.price_all is distinct from p_price_all
     or pg_catalog.btrim(coalesce(v_review.description, '')) = '' then
    raise exception 'the author changed the book';
  end if;

  -- BD16: a pre-order sent without its manuscript has nothing to open.
  if v_review.file_path is null then
    if p_checklist is distinct from '{"cover_is_fine": true, "not_someone_elses_work": true, "rights_declared": true}'::jsonb then
      raise exception 'invalid checklist';
    end if;
  elsif p_checklist is distinct from '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}'::jsonb then
    raise exception 'invalid checklist';
  end if;

  v_today := public.tirana_today();
  if v_listing then
    if v_book.preorder_count >= 2 then
      raise exception 'This book has had its 2 pre-orders. It can still be published normally.'
        using errcode = 'LB501';
    end if;
    -- Too late to list: the file due date (without a file) or the day
    -- itself (with one) has passed. Send it back for a new date.
    if (v_review.file_path is null and v_review.release_date - 3 < v_today)
       or v_review.release_date <= v_today then
      raise exception 'This pre-order''s date is too close. Send it back so the author picks a new date.'
        using errcode = 'LB506';
    end if;
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

    -- BD16 (BD15 Q3): a final file approved on or after the release day
    -- releases the book at once.
    if v_book.status = 'preorder' and v_review.file_path is not null and v_book.release_date <= v_today then
      perform pg_catalog.set_config('librum.preorder_write', 'on', true);
      update public.books
         set status = 'published',
             published_at = coalesce(published_at, pg_catalog.now())
       where id = v_book_id;
      perform pg_catalog.set_config('librum.preorder_write', '', true);
      v_released := true;
    end if;
  elsif v_listing then
    -- BD16: the book becomes a pre-order, with a fresh slip (Q3b a).
    perform pg_catalog.set_config('librum.preorder_write', 'on', true);
    update public.books
       set status = 'preorder',
           preorder_listed_at = coalesce(preorder_listed_at, pg_catalog.now()),
           preorder_count = preorder_count + 1,
           preorder_slip_used = false,
           librum_choice_at = null
     where id = v_book_id;
    perform pg_catalog.set_config('librum.preorder_write', '', true);
  else
    update public.books
       set status = 'published',
           published_at = coalesce(published_at, pg_catalog.now()),
           librum_choice_at = null
     where id = v_book_id;
    v_released := true;
  end if;

  -- Followers hear only about a first publication, never a listing (D2).
  v_first := v_first and v_released;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'book.review_approved', 'books', v_book_id,
          case when v_listing
               then pg_catalog.jsonb_build_object('first_publication', false, 'preorder_listing', true,
                                                  'release_date', v_review.release_date)
               when v_live and v_book.status = 'preorder'
               then pg_catalog.jsonb_build_object('first_publication', v_first, 'live_update', true,
                                                  'preorder', true, 'preorder_released', v_released)
               when v_live
               then pg_catalog.jsonb_build_object('first_publication', v_first, 'live_update', true)
               else pg_catalog.jsonb_build_object('first_publication', v_first)
          end);

  return v_first;
end;
$$;

-- ------------------------------------------------------------
-- 8. The author pushes the date once (Q2 a): that is the slip
-- ------------------------------------------------------------
create function public.push_preorder_release_date(p_book_id uuid, p_release_date date)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_book record;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  select bo.id, bo.author_id, bo.status, bo.release_date, bo.preorder_slip_used
    into v_book
    from public.books bo
   where bo.id = p_book_id
     for update;
  if not found or v_book.author_id is distinct from v_actor_id then
    raise exception 'no book found for this id';
  end if;
  if v_book.status <> 'preorder' then
    raise exception 'This book is not a pre-order.'
      using errcode = 'LB504';
  end if;
  if v_book.preorder_slip_used then
    raise exception 'This pre-order''s date was already moved once.'
      using errcode = 'LB504';
  end if;
  if public.tirana_today() > v_book.release_date - 3 then
    raise exception 'The manuscript''s due date has passed, so the date can''t be moved now.'
      using errcode = 'LB504';
  end if;
  if p_release_date is null
     or p_release_date <= v_book.release_date
     or p_release_date > v_book.release_date + 30 then
    raise exception 'A pre-order''s date moves later by 1 to 30 days.'
      using errcode = 'LB504';
  end if;

  perform pg_catalog.set_config('librum.preorder_write', 'on', true);
  update public.books
     set release_date = p_release_date,
         preorder_slip_used = true
   where id = p_book_id;
  perform pg_catalog.set_config('librum.preorder_write', '', true);

  return p_release_date;
end;
$$;

revoke all on function public.push_preorder_release_date(uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.push_preorder_release_date(uuid, date) to authenticated;

-- ------------------------------------------------------------
-- 9. The daily job's database step
-- ------------------------------------------------------------
-- p_today: the Tirana day the job runs for (null: today); never a later
-- day. Each book is its own step: one that fails is reported and the
-- others go on. Running it twice the same day changes nothing more.
-- The route (P5) sends the emails afterwards from the stored rows.
create function public.run_preorder_day(p_today date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_id uuid;
  v_book record;
  v_cycle_start timestamptz;
  v_sent_back timestamptz;
  v_due date;
  v_released uuid[] := '{}';
  v_slipped jsonb := '[]'::jsonb;
  v_cancelled uuid[] := '{}';
  v_overdue uuid[] := '{}';
  v_failed jsonb := '[]'::jsonb;
begin
  v_today := coalesce(p_today, public.tirana_today());
  if v_today > public.tirana_today() then
    raise exception 'The pre-order job can''t run for a later day.';
  end if;

  -- Two runs at once (the two cron entries, the owner's button) queue.
  perform pg_catalog.pg_advisory_xact_lock(1600161);

  for v_id in
    select bo.id
      from public.books bo
     where bo.status = 'preorder'
     order by bo.id
  loop
    begin
      perform pg_catalog.set_config('librum.preorder_write', 'on', true);
      select bo.id, bo.status, bo.file_path, bo.release_date, bo.preorder_slip_used
        into v_book
        from public.books bo
       where bo.id = v_id
         for update;
      if not found or v_book.status is distinct from 'preorder' then
        continue;
      end if;

      if v_book.file_path is not null then
        -- a. The day has come and the final file is approved.
        if v_book.release_date <= v_today then
          update public.books
             set status = 'published',
                 published_at = coalesce(published_at, pg_catalog.now())
           where id = v_book.id;
          v_released := v_released || v_book.id;
        end if;
      elsif exists (select 1 from public.book_reviews r
                     where r.book_id = v_book.id and r.status = 'pending' and r.file_path is not null) then
        -- c. Sent in time, not approved yet: it waits (not a slip).
        if v_book.release_date <= v_today then
          v_overdue := v_overdue || v_book.id;
        end if;
      else
        -- b. No final file. Q5 a: a send-back after this listing gives
        -- 3 more days from that day.
        select max(r.decided_at) into v_cycle_start
          from public.book_reviews r
         where r.book_id = v_book.id and r.status = 'approved' and r.release_date is not null;
        select max(r.decided_at) into v_sent_back
          from public.book_reviews r
         where r.book_id = v_book.id and r.status = 'sent_back'
           -- audit r1 F3: only a sent-back final file, not a cover or
           -- description change.
           and r.file_path is not null
           and r.decided_at > coalesce(v_cycle_start, '-infinity'::timestamptz);
        v_due := greatest(v_book.release_date - 3,
                          ((v_sent_back at time zone 'Europe/Tirane')::date + 3));
        if v_today > v_due then
          if not v_book.preorder_slip_used then
            update public.books
               set release_date = release_date + 30,
                   preorder_slip_used = true
             where id = v_book.id;
            v_slipped := v_slipped || pg_catalog.jsonb_build_object(
              'book_id', v_book.id, 'release_date', v_book.release_date + 30);
          else
            -- The second miss cancels (books_preorder_rules marks the
            -- waiting readers for the "cancelled" email).
            update public.books
               set status = 'draft'
             where id = v_book.id;
            v_cancelled := v_cancelled || v_book.id;
          end if;
        end if;
      end if;
      perform pg_catalog.set_config('librum.preorder_write', '', true);
    exception when others then
      v_failed := v_failed || pg_catalog.jsonb_build_object('book_id', v_id, 'sqlstate', sqlstate);
    end;
  end loop;
  perform pg_catalog.set_config('librum.preorder_write', '', true);

  return pg_catalog.jsonb_build_object(
    'today', v_today,
    'released_book_ids', pg_catalog.to_jsonb(v_released),
    'slipped', v_slipped,
    'cancelled_book_ids', pg_catalog.to_jsonb(v_cancelled),
    'overdue_book_ids', pg_catalog.to_jsonb(v_overdue),
    'failed', v_failed
  );
end;
$$;

revoke all on function public.run_preorder_day(date)
  from public, anon, authenticated, service_role;
grant execute on function public.run_preorder_day(date) to service_role;

-- ------------------------------------------------------------
-- 10. Suspension: a pre-order is paused and comes back on lift
-- ------------------------------------------------------------
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
  v_preorder_ids uuid[];
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

  -- BD16: live pre-orders are paused, not cancelled.
  select coalesce(pg_catalog.array_agg(bo.id order by bo.id), '{}'::uuid[])
    into v_preorder_ids
    from public.books bo
   where bo.author_id = p_user_id and bo.status = 'preorder';

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

  if pg_catalog.cardinality(v_preorder_ids) > 0 then
    perform pg_catalog.set_config('librum.preorder_write', 'pause', true);
    update public.books
       set status = 'draft',
           librum_choice_at = null
     where id = any (v_preorder_ids);
    perform pg_catalog.set_config('librum.preorder_write', '', true);
  end if;

  insert into public.account_suspensions (user_id, reason, book_ids, bundle_ids, suspended_by, preorder_book_ids)
  values (p_user_id, v_reason, v_book_ids, v_bundle_ids, v_actor_id, v_preorder_ids)
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
    -- BD16: only when there were pre-orders, so other rows stay as before.
    || case when pg_catalog.cardinality(v_preorder_ids) > 0
            then pg_catalog.jsonb_build_object('preorders_paused', pg_catalog.cardinality(v_preorder_ids))
            else '{}'::jsonb end
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
  v_restored_preorders uuid[] := '{}';
  v_cancelled_preorders uuid[] := '{}';
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

  -- BD16: a paused pre-order comes back, its dates as they were (the
  -- daily job then releases it or counts a miss). One that can't come
  -- back (taken down, deleted, or its paused changes not approved)
  -- ends as a cancelled pre-order.
  foreach v_book_id in array v_suspension.preorder_book_ids loop
    if exists (
         select 1 from public.books bo
          where bo.id = v_book_id
            and bo.author_id = p_user_id
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
        v_restored_preorders := v_restored_preorders || v_book_id;
      exception when sqlstate 'LB462' then
        v_cancelled_preorders := v_cancelled_preorders || v_book_id;
      end;
    else
      v_cancelled_preorders := v_cancelled_preorders || v_book_id;
    end if;
  end loop;

  if pg_catalog.cardinality(v_cancelled_preorders) > 0 then
    perform pg_catalog.set_config('librum.preorder_write', 'on', true);
    -- The pause kept the waiting change (audit r1 F1): now that the
    -- pre-order ends, it becomes the draft's values, as for any book
    -- going offline (books_take_pending_changes_offline).
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
       and bo.author_id = p_user_id
       and bo.status = 'draft';
    delete from public.book_pending_changes c
     using public.books bo
     where bo.id = c.book_id
       and bo.id = any (v_cancelled_preorders)
       and bo.author_id = p_user_id
       and bo.status = 'draft';
    update public.books
       set release_date = null,
           preorder_cancelled_at = pg_catalog.now()
     where id = any (v_cancelled_preorders)
       and author_id = p_user_id
       and status = 'draft'
       and release_date is not null;
    update public.preorder_notify_requests
       set book_cancelled_at = pg_catalog.now()
     where book_id = any (v_cancelled_preorders)
       and notified_at is null
       and book_cancelled_at is null;
  end if;
  perform pg_catalog.set_config('librum.preorder_write', '', true);

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
    -- BD16: only when there were pre-orders, so other rows stay as before.
    || case when pg_catalog.cardinality(v_suspension.preorder_book_ids) > 0
            then pg_catalog.jsonb_build_object(
                   'preorders_restored', pg_catalog.cardinality(v_restored_preorders),
                   'preorders_cancelled', pg_catalog.cardinality(v_cancelled_preorders))
            else '{}'::jsonb end
  );

  return pg_catalog.jsonb_build_object(
    'restored_book_ids', pg_catalog.to_jsonb(v_restored_books),
    'draft_book_ids', pg_catalog.to_jsonb(v_draft_books),
    'restored_bundle_ids', pg_catalog.to_jsonb(v_restored_bundles),
    'draft_bundle_ids', pg_catalog.to_jsonb(v_draft_bundles)
  )
  || case when pg_catalog.cardinality(v_suspension.preorder_book_ids) > 0
          then pg_catalog.jsonb_build_object(
                 'restored_preorder_ids', pg_catalog.to_jsonb(v_restored_preorders),
                 'cancelled_preorder_ids', pg_catalog.to_jsonb(v_cancelled_preorders))
          else '{}'::jsonb end;
end;
$$;
