-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LIBRUM 2.0 ADMIN-1A: replaces the binary admin authorization
-- foundation (profiles.role = 'admin' / is_admin()) with a proper
-- staff/RBAC layer. See the ADMIN-1A audit/design report for the full
-- reasoning; summarized here only where it explains a specific choice
-- made in this file.
--
-- Compatibility-first, not rip-and-replace: profiles.role and is_admin()
-- are deliberately left in place, unused by any remaining application
-- call site after this migration, as an explicit temporary compatibility
-- layer -- removal is out of scope for ADMIN-1A and can happen in a later
-- cleanup migration once nothing depends on it being present. This
-- mirrors the exact "compatibility wrapper, not deletion" posture this
-- migration's own design brief asks for.
--
-- If you're setting up a fresh project, just run schema.sql instead --
-- it already includes all of this.
--
-- ORDERING INVARIANT (added after a production apply failure): every
-- function this file's CREATE POLICY/REVOKE/GRANT statements reference
-- must already be defined earlier in this same file. A plpgsql/SQL
-- function BODY (e.g. review_book_report() calling staff_has_permission())
-- is safe regardless of order -- Postgres resolves those references
-- lazily, at first execution, not at CREATE FUNCTION time. A CREATE
-- POLICY's USING/WITH CHECK expression is NOT safe regardless of order --
-- it is parsed and resolved immediately, as part of the DDL statement
-- itself. The first version of this migration violated this for exactly
-- one statement (the staff.view-gated staff_members policy, originally
-- placed before staff_has_permission()'s own definition) and failed in
-- production with "function public.staff_has_permission(unknown) does
-- not exist" (SQLSTATE 42883) -- corrected below. This file's statement
-- order now matches supabase/schema.sql's own (already-correct) ordering
-- exactly.

-- ============================================================
-- staff_members: the new canonical source of staff identity. One row per
-- staff member, keyed by profile id (not a separate identity) -- a staff
-- member is always also a profile. role is a single persisted string;
-- permissions are NOT persisted here or anywhere in the database -- they
-- are defined exactly once, in TypeScript, at src/lib/staff-permissions.ts.
-- The only database-side copy of the role->permission matrix is the
-- small, explicitly-synchronized CASE expression inside
-- staff_has_permission() below -- see that function's own comment for why
-- that limited duplication was judged safe here, unlike a full
-- table-based permission system would be.
--
-- ON DELETE CASCADE on user_id (not SET NULL, unlike this schema's
-- financial/audit tables): a staff_members row has no meaning once its
-- owning profile is gone -- it is a live grant, not a historical record,
-- so it should simply cease to exist alongside the profile. created_by is
-- SET NULL instead, for the same reason applied everywhere else in this
-- schema to an audit-trail reference (see refund_requests.reviewed_by):
-- deleting the granting admin's own profile later must not cascade into
-- deleting the grants they made.
-- ============================================================

create table public.staff_members (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'moderator', 'support')),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  -- Not yet auto-maintained by any trigger or UPDATE path -- there is no
  -- staff-management mutation surface in ADMIN-1A (see the ADMIN-1B
  -- boundary in the design brief). Included now so the column exists
  -- before ADMIN-1B's staff-management RPC needs to start setting it,
  -- rather than requiring a schema change at that point.
  updated_at timestamptz not null default now()
);

alter table public.staff_members enable row level security;

-- Explicit least-privilege table grants, matching this schema's own
-- established convention (see refund_requests, migration 029): revoke
-- everything Supabase's ambient default privilege provisioning would
-- otherwise hand anon/authenticated, then grant back only what's actually
-- needed. No INSERT/UPDATE/DELETE grant to anyone, on either role, at any
-- point in this file -- there is no client-facing mutation path for this
-- table in ADMIN-1A (see the self-promotion-impossible requirement in the
-- design brief). service_role is untouched (only anon and authenticated
-- are named) -- only a future SECURITY DEFINER staff-management RPC
-- (ADMIN-1B) or a migration/service-role operation can ever write here.
revoke all on public.staff_members from anon, authenticated;
grant select on public.staff_members to authenticated;

-- A staff member must be able to read their OWN row regardless of role or
-- permission -- this is what makes getStaffMember()/requireStaff() in
-- src/lib/staff.ts work at all through the request-scoped, RLS-respecting
-- client (not the admin client). Scoped identically to every other
-- "read your own row" policy in this schema (auth.uid() = <owner column>).
create policy "Staff can view their own staff_members row"
  on public.staff_members
  for select
  using (auth.uid() = user_id);

