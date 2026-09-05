-- LIBRUM 2.0 AUTHOR-1D STAGE 2: the database-level privacy lockdown
-- deferred out of migration 045 specifically so that migration could be
-- applied safely against a live production database still running the
-- CURRENT (pre-AUTHOR-1) application -- see 045's own header for the
-- full two-stage rollout rationale.
--
-- ============================================================
-- PRECONDITION: only apply this migration once the AUTHOR-1 application
-- (the one reading author attribution through public_author_profiles,
-- migration 045) is deployed and confirmed live. Applying it any earlier
-- reproduces the exact single-stage hazard AUTHOR-1D exists to avoid --
-- an old, still-running application would lose its own profiles SELECT
-- access.
-- ============================================================
--
-- Closes a confirmed database-level privacy hole (the AUTHOR-1C audit):
-- with "Profiles are viewable by everyone" (using (true)) still in
-- place, ANY anon or ordinary authenticated Supabase client could
-- directly SELECT any column of any row, including a pseudonymous
-- author's private display_name and even stripe_account_id/
-- stripe_payouts_enabled, completely bypassing every application-layer
-- fix AUTHOR-1B made. RLS restricts ROWS, never COLUMNS, so there is no
-- way to keep that policy and still hide display_name for someone
-- else's row while showing it for your own -- self-only visibility
-- below, combined with the public_author_profiles view already created
-- by migration 045 (which exposes reader-safe columns for every author
-- row regardless of this policy, since it runs as the view's owner, not
-- the querying role), is what actually closes this.
--
-- No application functionality changes in this migration -- every
-- column, constraint, trigger, view, and function the new app depends on
-- was already created by migration 045; this migration only touches
-- profiles' own SELECT policy and grants.

drop policy "Profiles are viewable by everyone" on public.profiles;

create policy "Users can view their own full profile"
  on public.profiles for select
  using (auth.uid() = id);

-- By migration 046's point in this repo's real history, staff_has_
-- permission() (migration 040) already exists, so -- unlike schema.sql,
-- a single consolidated bootstrap file where this policy must be
-- deferred until after that function's own definition -- there is no
-- ordering constraint here; both new profiles SELECT policies can be
-- created back to back.
--
-- Preserves every existing admin/moderation surface that reads another
-- user's account identity via the ordinary request-scoped client (never
-- the service-role/admin client) -- traced directly against every such
-- call site in the app: reports/[id]/page.tsx (reports.view), staff/
-- page.tsx (staff.view), refunds/page.tsx and refunds/[id]/page.tsx
-- (refunds.view), and the audit log's actor names (audit.view).
-- admin-shell.tsx and admin/(protected)/page.tsx's own greetings read
-- the SIGNED-IN staff member's own row (already covered by the self
-- policy above) and need no entry here. A staff role with none of these
-- permissions (e.g. 'editor', which staff_has_permission() grants
-- nothing to today) gets exactly the same zero-rows-for-another-user
-- result as any ordinary reader.
create policy "Staff with an authorized permission can view any profile"
  on public.profiles
  for select
  using (
    public.staff_has_permission('reports.view')
    or public.staff_has_permission('staff.view')
    or public.staff_has_permission('refunds.view')
    or public.staff_has_permission('audit.view')
  );

-- anon never has a legitimate reason to touch the base table directly
-- any more -- it never has an auth.uid(), so it can never satisfy the
-- self policy above, and it can never hold a staff permission either.
-- The only thing its previous table-level SELECT grant ever did was let
-- it read display_name/stripe_account_id/stripe_payouts_enabled for
-- EVERY OTHER user's row too (RLS restricts rows, not columns) -- this
-- revoke is what actually removes that ability, belt-and-suspenders
-- alongside the policy change above. authenticated keeps its existing
-- SELECT grant (migration 033) unchanged -- now restricted, by the
-- policies above, to its own row or a row an authorized staff permission
-- covers.
revoke select on public.profiles from anon;

-- public_author_profiles (migration 045) is untouched here -- its own
-- grant to anon/authenticated was never conditioned on profiles' own
-- policy (it runs as the view's owner, bypassing RLS entirely), so
-- public reader-facing author attribution keeps working identically
-- before and after this migration. search_books() (migration 045) is
-- likewise untouched -- it already reads exclusively through this view,
-- never the base table, so this migration's own grant/policy changes
-- have no effect on it at all.
