-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LIBRUM 2.0 ADMIN-1B PART B: the staff-management mutation
-- surface deferred by ADMIN-1A (migration 040) -- add/change-role/remove
-- RPCs, an append-only audit log, and a hard, trigger-enforced
-- last-owner invariant. See the ADMIN-1B Part A audit report for the
-- full design reasoning; summarized here only where it explains a
-- specific choice made in this file.
--
-- ORDERING INVARIANT (same discipline migration 040's own header
-- establishes, after a real production incident there): every function
-- this file's CREATE POLICY/REVOKE/GRANT/CREATE TRIGGER statements
-- reference must already be defined earlier in this same file. A
-- plpgsql/SQL function BODY is safe regardless of order (Postgres
-- resolves those references lazily, at first execution) -- a CREATE
-- POLICY/CREATE TRIGGER is NOT safe regardless of order, since the
-- referenced function must already exist as a catalog object at DDL
-- time. This file's statement order is: table -> trigger function ->
-- trigger -> audit table -> RPCs (in dependency order: list, add, change
-- role, remove).
--
-- Migration 040 is immutable (already production-applied) and is not
-- modified by this file in any way -- staff_has_permission(), the
-- staff_members table shape, and the existing ROLE_PERMISSIONS/
-- staff_has_permission() matrix (owner/admin/editor/moderator/support x
-- admin.access/reports.*/refunds.*/staff.view/staff.manage) are all
-- reused exactly as-is. staff.manage remains owner-only in V1 -- this
-- file does not change who holds it, only what holding it now lets you
-- do.

-- ============================================================
-- Part 1: hard last-owner invariant -- a BEFORE trigger on staff_members
-- itself, not merely an RPC-level check. This is deliberately placed
-- FIRST in this file (immediately after staff_members already exists
-- from migration 040) so it protects staff_members from every
-- subsequent write path added below, and from anything else that could
-- ever touch this table (direct privileged SQL, a future service-role
-- write, or an ON DELETE CASCADE from profiles/auth.users being
-- deleted -- Postgres fires a table's own triggers for cascade-driven
-- deletes exactly as if the DELETE had been issued directly against
-- that table, so this trigger runs even when the row disappears as a
-- side effect of deleting the owning profile/auth user elsewhere).
--
-- Only owner-REDUCING transitions need the check at all:
--   support -> moderator      : OLD.role <> 'owner'      -> no check
--   admin -> owner            : OLD.role <> 'owner'      -> no check
--   owner -> owner (no-op)    : NEW.role = 'owner'        -> no check
--   owner -> admin            : OLD.role = 'owner',
--                                NEW.role <> 'owner'       -> CHECKED
--   DELETE where role = owner : OLD.role = 'owner'         -> CHECKED
--
-- Concurrency: the naive `select count(*) where role='owner'` this
-- trigger performs is NOT sufficient on its own under concurrent
-- execution -- two simultaneous transactions (A removes B / B removes
-- A, starting from exactly two owners) could each independently see a
-- pre-change count of 2 and both proceed, leaving zero owners. Guarded
-- with pg_advisory_xact_lock() on one single, fixed, deterministic key
-- -- the same idiom already established by migrations 026, 032, and 035
-- for equivalent "serialize concurrent mutations of a shared invariant"
-- problems, not a new mechanism introduced here. Transaction-scoped:
-- automatically released at this transaction's commit OR rollback, no
-- manual unlock needed. Because the lock is acquired and held for the
-- remainder of the transaction, a second concurrent owner-reducing
-- transaction blocks at the lock acquisition until the first commits or
-- rolls back -- by the time it proceeds, its own count(*) (a fresh read
-- under Postgres's default READ COMMITTED isolation) reflects the
-- first transaction's already-committed result, so the second
-- transaction correctly sees the reduced count and is blocked if it
-- would take the count to zero. See the ADMIN-1B Part A audit's
-- concurrency-approaches comparison for why this was chosen over table
-- locks, row locks alone, SERIALIZABLE isolation, or a constraint
-- trigger.
--
-- The raised message is deliberately already the final, stable,
-- non-leaking, user-facing text -- not a code, not a raw diagnostic --
-- matching review_book_report()/review_refund_request()'s own established
-- convention of raising the exact message the application surfaces
-- (e.g. 'not authorized'), rather than a separate mapping layer for
-- this specific failure. change_staff_role()/remove_staff_member()
-- below do not duplicate this check themselves -- they rely on this
-- trigger as the single, unconditional source of truth, exactly as
-- instructed (the trigger is the hard final guard; letting its own
-- already-stable message propagate IS the "explicit business
-- validation" business validation the RPCs need, without a second,
-- potentially-divergent copy of the same check).
-- ============================================================

create or replace function public.staff_members_protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_count integer;
begin
  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('staff_members:owner_invariant')
    );

    select count(*) into v_owner_count
    from public.staff_members
    where role = 'owner';

    if v_owner_count <= 1 then
      raise exception 'at least one owner is required';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