-- The broader "staff.view can see every row" policy is deferred to
-- later in this file, immediately after staff_has_permission() itself is
-- defined -- CREATE POLICY's USING expression is parsed and resolved
-- immediately as part of the DDL statement (unlike a plpgsql/SQL
-- function body, whose internal references are resolved lazily, at
-- first execution, not at CREATE FUNCTION time). staff_has_permission()
-- does not exist yet at this point in the file, so a CREATE POLICY here
-- referencing it would fail with "function ... does not exist"
-- (SQLSTATE 42883) -- exactly the production failure this migration was
-- corrected to avoid. See that later policy's own comment for the rest
-- of its rationale (RLS foundation for ADMIN-1B, not the staff-directory
-- UI itself).

-- Deliberately NO insert/update/delete policy for any role, anywhere in
-- this file. Combined with the revoke above (no table-level grant for
-- those commands either), this is doubly enforced: no privilege AND no
-- policy. The only way a staff_members row can ever be created or changed
-- today is this migration's own backfill below (running as the
-- migration-applying role, which bypasses RLS) or a future service-role
-- operation. No normal profile update, and no client request of any kind,
-- can create or modify a row here -- staff self-promotion is structurally
-- impossible, not merely discouraged.

-- ============================================================
-- staff_has_permission(): the single SQL-side authorization primitive for
-- every staff-gated RLS policy and RPC this and future ADMIN work needs.
-- SECURITY DEFINER / empty search_path / stable, same hardening posture
-- as is_admin() before it -- and, like is_admin() querying profiles
-- internally, this function's own query against staff_members runs as
-- this function's owner (the migration-applying role), which is not
-- itself subject to staff_members' RLS policies -- confirmed safe by the
-- same precedent already established and working for is_admin() and
-- every other SECURITY DEFINER helper in this schema, not a new risk.
--
-- Design choice (evaluated per the ADMIN-1A design brief): a generic
-- is_staff() existence check was considered and rejected as the sole V1
-- shape -- it cannot express "moderator may resolve reports but not
-- refunds," which review_book_report()/review_refund_request() below
-- both need. staff_has_permission(text) was chosen instead, accepting the
-- one deliberate, explicit duplication this creates: this CASE expression
-- is a second copy of the role->permission matrix already defined
-- canonically in src/lib/staff-permissions.ts. This is judged safe here
-- specifically because the matrix is small (5 roles x 7 permissions, most
-- cells empty) and rarely-changing, and because
-- supabase/tests/040_staff_rbac_foundation.test.sql walks every
-- (role, permission) pair and asserts this function agrees with the
-- TypeScript matrix -- that test is the actual safeguard against the two
-- copies silently drifting apart, not just documentation of intent.
--
-- 'editor' has no branch below -- ADMIN-1A grants it zero permissions
-- (no internal editorial admin surface exists yet to justify admin
-- access merely because the role exists -- see the design brief's own
-- explicit instruction on this). Adding editor permissions later means
-- adding one branch here and one entry in the TypeScript matrix, kept in
-- sync by the same contract test.
-- ============================================================

create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
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
            'refunds.view', 'refunds.resolve', 'staff.view'
          )
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

revoke all on function public.staff_has_permission(text) from public;
revoke all on function public.staff_has_permission(text) from anon;
revoke all on function public.staff_has_permission(text) from authenticated;
grant execute on function public.staff_has_permission(text) to authenticated;

-- Deferred from staff_members' own section above -- see that section's
-- comment for why this couldn't be created until staff_has_permission()
-- existed. Broader visibility, gated by the staff.view permission itself
-- rather than by any specific role -- this is the RLS foundation
-- ADMIN-1B's staff-directory UI will read through directly, added now
-- (not deferred to a later migration) so that landing it later needs no
-- further migration purely for RLS. This is NOT the staff-directory UI
-- itself (explicitly out of scope for ADMIN-1A) -- it is inert until a
-- page or Server Action actually queries this table for that purpose.
create policy "Staff with staff.view can view all staff_members rows"
  on public.staff_members
  for select
  using (public.staff_has_permission('staff.view'));

