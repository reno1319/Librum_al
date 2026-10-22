-- ADMIN-2-TAKEDOWN (admin Unpublish): staff take a book out of the
-- Bookstore, the author is told why, and the book stays locked until
-- staff allow it again. ADDITIVE ONLY: no drop, no rename, no type
-- change, no existing row is rewritten and nothing is backfilled.
--
-- ROLLOUT ORDER. Apply this migration on staging BEFORE the application
-- in the same patch is deployed there. The new publish gate
-- (performPublish in dashboard/books/actions.ts) reads book_takedowns
-- with the author's session and fails CLOSED when it cannot (before
-- this migration the table is missing), so the new code without this
-- migration refuses every publish with the generic "couldn't publish
-- your book yet" sentence. The old code keeps working after this
-- migration: nothing it reads or writes changes, and the lock trigger
-- below only fires for a taken-down book, which old code cannot create.
-- Production gets it only at a release, through the authorized route.
--
-- WHAT CHANGES, and nothing else (Renato's answers 1a-7a, 2026-10-19):
--
--   1. public.book_takedowns: one row per takedown, kept as history
--      (never deleted by app code). book_id/author_id/report_id and the
--      two staff columns are ON DELETE SET NULL; the title is a copy, so
--      the record outlives the book. At most one ACTIVE row per book
--      (lifted_at is null). bundle_ids records the published bundles the
--      takedown also unpublished (6a).
--        * RLS: an author reads their own rows; staff with reports.view
--          read every row. No INSERT/UPDATE/DELETE for anyone: rows are
--          written only by the two SECURITY DEFINER functions below,
--          owned by the migration owner.
--        * authenticated holds SELECT on the author-facing columns ONLY
--          (book_id, book_title, author_id, reason, message_to_author,
--          bundle_ids, taken_down_at, lifted_at): no id, no staff ids, no
--          report id. So `select *` and `select id` by an author session
--          fail with 42501, and every app read names its columns.
--          service_role holds SELECT on every column and nothing else.
--          The takedown message is NOT a books column on purpose: books
--          is readable by buyers and anon while published.
--
--   2. public.admin_unpublish_book(book, reason, message, report):
--      reports.resolve only (owner, admin, moderator). In one
--      transaction: locks the published bundles holding the book (in id
--      order, as update_bundle_with_membership locks a bundle before its
--      books), then the book; refuses a second active takedown and a
--      report that is not an OPEN report of this book; drafts the book
--      and clears its Librum's choice pick; drafts exactly the published
--      bundles holding it, re-selected after the book lock; records the
--      takedown (message trimmed); resolves the report the way
--      review_book_report does (admin_notes = the reason's label, its
--      own report.resolved audit row); and writes a book.unpublished
--      audit row (reason, report id, bundle count, whether the pick was
--      cleared -- never the message). Other open reports on the book
--      stay open. Unpublishing a draft is allowed (it still locks it).
--
--   3. public.admin_allow_book_again(book): same guard; lifts the active
--      takedown (lifted_at/lifted_by) and writes book.allowed_again. The
--      book stays a draft and its bundles stay drafts: the author
--      publishes again themselves.
--
--   4. The lock is in the database, not only the app: a BEFORE UPDATE OF
--      status trigger on books refuses status = 'published' while an
--      active takedown exists, for every role (the author's trusted
--      server writer, service_role and the table owner alike). There is
--      no INSERT trigger: a new row is always a draft (CATALOG-WRITE-
--      AUTH-1) and cannot have a takedown yet.
--      A BEFORE DELETE trigger likewise refuses a DIRECT delete of a
--      taken-down book (audit A1, Renato's answer a); a cascade from
--      deleting the account still goes through (pg_trigger_depth() > 1).
--      Until a takedown is lifted, nobody -- including a service-role
--      cleanup script -- deletes that book row directly.
--
--   5. list_admin_audit_events(): its filter allow-lists gain the actions
--      book.unpublished and book.allowed_again and the target type books
--      (restated in full, PEN-NAMES-1's version -- PEN-NAMES-2 left it
--      unchanged -- plus these).
--
-- UNCHANGED: every existing column, row, grant, policy and trigger;
-- staff_has_permission() and the TypeScript permission catalog (no new
-- permission). Buyers keep their books (3a): user_owns_book() already
-- shows an owned book whatever its status.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/076_book_takedowns.test.sql and
-- 076_book_takedowns_catalog_equivalence.sh.
-- Applies after PEN-NAMES-2 (20261019222500 / 20261019222600) in
-- file order, but depends on neither: it reads no column or view they
-- add or drop.

-- ------------------------------------------------------------
-- 1. Takedown history
-- ------------------------------------------------------------
create table public.book_takedowns (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references public.books(id) on delete set null,
  book_title text not null,
  author_id uuid references public.profiles(id) on delete set null,
  reason text not null
    constraint book_takedowns_reason_check
    check (reason in ('copyright', 'content_rules', 'broken_file', 'author_asked', 'other')),
  message_to_author text not null
    constraint book_takedowns_message_to_author_check
    check (char_length(message_to_author) between 1 and 2000
           and message_to_author = btrim(message_to_author, E' \t\r\n')),
  report_id uuid references public.book_reports(id) on delete set null,
  bundle_ids uuid[] not null default '{}',
  taken_down_by uuid references public.profiles(id) on delete set null,
  taken_down_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references public.profiles(id) on delete set null,
  constraint book_takedowns_lifted_by_check check (lifted_at is not null or lifted_by is null)
);

create unique index book_takedowns_one_active_per_book
  on public.book_takedowns (book_id)
  where lifted_at is null;

create index book_takedowns_book_id_taken_down_at_idx
  on public.book_takedowns (book_id, taken_down_at desc);

create index book_takedowns_author_id_idx
  on public.book_takedowns (author_id);

alter table public.book_takedowns enable row level security;

create policy "Authors can read their own takedowns"
  on public.book_takedowns for select
  to authenticated
  using (auth.uid() = author_id);

create policy "Staff with reports.view can read takedowns"
  on public.book_takedowns for select
  to authenticated
  using (public.staff_has_permission('reports.view'));

revoke all on public.book_takedowns from public, anon, authenticated, service_role;
grant select (
    book_id, book_title, author_id, reason, message_to_author, bundle_ids,
    taken_down_at, lifted_at
  )
  on public.book_takedowns
  to authenticated;
grant select on public.book_takedowns to service_role;

-- ------------------------------------------------------------
-- 4. The lock: no publish while an active takedown exists
-- ------------------------------------------------------------
create function public.books_refuse_publish_while_taken_down()
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

create trigger books_refuse_publish_while_taken_down
  before update of status on public.books
  for each row
  execute function public.books_refuse_publish_while_taken_down();

revoke all on function public.books_refuse_publish_while_taken_down()
  from public, anon, authenticated, service_role;

-- 4b. (Renato, audit ADMIN-2 r1 A1 = a) no DIRECT delete of a taken-down
-- book either. authenticated holds DELETE on books ("Authors can delete
-- their own books"), so the app's deleteBook refusal alone could be
-- bypassed through the data API. The trigger refuses a direct DELETE
-- statement -- by the author, service_role or the table owner -- while
-- an active takedown exists, and lets a CASCADE through: deleting an
-- account (auth.users -> profiles -> books) must keep working, and
-- keeps the takedown row (book_id and author_id set null, title kept).
-- A cascade reaches this trigger from inside the foreign key's own RI
-- trigger, so pg_trigger_depth() is 1 for a direct statement (author,
-- service_role or owner) and 2 for a cascade, both from profiles and
-- from auth.users (that RI trigger fires after the profiles statement
-- ends, back at depth 1). Measured on PostgreSQL 16; 076 tests every
-- path. No other trigger or function in the schema deletes books.
create function public.books_refuse_delete_while_taken_down()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() <= 1
     and exists (
       select 1
         from public.book_takedowns t
        where t.book_id = old.id
          and t.lifted_at is null
     )
  then
    raise exception 'Librum took this book down. It can''t be deleted until Librum allows it again.'
      using errcode = 'LB461';
  end if;
  return old;
end;
$$;

create trigger books_refuse_delete_while_taken_down
  before delete on public.books
  for each row
  execute function public.books_refuse_delete_while_taken_down();

revoke all on function public.books_refuse_delete_while_taken_down()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Unpublish (take down)
-- ------------------------------------------------------------
create function public.admin_unpublish_book(
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

revoke all on function public.admin_unpublish_book(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_unpublish_book(uuid, text, text, uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. Allow again
-- ------------------------------------------------------------
create function public.admin_allow_book_again(p_book_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_takedown_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  -- The book first, as admin_unpublish_book locks it.
  perform 1 from public.books bo where bo.id = p_book_id for update;

  update public.book_takedowns
     set lifted_at = pg_catalog.now(),
         lifted_by = v_actor_id
   where book_id = p_book_id
     and lifted_at is null
  returning id into v_takedown_id;

  if v_takedown_id is null then
    raise exception 'this book is not taken down';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'book.allowed_again', 'books', p_book_id, '{}'::jsonb);
end;
$$;

revoke all on function public.admin_allow_book_again(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_allow_book_again(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. Audit filter allow-lists
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
    'book.unpublished', 'book.allowed_again'
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

revoke all on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) to authenticated;