-- EXECUTE revoked from every client role, same belt-and-suspenders
-- treatment migration 040's header already gives every trigger function
-- in this schema -- direct invocation is structurally impossible anyway
-- (trigger functions can only fire via a trigger), and the trigger
-- mechanism itself never checks EXECUTE privilege, but this keeps the
-- convention uniform and auditable.
revoke all on function public.staff_members_protect_last_owner() from public;
revoke all on function public.staff_members_protect_last_owner() from anon;
revoke all on function public.staff_members_protect_last_owner() from authenticated;

create trigger staff_members_protect_last_owner
  before update of role or delete on public.staff_members
  for each row execute function public.staff_members_protect_last_owner();

-- ============================================================
-- Part 2: admin_audit_log -- append-only from the application's
-- perspective. No SELECT/INSERT/UPDATE/DELETE grant to anon or
-- authenticated at all (deliberately stricter than staff_members' own
-- "SELECT granted, gated by RLS" shape -- ADMIN-1B has no audit-viewing
-- UI yet, and the design brief explicitly defers staff.view-gated
-- SELECT access to ADMIN-1C). RLS is still enabled regardless, as
-- belt-and-suspenders matching this schema's universal convention: with
-- RLS on and zero policies defined, even a role that somehow held a
-- table grant would see/affect nothing. Writes only ever happen from
-- inside the SECURITY DEFINER RPCs below, which run as this migration's
-- applying role (the function owner), not as anon/authenticated/
-- service_role, and are therefore unaffected by the grant revocation --
-- exactly the same mechanism staff_members' own owner-bootstrap INSERT
-- already relies on.
--
-- actor_id is ON DELETE SET NULL, not CASCADE -- this is a historical
-- record, not a live grant (the same distinction migration 040 already
-- draws between staff_members.user_id (CASCADE, a live grant) and
-- created_by (SET NULL, an audit reference)). An audit row must survive
-- the actor's own account being deleted later.
--
-- target_id has no FK: target_type is polymorphic (today always
-- 'staff_members', but this shape is meant to outlive ADMIN-1B without
-- a schema change for a second target table later), so a single FK
-- column referencing one specific table would be wrong the moment a
-- second target type exists.
-- ============================================================

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_log enable row level security;

revoke all on public.admin_audit_log from anon, authenticated;

-- Deliberately no SELECT/INSERT/UPDATE/DELETE policy of any kind here
-- -- see this table's own header comment above. ADMIN-1C is expected to
-- add a staff.view-gated (or narrower) SELECT policy when an
-- audit-viewer UI actually exists; adding one now, with nothing to view
-- it, would be exactly the "build ahead of the RPC" pattern this
-- schema's own conventions (staff_members' own staff.view policy
-- excepted, which WAS justified because ADMIN-1A already shipped
-- staff.view as a real, checked permission) avoid.

create index admin_audit_log_actor_id_idx on public.admin_audit_log (actor_id);
create index admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id);

-- ============================================================
-- Part 3: list_staff_members() -- one joined query across staff_members
-- + profiles + auth.users, so the staff-directory listing ADMIN-1C will
-- build never needs an N+1 sequence of auth.admin.getUserById() calls
-- (the alternative the ADMIN-1B Part A audit explicitly evaluated and
-- rejected in favor of this). Only ever returns the five columns
-- listed -- never a raw auth.users row, never anything else that table
-- holds (no encrypted_password, no confirmation/recovery tokens, no
-- provider metadata). Authorization is checked explicitly inside the
-- function body (not left to RLS alone) -- same posture
-- review_book_report()/review_refund_request() already established:
-- RLS on the underlying tables is defense-in-depth, not the sole gate,
-- for a SECURITY DEFINER function that bypasses RLS by construction
-- anyway.
-- ============================================================