-- ============================================================
-- Owner bootstrap: backfill every existing profiles.role = 'admin' row
-- into staff_members as 'owner', not merely 'admin'. This is deliberate,
-- not the narrowest possible mapping: an 'admin'-role staff member has
-- every permission an 'owner' has EXCEPT staff.manage (which did not
-- exist as a concept at all before this migration, so "preserve existing
-- behavior" alone doesn't require it) -- but staff.manage is meaningless
-- for the platform's whole future if zero rows can ever hold it, since
-- there is no self-promotion path and ADMIN-1B's staff-management UI
-- does not exist yet to grant it to anyone. Backfilling as 'owner'
-- specifically avoids that bootstrapping deadlock, matching the ADMIN-1A
-- design brief's own "Owner bootstrap" framing. No email or UUID is
-- hardcoded here -- every currently-trusted admin, whoever they are, is
-- carried forward automatically from the existing profiles.role state.
--
-- created_by is left NULL, not self-referential: this row was not
-- granted by any staff member's action, it was inherited from
-- pre-ADMIN-1A legacy state by this migration itself -- NULL honestly
-- represents that, rather than fabricating a grantor.
--
-- on conflict (user_id) do nothing: makes this INSERT safe to reason
-- about even if this migration were ever mistakenly applied against a
-- database that already had staff_members rows for these same profiles
-- (not expected, but costs nothing to guard against) -- it will never
-- overwrite an existing row's role.
-- ============================================================

insert into public.staff_members (user_id, role, created_by)
select id, 'owner', null
from public.profiles
where role = 'admin'
on conflict (user_id) do nothing;

-- ============================================================
-- book_reports: swap the admin-only SELECT policy from is_admin() to
-- staff_has_permission('reports.view'). Nothing else about book_reports
-- changes -- the reader-facing INSERT policy, the reporter's own
-- visibility, and every column added by migration 039 are all untouched.
-- ============================================================

drop policy "Admins can view all book reports" on public.book_reports;

create policy "Staff with reports.view can view all book reports"
  on public.book_reports
  for select
  using (public.staff_has_permission('reports.view'));

-- review_book_report(): unchanged signature and every behavior except the
-- authorization check itself, which now requires reports.resolve instead
-- of is_admin(). CREATE OR REPLACE FUNCTION on an unchanged signature
-- preserves this function's existing grants (migration 039's
-- revoke-all-then-grant-execute-to-authenticated block), so it is not
-- repeated here -- same convention already established by migration 026.
create or replace function public.review_book_report(
  p_id uuid,
  p_decision text,
  p_admin_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_updated_id uuid;
begin
  v_admin_id := auth.uid();
  if v_admin_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('resolved', 'dismissed') then
    raise exception 'p_decision must be ''resolved'' or ''dismissed''';
  end if;

  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  update public.book_reports
  set status = p_decision,
      reviewed_at = pg_catalog.now(),
      reviewed_by = v_admin_id,
      admin_notes = nullif(trim(coalesce(p_admin_notes, '')), '')
  where id = p_id
    and status = 'open'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no reviewable report found for this id';
  end if;
end;
$$;

-- ============================================================
-- refund_requests / refund_request_items: same swap, from is_admin() to
-- staff_has_permission('refunds.view'). No other behavior changes --
-- reader-facing policies, request_refund(), and cancel_refund_request()
-- are all untouched.
-- ============================================================

drop policy "Admins can view all refund requests" on public.refund_requests;

create policy "Staff with refunds.view can view all refund requests"
  on public.refund_requests
  for select
  using (public.staff_has_permission('refunds.view'));

drop policy "Admins can view all refund request items" on public.refund_request_items;

create policy "Staff with refunds.view can view all refund request items"
  on public.refund_request_items
  for select
  using (public.staff_has_permission('refunds.view'));

-- review_refund_request(): same treatment as review_book_report() above
-- -- unchanged signature/behavior except the authorization check, now
-- refunds.resolve instead of is_admin(). Grants preserved automatically
-- (migration 029's block), not repeated here.
create or replace function public.review_refund_request(
  p_id uuid,
  p_decision text,
  p_admin_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_updated_id uuid;
begin
  v_admin_id := auth.uid();
  if v_admin_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'p_decision must be ''approved'' or ''rejected''';
  end if;

  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  update public.refund_requests
  set status = p_decision,
      reviewed_at = pg_catalog.now(),
      reviewed_by = v_admin_id,
      admin_notes = nullif(trim(coalesce(p_admin_notes, '')), '')
  where id = p_id
    and status = 'requested'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no reviewable refund request found for this id';
  end if;
end;
$$;
