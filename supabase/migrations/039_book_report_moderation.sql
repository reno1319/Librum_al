-- LIBRUM 2.0 LAUNCH-FIX-1B MOD-1: the smallest safe operational
-- moderation queue behind the EXISTING binary requireAdmin()/is_admin()
-- model. ADMIN-1A's staff_members/permission-matrix RBAC has not
-- started and is explicitly out of scope here (see the MOD-1 brief).
--
-- book_reports has existed since migration 009 as write-only: a reader
-- can insert a report, but there has never been any SELECT policy at
-- all -- not even for admins -- so every submitted report has only
-- ever been reviewable directly in the Supabase dashboard's Table
-- Editor. That is the confirmed MOD-1 root cause: submission works,
-- there is no operational read/disposition path.
--
-- This migration closes that gap with the narrowest change that does:
-- three new columns mirroring refund_requests' own
-- reviewed_at/reviewed_by/admin_notes shape exactly (migration 029),
-- one admin-only SELECT policy mirroring "Admins can view all refund
-- requests" verbatim, and one SECURITY DEFINER RPC mirroring
-- review_refund_request() verbatim -- adapted only for book_reports'
-- own two-value decision ('resolved'/'dismissed' vs
-- 'approved'/'rejected') and its 'open' starting status (vs
-- 'requested').
--
-- Deliberately NOT touched: book_reports' base table-level grant.
-- Unlike refund_requests (hardened in the very migration that
-- introduced it) or purchases/bundle_checkout_snapshots/discount_codes
-- (migration 034's later ACL hardening pass), book_reports still relies
-- on Supabase's default schema-level grant to authenticated, with RLS
-- as the sole real gate -- exactly how its own pre-existing INSERT
-- policy already works today with no explicit grant statement anywhere
-- near it. Retroactively hardening that grant is a separate, general
-- ACL cleanup outside MOD-1's own stated scope ("queue visibility +
-- report disposition only"); RLS alone already fully achieves
-- "admin SELECT only" for this pass's purposes.
--
-- No staff_members, no requireStaff(), no author suspension, no audit
-- log table -- all explicitly out of scope per the MOD-1 brief.
-- reviewed_by/reviewed_at/admin_notes are the only traceability this
-- pass adds, matching review_refund_request()'s own precedent for
-- "enough until the durable staff-audit architecture lands."

alter table public.book_reports
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references public.profiles(id) on delete set null,
  add column admin_notes text;

-- Same shape as "Admins can view all refund requests" (migration 029):
-- no `to authenticated` role qualifier, matching that policy exactly --
-- is_admin() already returns false for an anon caller regardless (it
-- checks profiles.id = auth.uid(), and auth.uid() is null for anon), so
-- omitting the role clause is safe and simply mirrors the existing
-- convention rather than introducing a new one.
--
-- Dependency-order note: is_admin() was defined in migration 029, long
-- before this one, so there is no ordering hazard applying this
-- migration against a real, already-migrated database -- unlike
-- schema.sql's own single-file layout, where book_reports' original
-- CREATE TABLE happens to appear textually before is_admin() is
-- defined later in that same consolidated file (see this migration's
-- companion edit to schema.sql, which places the equivalent policy/RPC
-- in a later section for exactly that reason).
create policy "Admins can view all book reports"
  on public.book_reports
  for select
  using (public.is_admin());

-- review_book_report(): the sole path by which an admin may move a
-- book_reports row from 'open' to 'resolved' or 'dismissed'. There has
-- never been an UPDATE policy on this table (direct authenticated
-- UPDATE was never possible), so this RPC is simply the only way these
-- columns can ever be written -- not a narrowing of some prior open
-- surface. reviewed_by and reviewed_at are always derived internally
-- (auth.uid(), now()) and can never be supplied by the caller, matching
-- review_refund_request()'s own identity-derivation discipline exactly.
--
-- Concurrency: the update only ever applies `where status = 'open'`,
-- so two admins racing the same report cannot silently overwrite each
-- other's terminal decision -- the loser's UPDATE matches zero rows,
-- v_updated_id stays null, and they get 'no reviewable report found
-- for this id' (mapped to "This report has already been reviewed." at
-- the application layer) rather than a second, conflicting write.
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

  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('resolved', 'dismissed') then
    raise exception 'p_decision must be ''resolved'' or ''dismissed''';
  end if;

  -- Same 2000-character cap as refund_requests.admin_notes's own RPC
  -- check (review_refund_request(), migration 029), for consistency.
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

revoke all on function public.review_book_report(uuid, text, text) from public;
revoke all on function public.review_book_report(uuid, text, text) from anon;
revoke all on function public.review_book_report(uuid, text, text) from authenticated;
grant execute on function public.review_book_report(uuid, text, text) to authenticated;