create or replace function public.list_staff_members()
returns table (
  user_id uuid,
  display_name text,
  email text,
  role text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('staff.view') then
    raise exception 'not authorized';
  end if;

  return query
    select sm.user_id, p.display_name, au.email::text, sm.role, sm.created_at
    from public.staff_members sm
    join public.profiles p on p.id = sm.user_id
    join auth.users au on au.id = sm.user_id
    order by sm.created_at asc;
end;
$$;

revoke all on function public.list_staff_members() from public;
revoke all on function public.list_staff_members() from anon;
revoke all on function public.list_staff_members() from authenticated;
grant execute on function public.list_staff_members() to authenticated;

-- ============================================================
-- Part 4: add_staff_member_by_email() -- the only path that ever
-- resolves an email to an account id in this schema. Deliberately NOT
-- factored into a separately-callable resolve_user_by_email() helper
-- (the design brief explicitly forbids this) -- the lookup is inlined
-- here, so there is no independently-invokable "does this email exist"
-- oracle anywhere in the API surface.
--
-- Email normalization: lower(trim(...)) is applied to the SUBMITTED
-- value and compared against lower(email) on auth.users, so correctness
-- never depends on trusting whatever casing/whitespace GoTrue happens
-- to store the value in.
--
-- Anti-enumeration: "no account with this email" and "account exists
-- but email_confirmed_at is null" raise the exact same message,
-- deliberately -- a caller with staff.manage (already a highly
-- privileged permission) still learns nothing about whether an
-- unverified signup exists for a given address beyond "you can't add
-- this one yet."
--
-- Atomicity: everything below runs as one PL/pgSQL function body inside
-- the caller's own transaction -- any raised exception anywhere (email
-- invalid, account not found/unverified, already staff) rolls back
-- everything before it in this same call, including a partially-applied
-- state, with no explicit BEGIN/COMMIT of its own needed.
-- ============================================================

create or replace function public.add_staff_member_by_email(
  target_email text,
  new_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_normalized_email text;
  v_target_user_id uuid;
  v_email_confirmed_at timestamptz;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('staff.manage') then
    raise exception 'not authorized';
  end if;

  if new_role not in ('owner', 'admin', 'editor', 'moderator', 'support') then
    raise exception 'invalid role';
  end if;

  v_normalized_email := lower(trim(coalesce(target_email, '')));
  if v_normalized_email = '' then
    raise exception 'invalid email';
  end if;

  select id, email_confirmed_at
  into v_target_user_id, v_email_confirmed_at
  from auth.users
  where lower(email) = v_normalized_email
  limit 1;

  if v_target_user_id is null or v_email_confirmed_at is null then
    raise exception 'no verified Librum account was found for that email';
  end if;

  -- Defensive: every real signup gets a profiles row via
  -- handle_new_user() (migration 002), so this should never actually
  -- fire for a genuine auth.users row -- but failing clearly here, with
  -- the same anti-enumeration message, is safer than letting the
  -- INSERT below fail on profiles' own FK with a raw constraint error.
  if not exists (select 1 from public.profiles where id = v_target_user_id) then
    raise exception 'no verified Librum account was found for that email';
  end if;

  if exists (select 1 from public.staff_members where user_id = v_target_user_id) then
    raise exception 'already staff';
  end if;

  insert into public.staff_members (user_id, role, created_by)
  values (v_target_user_id, new_role, v_actor_id);

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id, 'staff.added', 'staff_members', v_target_user_id,
    jsonb_build_object('role', new_role)
  );
end;
$$;

revoke all on function public.add_staff_member_by_email(text, text) from public;
revoke all on function public.add_staff_member_by_email(text, text) from anon;
revoke all on function public.add_staff_member_by_email(text, text) from authenticated;
grant execute on function public.add_staff_member_by_email(text, text) to authenticated;

-- ============================================================
-- Part 5: change_staff_role() -- self-action rule enforced explicitly
-- (actor cannot change their own role, no exception even when another
-- owner exists -- the design brief is explicit that this rule has no
-- carve-out). Same-role "changes" are a stable, intentional no-op: no
-- row write, no updated_at bump, no audit event -- only a REAL
-- transition writes anything. The owner-reducing case (owner -> anything
-- else) is protected entirely by the Part 1 trigger, not duplicated
-- here -- see that trigger's own comment for why.
-- ============================================================

