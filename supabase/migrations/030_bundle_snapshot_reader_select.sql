-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Phase REFUND-1B Step 2 correction: adds the ONE missing
-- reader SELECT policy on bundle_checkout_snapshots. See the Phase
-- REFUND-1B Step 2 audit for the full reasoning; summarized here only
-- where it explains this migration's specific, narrow scope.
--
-- Without this, a reader-initiated bundle checkout where every item in
-- the bundle turned out, at payment time, to already be actively owned
-- through some unrelated transaction (fulfillBundleSnapshot's
-- "active_other_session" classification -- see the webhook) is a real,
-- paid, fulfilled transaction with ZERO purchases rows. Nothing in the
-- reader-facing app can currently read that transaction at all:
-- migration 025 deliberately added zero reader/authenticated policies
-- to this table ("nothing in the product surfaces 'my pending
-- checkout' to a reader anywhere"), and migration 027 later added
-- exactly one SELECT policy, scoped to auth.uid() = author_id only, for
-- the sales dashboard's revenue reporting -- never to reader_id. A
-- reader has never had a way to see their own row here, even though
-- reader_id has existed on this table since migration 025.
--
-- Privilege model check before adding this (per the audit): no
-- migration has ever added an explicit GRANT/REVOKE for this table --
-- it has only ever relied on Supabase's own ambient default table-level
-- privilege provisioning for authenticated. The existing author-scoped
-- policy from migration 027 is already live in production and already
-- backs the sales dashboard's revenue reads via the ordinary,
-- RLS-respecting client (not the admin client) -- if authenticated
-- lacked table-level SELECT on this table, that policy would already be
-- silently non-functional today, which it demonstrably is not. This is
-- therefore added as an RLS policy ONLY -- no GRANT/REVOKE statement is
-- added here, since the required table-level SELECT privilege is
-- already effectively present and adding a redundant explicit grant
-- would add nothing but noise.
--
-- Scoped identically in shape to the existing author policy, just
-- reader-scoped instead: auth.uid() = reader_id (own rows only, same
-- boundary already used everywhere else a reader reads their own data
-- in this schema), and fulfilled_at is not null (an in-flight, unpaid,
-- or expired checkout attempt stays exactly as invisible to its own
-- reader as it always was -- "nothing surfaces my pending checkout"
-- remains true; only a completed, paid transaction becomes visible).
-- SELECT only -- no INSERT/UPDATE/DELETE capability is granted or
-- implied by this policy, and none is added anywhere in this file.
create policy "Readers can view their own fulfilled bundle snapshot transactions"
  on public.bundle_checkout_snapshots
  for select
  using (
    auth.uid() = reader_id
    and fulfilled_at is not null
  );
