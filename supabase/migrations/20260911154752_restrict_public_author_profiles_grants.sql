-- SUPABASE SECURITY AUDIT: closes an unintended write-grant surface on
-- public.public_author_profiles found during a live-database security
-- audit of the Supabase Advisor's `security_definer_view` ERROR finding
-- for this view.
--
-- Context: migration 045 created this view and ran
--   grant select on public.public_author_profiles to anon, authenticated;
-- WITHOUT first running `revoke all ... from anon, authenticated;` --
-- unlike the pattern this same codebase correctly used for the
-- `profiles` base table itself (migration 033, and migration 046's own
-- `revoke all on public.profiles from anon, authenticated` before
-- re-granting exactly what's needed). Supabase's `public` schema hands
-- new tables/views ambient default privileges to anon/authenticated/
-- service_role unless explicitly revoked, and this view never had them
-- revoked.
--
-- Confirmed live (both Staging and Production, prior to this migration
-- applying to either): the view's raw ACL was
--   {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--    authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
-- i.e. anon and authenticated held INSERT, SELECT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN -- not merely the intended
-- SELECT. No PUBLIC entry, no role-membership inheritance, and no
-- column-level ACL contributed any of this -- it was a direct table-
-- level grant on every one of those privilege types.
--
-- Because public_author_profiles is a Postgres "simple automatically
-- updatable view" (single base relation, no joins/aggregates/DISTINCT,
-- only the standard internal `_RETURN` rule -- confirmed, no custom
-- INSTEAD rule exists), a write issued directly against the view is
-- transparently rewritten by Postgres into the equivalent write against
-- the underlying `profiles` table, requiring only the VIEW's owner (not
-- the invoking role) to hold the base-table privilege. This was proven
-- empirically and with zero data risk during the audit: as `anon`,
-- `UPDATE public.public_author_profiles SET bio = bio WHERE false` and
-- `DELETE FROM public.public_author_profiles WHERE false` (a predicate
-- that can never match a real row) both executed without a permission
-- error, inside a transaction that was rolled back -- meaning an
-- unauthenticated caller could reach the write path this view was never
-- meant to expose, entirely bypassing `profiles`' own RLS/grant
-- lockdown (migration 046).
--
-- This migration does NOT touch: the view's definition, its owner, its
-- `security_invoker` setting (still intentionally unset -- see the
-- audit report for why the read-side SECURITY DEFINER behavior is a
-- deliberate, reviewed design that must be preserved for public
-- cross-user author-attribution reads to keep working), the view's
-- exposed columns, its `role = 'author'` filter, or anything on the
-- `profiles` base table (RLS, policies, or grants). SELECT for anon and
-- authenticated is explicitly re-affirmed below (idempotent -- no
-- behavior change), never REVOKE ALL, since that privilege must remain
-- continuously present throughout this migration.
revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.public_author_profiles
  from anon, authenticated;

grant select
  on table public.public_author_profiles
  to anon, authenticated;
