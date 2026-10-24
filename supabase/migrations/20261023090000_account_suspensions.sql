-- PEOPLE-1 (admin People list, search and suspend): staff with
-- people.manage (owner, admin) suspend an account and lift the
-- suspension; staff with people.view (owner, admin) list and search
-- everyone. ADDITIVE ONLY: no drop, no rename, no type change, no
-- existing row is rewritten and nothing is backfilled.
--
-- ROLLOUT ORDER. Apply this migration on staging BEFORE the application
-- in the same patch is deployed there: the new /admin/people pages call
-- admin_list_people(), which does not exist before it. The old code keeps
-- working after this migration: nothing it reads or writes changes until
-- someone is suspended, and only the new functions below can suspend.
-- Production gets it only at a release, through the authorized route.
--
-- WHAT CHANGES, and nothing else (Renato's answers 2026-10-23, brief
-- BRIEF-PEOPLE-r4):
--
--   1. staff_has_permission(): admin gains people.view and people.manage
--      (owner holds every permission already). Restated in full, as
--      ADMIN-3-REVIEW left it, plus these two.
--
--   2. public.account_suspensions: one row per suspension, kept as
--      history (never deleted by app code). At most one ACTIVE row per
--      account (lifted_at is null). user_id and the two staff columns are
--      ON DELETE SET NULL, so the record outlives the account. book_ids
--      and bundle_ids record exactly what the suspension unpublished, so
--      the lift puts back exactly that.
--        * RLS on with no policy, and no grant to anon or authenticated:
--          no client session reads a row, the suspended person included
--          (the reason is for staff only, 6a). Staff read the history
--          with the service-role client after requireStaff("people.view").
--          No INSERT/UPDATE/DELETE for anyone: rows are written only by
--          the two SECURITY DEFINER functions below, owned by the
--          migration owner.
--        * service_role holds SELECT only.
--
--   3. admin_list_people(query, kind, limit, offset, user): people.view.
--      Search by account name, any pen name or sign-in email; kind
--      everyone / authors / readers / suspended; one row per account with
--      its email, type, staff flag, live / in-review / draft book counts,
--      PAID sales (free downloads and refunded sales excluded), owned
--      books, whether a payout bank account exists (never the IBAN),
--      joined date and suspension state. p_user_id returns that one
--      account (the View page).
--
--   4. admin_suspend_account(user, reason): people.manage. Refuses the
--      caller themselves, any staff_members row (2a) and an account that
--      is already suspended. In one transaction: locks the profile, then
--      every one of the author's bundles and books (by id, bundles first,
--      as update_bundle_with_membership locks a bundle before its books,
--      and every status, so a publish racing the suspension waits and is
--      then refused by the lock in 6); drafts exactly the published ones
--      and clears a Librum's choice pick held by one of them; records the
--      suspension (reason trimmed); writes an account.suspended audit row
--      (reason, counts, whether the pick was cleared). Pending reviews
--      stay pending; approving one is refused while suspended (6).
--
--   5. admin_lift_suspension(user): people.manage. Lifts the active row,
--      then republishes exactly the recorded books that are still the
--      author's drafts and are not under an active takedown. A republish
--      the review gate refuses (LB462: the book's file or cover changed
--      since its approval) keeps that book a draft; the rest still
--      restore. Then republishes exactly the recorded bundles that are
--      still drafts and whose every book is published. Returns what was
--      restored and what stayed a draft; writes
--      account.suspension_lifted. The Librum's choice pick is NOT put
--      back (staff pick again).
--
--   6. The lock is in the database: BEFORE INSERT OR UPDATE OF status
--      triggers on books and bundles refuse status = 'published' while
--      the author is suspended (LB464), for every role; BEFORE DELETE
--      triggers refuse a DIRECT delete of a suspended author's book or
--      bundle (LB465) and let an account-deletion cascade through
--      (pg_trigger_depth() > 1), exactly as
--      books_refuse_delete_while_taken_down does.
--
--   7. my_account_is_suspended(): the caller's own yes/no, for the
--      per-request check the application makes (PEOPLE-2). No argument,
--      so it can never be used to probe another account.
--
--   8. author_payout_eligibility() (11a): a suspended author is not
--      eligible, ineligible_reason 'account_suspended', checked first.
--      Same signature and return type. reserve_author_payout() and
--      dry_run_scheduled_payouts() read it, so no payout is reserved for
--      a suspended author; their ledger is untouched (money kept).
--
--   9. public_reviews (F1a), public_pen_names and public_series (F3a):
--      CREATE OR REPLACE with identical columns plus "and the account is
--      not suspended". Their grants are kept unchanged. Nothing is
--      deleted, so lifting the suspension shows them again.
--
--  10. list_admin_audit_events(): its filter allow-lists gain the
--      actions account.suspended and account.suspension_lifted and the
--      target type profiles (restated in full, ADMIN-3-REVIEW's version,
--      plus these).
--
-- UNCHANGED: every existing column, row, grant, policy and trigger.
-- Buyers keep their books (5a): user_owns_book() already shows an owned
-- book whatever its status.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/079_account_suspensions.test.sql and
-- 079_account_suspensions_catalog_equivalence.sh.