create or replace function public.change_staff_role(
  target_user_id uuid,
  new_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_old_role text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('staff.manage') then
    raise exception 'not authorized';
  end if;

  if new_role not in ('owner', 'admin', 'editor', 'moderator', 'support') then
    raise exception 'invalid role';
  end if;

  if target_user_id = v_actor_id then
    raise exception 'cannot change your own role';
  end if;

  select role into v_old_role
  from public.staff_members
  where user_id = target_user_id;

  if v_old_role is null then
    raise exception 'staff member not found';
  end if;

  if v_old_role = new_role then
    return;
  end if;

  update public.staff_members
  set role = new_role,
      updated_at = pg_catalog.now()
  where user_id = target_user_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id, 'staff.role_changed', 'staff_members', target_user_id,
    jsonb_build_object('old_role', v_old_role, 'new_role', new_role)
  );
end;
$$;

revoke all on function public.change_staff_role(uuid, text) from public;
revoke all on function public.change_staff_role(uuid, text) from anon;
revoke all on function public.change_staff_role(uuid, text) from authenticated;
grant execute on function public.change_staff_role(uuid, text) to authenticated;

-- ============================================================
-- Part 6: remove_staff_member() -- deletes only the staff_members row.
-- profiles/auth.users/purchases/books and every other reader/author
-- table are untouched by construction: this function never references
-- any of them. The owner-reducing case (removing an owner) is
-- protected entirely by the Part 1 trigger, not duplicated here.
-- ============================================================

create or replace function public.remove_staff_member(
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_role text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('staff.manage') then
    raise exception 'not authorized';
  end if;

  if target_user_id = v_actor_id then
    raise exception 'cannot remove yourself';
  end if;

  select role into v_role
  from public.staff_members
  where user_id = target_user_id;

  if v_role is null then
    raise exception 'staff member not found';
  end if;

  delete from public.staff_members where user_id = target_user_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'staff.removed', 'staff_members', target_user_id, jsonb_build_object('role', v_role));
end;
$$;

revoke all on function public.remove_staff_member(uuid) from public;
revoke all on function public.remove_staff_member(uuid) from anon;
revoke all on function public.remove_staff_member(uuid) from authenticated;
grant execute on function public.remove_staff_member(uuid) to authenticated;

-- ============================================================
-- MANUAL CONCURRENCY VERIFICATION (not automatable in this repo's
-- existing SQL-test harness -- see supabase/tests/041_staff_management.test.sql's
-- own header for why a single-connection, single-transaction harness
-- cannot prove concurrent-transaction safety). Run this once, by hand,
-- against a disposable database before this migration is trusted in
-- production, using two separate terminals/psql connections:
--
--   Setup (one connection): create two staff_members rows with
--   role = 'owner' (owners A and B), in a database that already has
--   this migration applied.
--
--   Terminal 1:
--     begin;
--     select public.remove_staff_member('<B's uuid>');
--     -- do NOT commit yet -- leave this transaction open
--
--   Terminal 2 (while Terminal 1's transaction is still open):
--     begin;
--     select public.remove_staff_member('<A's uuid>');
--     -- this call should BLOCK (not error, not proceed) here, waiting
--     -- on the advisory lock Terminal 1 is holding
--
--   Terminal 1:
--     commit;
--     -- Terminal 2's blocked call now proceeds. It must raise
--     -- 'at least one owner is required', NOT succeed -- because by
--     -- the time it re-reads the owner count (after acquiring the
--     -- lock Terminal 1 just released), Terminal 1's removal of B has
--     -- already committed, leaving A as the sole remaining owner.
--
--   Terminal 2:
--     rollback; -- (the raised exception already aborted this
--     -- transaction; rollback clears the session's error state)
--
--   Expected final state: exactly one owner remains (A), never zero.
--   If Terminal 2's call instead succeeds (removing A) rather than
--   raising the last-owner exception, the advisory lock is not
--   providing the guarantee this migration relies on -- stop and
--   investigate before trusting this migration anywhere real.
-- ============================================================
