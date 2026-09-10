-- PHASE-1C round-4 review, finding 4: the staging fixture scripts
-- (scripts/staging-fixtures/) previously gated author_payout_
-- destinations, payout_destination_snapshots, and payout_reversal
-- behind a persistent, human-set boolean environment variable -- those
-- 3 tables have `revoke all ... from anon, authenticated, service_role`
-- (migrations introducing them), so the fixture scripts' service-role
-- Data API client has ZERO grant on them, and a direct REST count is
-- structurally impossible, not merely undesirable. The round-4 review
-- rejected the boolean workaround ("must actually obtain the required
-- counts") and required "a narrowly scoped, reviewed count-only
-- mechanism ... disclose no row contents, avoid weakening table
-- grants, and be restricted appropriately (including fixed search_path
-- and revoked public/anon/authenticated execution if a SECURITY
-- DEFINER RPC is used)."
--
-- This migration adds exactly that: a single SECURITY DEFINER,
-- count-only RPC, scoped to ONE caller-supplied author id (never a
-- wildcard), that returns nothing but a row count per table -- no row
-- content, no other author's data reachable at all. It runs with its
-- OWNING role's privilege (never the caller's), which is the only way
-- to answer "how many rows" without granting SELECT on the underlying
-- tables directly -- this does NOT weaken any of the 3 tables' own
-- `revoke all` grants; RLS/table grants on those tables are completely
-- unchanged by this migration.
--
-- Hardening, matching this schema's own established SECURITY DEFINER
-- convention (see e.g. migration 037's author_lost_disputed_payment_
-- intents(), list_payout_batch_export() further down this same file):
--   - `set search_path = ''` -- every reference below is fully schema-
--     qualified (public.<table>), closing the classic SECURITY DEFINER
--     search_path-hijack vector (also the #1 automated Postgres/
--     Supabase advisor finding for a DEFINER function without this).
--   - EXECUTE revoked from public, anon, AND authenticated explicitly,
--     then granted ONLY to service_role -- an ordinary request-scoped
--     client (anon key or a signed-in user's JWT) can never call this,
--     even though it is schema-visible. It never becomes a new read
--     surface for anyone but the staging fixture scripts' own
--     service-role client.
--   - `stable`, not `volatile` -- this function only ever reads.
--
-- NOTE (PHASE-1C rounds 5-6): this migration was applied to, and its
-- privilege/behavior claims independently verified against, a
-- DISPOSABLE LOCAL PostgreSQL 16 instance (never any remote/hosted
-- Supabase project) -- see PHASE-1C's round-5 and round-6
-- REVIEW-REPORT.txt for the exact commands and output. That
-- verification directly confirmed: anon and authenticated are both
-- refused EXECUTE (permission denied); service_role succeeds and
-- receives correct, author-scoped counts for both a populated and an
-- all-zero case; pg_proc's own proconfig shows a fixed, empty
-- search_path and prosecdef=true; and proacl shows EXECUTE granted to
-- exactly {postgres (owner), service_role} with no PUBLIC entry at all.
-- supabase/tests/057_staging_fixture_protected_table_counts.test.sql (a
-- custom SQL assertion-based regression suite matching this
-- repository's own migrations 037/048-056 convention -- a plain
-- pg_temp.assert() helper, not the pgTAP extension) was also run and
-- passed against that same disposable instance.
--
-- Round 6 additionally ran the GENUINE Supabase CLI database advisor
-- (`npx supabase db advisors --db-url <local-postgres-connection-string>
-- --type all --level info --fail-on error`, CLI 2.117.0) directly
-- against that same disposable local instance, via --db-url -- this
-- does NOT require a linked/remote Supabase project (round 5 had
-- incorrectly assumed it did; that was a mistaken claim about the
-- tooling, corrected this round). The command exited status 1 and
-- reported 135 findings (75 INFO / 59 WARN / 1 ERROR). None mention
-- staging_fixture_protected_table_counts. The 3 findings touching this
-- migration's 3 tables (author_payout_destinations,
-- payout_destination_snapshots, payout_reversal) and the single ERROR
-- (security_definer_view on public.public_author_profiles, a view this
-- migration never touches) are all pre-existing -- proven by a pure-
-- append `git diff` of supabase/schema.sql against base commit
-- c574553b868ec927369bc2172edfa80aed3c5b44 showing zero lines removed
-- or modified anywhere outside this migration's own 41-line append.
-- See PHASE-1C's round-6 REVIEW-REPORT.txt for the complete raw advisor
-- output and this analysis in full.
--
-- If you're setting up a fresh project, just run schema.sql instead --
-- it already includes all of this.

create or replace function public.staging_fixture_protected_table_counts(p_author_id uuid)
returns table (table_name text, row_count bigint)
language sql
security definer
set search_path = ''
stable
as $$
  select 'author_payout_destinations'::text, count(*)
    from public.author_payout_destinations
    where author_id = p_author_id
  union all
  select 'payout_destination_snapshots'::text, count(*)
    from public.payout_destination_snapshots pds
    where pds.payout_id in (
      select id from public.author_payouts where author_id = p_author_id
    )
  union all
  select 'payout_reversal'::text, count(*)
    from public.payout_reversal pr
    where pr.payout_id in (
      select id from public.author_payouts where author_id = p_author_id
    );
$$;

revoke all on function public.staging_fixture_protected_table_counts(uuid) from public;
revoke all on function public.staging_fixture_protected_table_counts(uuid) from anon;
revoke all on function public.staging_fixture_protected_table_counts(uuid) from authenticated;
grant execute on function public.staging_fixture_protected_table_counts(uuid) to service_role;