-- ------------------------------------------------------------
-- 1. Permissions
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
            'blog.view', 'blog.manage', 'books.review',
            'people.view', 'people.manage'
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
-- 2. Suspension history
-- ------------------------------------------------------------
create table public.account_suspensions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  reason text not null
    constraint account_suspensions_reason_check
    check (char_length(reason) between 1 and 2000
           and reason = btrim(reason, E' \t\r\n')),
  book_ids uuid[] not null default '{}',
  bundle_ids uuid[] not null default '{}',
  suspended_by uuid references public.profiles(id) on delete set null,
  suspended_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references public.profiles(id) on delete set null,
  constraint account_suspensions_lifted_by_check check (lifted_at is not null or lifted_by is null)
);

create unique index account_suspensions_one_active_per_user
  on public.account_suspensions (user_id)
  where lifted_at is null;

create index account_suspensions_user_id_suspended_at_idx
  on public.account_suspensions (user_id, suspended_at desc);

-- RLS on and no policy: no client session reads a row. Staff read the
-- history through the service-role client, after requireStaff
-- ("people.view") on /admin/people/[id], as book_reviews is read.
alter table public.account_suspensions enable row level security;

revoke all on public.account_suspensions from public, anon, authenticated, service_role;
grant select on public.account_suspensions to service_role;

-- ------------------------------------------------------------
-- 6. The lock: no publish, no direct delete while suspended
-- ------------------------------------------------------------
create function public.books_refuse_publish_while_author_suspended()
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

create trigger books_refuse_publish_while_author_suspended
  before insert or update of status on public.books
  for each row
  execute function public.books_refuse_publish_while_author_suspended();

revoke all on function public.books_refuse_publish_while_author_suspended()
  from public, anon, authenticated, service_role;

create function public.bundles_refuse_publish_while_author_suspended()
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
    raise exception 'This account is suspended. Its bundles can''t be published until Librum lifts the suspension.'
      using errcode = 'LB464';
  end if;
  return new;
end;
$$;

create trigger bundles_refuse_publish_while_author_suspended
  before insert or update of status on public.bundles
  for each row
  execute function public.bundles_refuse_publish_while_author_suspended();

revoke all on function public.bundles_refuse_publish_while_author_suspended()
  from public, anon, authenticated, service_role;

-- authenticated holds DELETE on books and bundles (their own rows), so a
-- still-valid access token could delete through the data API. A cascade
-- from deleting the account still goes through (pg_trigger_depth() > 1),
-- as in books_refuse_delete_while_taken_down.
create function public.books_refuse_delete_while_author_suspended()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() <= 1
     and exists (
       select 1
         from public.account_suspensions s
        where s.user_id = old.author_id
          and s.lifted_at is null
     )
  then
    raise exception 'This account is suspended. Its books can''t be deleted until Librum lifts the suspension.'
      using errcode = 'LB465';
  end if;
  return old;
end;
$$;

create trigger books_refuse_delete_while_author_suspended
  before delete on public.books
  for each row
  execute function public.books_refuse_delete_while_author_suspended();

revoke all on function public.books_refuse_delete_while_author_suspended()
  from public, anon, authenticated, service_role;

create function public.bundles_refuse_delete_while_author_suspended()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() <= 1
     and exists (
       select 1
         from public.account_suspensions s
        where s.user_id = old.author_id
          and s.lifted_at is null
     )
  then
    raise exception 'This account is suspended. Its bundles can''t be deleted until Librum lifts the suspension.'
      using errcode = 'LB465';
  end if;
  return old;
end;
$$;

create trigger bundles_refuse_delete_while_author_suspended
  before delete on public.bundles
  for each row
  execute function public.bundles_refuse_delete_while_author_suspended();

revoke all on function public.bundles_refuse_delete_while_author_suspended()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 7. The caller's own suspension state
-- ------------------------------------------------------------
create function public.my_account_is_suspended()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (
       select 1
         from public.account_suspensions s
        where s.user_id = auth.uid()
          and s.lifted_at is null
     );
$$;

revoke all on function public.my_account_is_suspended()
  from public, anon, authenticated, service_role;
grant execute on function public.my_account_is_suspended() to authenticated;

-- ------------------------------------------------------------
-- 3. The People list
-- ------------------------------------------------------------
create function public.admin_list_people(
  p_query text default null,
  p_kind text default 'everyone',
  p_limit integer default 50,
  p_offset integer default 0,
  p_user_id uuid default null
)
returns table (
  user_id uuid,
  display_name text,
  email text,
  account_type text,
  is_staff boolean,
  live_books integer,
  in_review_books integer,
  draft_books integer,
  paid_sales integer,
  owned_books integer,
  has_bank_account boolean,
  joined_at timestamptz,
  suspended boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text;
  v_pattern text;
  v_limit integer;
  v_offset integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('people.view') then
    raise exception 'not authorized';
  end if;

  if coalesce(p_kind, 'everyone') not in ('everyone', 'authors', 'readers', 'suspended') then
    raise exception 'invalid kind';
  end if;

  v_query := pg_catalog.btrim(coalesce(p_query, ''), E' \t\r\n');
  if pg_catalog.char_length(v_query) > 200 then
    raise exception 'invalid query';
  end if;
  if v_query = '' then
    v_pattern := null;
  else
    v_pattern := '%'
      || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(v_query, '\', '\\'), '%', '\%'), '_', '\_')
      || '%';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  return query
    with matched as (
      select p.id, p.display_name, p.role, p.created_at, au.email
        from public.profiles p
        left join auth.users au on au.id = p.id
       where (p_user_id is null or p.id = p_user_id)
         and (
           coalesce(p_kind, 'everyone') = 'everyone'
           or (p_kind = 'authors' and p.role = 'author')
           or (p_kind = 'readers' and p.role = 'reader')
           or (p_kind = 'suspended' and exists (
                 select 1 from public.account_suspensions s
                  where s.user_id = p.id and s.lifted_at is null))
         )
         and (
           v_pattern is null
           or p.display_name ilike v_pattern
           or au.email ilike v_pattern
           or exists (
                select 1 from public.pen_names pn
                 where pn.author_id = p.id and pn.name ilike v_pattern)
         )
    ),
    page as (
      select m.*, pg_catalog.count(*) over () as total
        from matched m
       order by m.created_at desc, m.id desc
       limit v_limit offset v_offset
    )
    select
      pg.id,
      pg.display_name,
      pg.email::text,
      pg.role,
      exists (select 1 from public.staff_members sm where sm.user_id = pg.id),
      (select pg_catalog.count(*)::integer from public.books b
        where b.author_id = pg.id and b.status = 'published'),
      (select pg_catalog.count(*)::integer from public.books b
        where b.author_id = pg.id and b.status = 'draft'
          and exists (select 1 from public.book_reviews br
                       where br.book_id = b.id and br.status = 'pending')),
      (select pg_catalog.count(*)::integer from public.books b
        where b.author_id = pg.id and b.status = 'draft'
          and not exists (select 1 from public.book_reviews br
                           where br.book_id = b.id and br.status = 'pending')),
      (select pg_catalog.count(*)::integer
         from public.purchases pu
         join public.books b on b.id = pu.book_id
        where b.author_id = pg.id
          and pu.amount_cents > 0
          and pu.refunded_at is null),
      (select pg_catalog.count(*)::integer from public.purchases pu
        where pu.reader_id = pg.id and pu.refunded_at is null),
      exists (select 1 from public.author_payout_destinations apd where apd.author_id = pg.id),
      pg.created_at,
      exists (select 1 from public.account_suspensions s
               where s.user_id = pg.id and s.lifted_at is null),
      pg.total
    from page pg
    order by pg.created_at desc, pg.id desc;
end;
$$;

revoke all on function public.admin_list_people(text, text, integer, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_list_people(text, text, integer, integer, uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. Suspend
-- ------------------------------------------------------------
create function public.admin_suspend_account(p_user_id uuid, p_reason text)
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

revoke all on function public.admin_suspend_account(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_suspend_account(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 5. Lift
-- ------------------------------------------------------------
create function public.admin_lift_suspension(p_user_id uuid)
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
      'bundles_kept_draft', pg_catalog.cardinality(v_draft_bundles)
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

revoke all on function public.admin_lift_suspension(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_lift_suspension(uuid) to authenticated;

-- ------------------------------------------------------------
-- 8. Payout hold (11a): same signature and return type; the suspended
-- check is the first in the priority order.
-- ------------------------------------------------------------
create or replace function public.author_payout_eligibility(
  p_author_id uuid,
  p_currency text
)
returns table (
  author_id uuid,
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  payoutable_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  active_reservation boolean,
  eligible boolean,
  ineligible_reason text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_available bigint;
  v_threshold bigint;
  v_minimum_policy bigint;
  v_effective_threshold bigint;
  v_reserved bigint;
  v_payoutable bigint;
  v_active_reservation boolean;
  v_has_destination boolean;
  v_suspended boolean;
begin
  select balance.available_minor into v_available
  from public.author_ledger_balance(p_author_id) balance
  where balance.currency = p_currency;

  select aps.threshold_minor into v_threshold
  from public.author_payout_settings aps
  where aps.author_id = p_author_id and aps.currency = p_currency;

  select pmp.minimum_threshold_minor into v_minimum_policy
  from public.payout_minimum_policy pmp
  where pmp.currency = p_currency and pmp.is_active = true;

  select coalesce(sum(ap.amount_minor), 0) into v_reserved
  from public.author_payouts ap
  where ap.author_id = p_author_id
    and ap.currency = p_currency
    and ap.status in ('pending', 'processing', 'reconciling');

  v_active_reservation := exists (
    select 1
    from public.author_payouts ap
    where ap.author_id = p_author_id
      and ap.currency = p_currency
      and ap.status in ('pending', 'processing', 'reconciling')
  );

  v_has_destination := exists (
    select 1
    from public.author_payout_destinations apd
    where apd.author_id = p_author_id and apd.currency = p_currency
  );

  -- PEOPLE-1 (11a): a suspended author is held, checked first.
  v_suspended := exists (
    select 1
    from public.account_suspensions s
    where s.user_id = p_author_id and s.lifted_at is null
  );

  if v_available is null then
    v_payoutable := null;
  else
    v_payoutable := v_available - v_reserved;
  end if;

  author_id := p_author_id;
  currency := p_currency;
  ledger_available_minor := v_available;
  reserved_minor := v_reserved;
  payoutable_minor := v_payoutable;
  threshold_configured := v_threshold is not null;
  threshold_minor := v_threshold;
  active_reservation := v_active_reservation;

  if v_suspended then
    eligible := false;
    ineligible_reason := 'account_suspended';
  elsif v_threshold is null then
    eligible := false;
    ineligible_reason := 'no_settings';
  elsif v_minimum_policy is null then
    eligible := false;
    ineligible_reason := 'no_minimum_policy';
  else
    -- Both operands are non-null here (Correction 1's own NULL-safety
    -- requirement) -- safe to compute the effective threshold now.
    v_effective_threshold := greatest(v_threshold, v_minimum_policy);

    if v_available is null then
      eligible := false;
      ineligible_reason := 'no_available_balance';
    elsif v_active_reservation then
      eligible := false;
      ineligible_reason := 'active_reservation';
    elsif v_payoutable < v_effective_threshold then
      eligible := false;
      ineligible_reason := 'below_threshold';
    elsif not v_has_destination then
      eligible := false;
      ineligible_reason := 'no_destination';
    else
      eligible := true;
      ineligible_reason := null;
    end if;
  end if;

  return next;
end;
$$;
-- ------------------------------------------------------------
-- 9. Public views: a suspended account's reviews (F1a), pen names and
-- series (F3a) are hidden. Same columns, so CREATE OR REPLACE keeps
-- every existing grant.
-- ------------------------------------------------------------
create or replace view public.public_pen_names as
  select pn.id, pn.name, pn.bio, pn.avatar_path, pn.links
  from public.pen_names pn
  where (
       exists (select 1 from public.books b where b.pen_name_id = pn.id)
    or exists (select 1 from public.series s where s.pen_name_id = pn.id)
    or exists (select 1 from public.bundles bu where bu.pen_name_id = pn.id)
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = pn.author_id and sus.lifted_at is null
    );

create or replace view public.public_series as
  select s.id, s.title, s.pen_name_id, s.created_at
  from public.series s
  where not exists (
    select 1 from public.account_suspensions sus
     where sus.user_id = s.author_id and sus.lifted_at is null
  );

create or replace view public.public_reviews
  with (security_barrier)
as
  select r.id, r.book_id, r.rating, r.body, r.created_at,
         (select pn.name
            from public.profiles p
            join public.pen_names pn on pn.author_id = p.id and pn.is_default
           where p.id = r.reader_id
             and p.role = 'author'
             and exists (select 1 from public.books b where b.author_id = p.id)) as reviewer_name
  from public.reviews r
  where exists (select 1 from public.public_books pb where pb.id = r.book_id)
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = r.reader_id and sus.lifted_at is null
    );

-- ------------------------------------------------------------
-- 10. Audit filter allow-lists
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
    'book.review_approved', 'book.review_sent_back',
    'account.suspended', 'account.suspension_lifted'
  ) then
    raise exception 'invalid action filter';
  end if;

  if p_target_type is not null and p_target_type not in (
    'staff_members', 'book_reports', 'refund_requests', 'blog_posts',
    'pen_names', 'books', 'profiles'
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
