-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LAUNCH-1 P1-5: closes the anon ACL gap on public.profiles --
-- the exact same defect class already found and fixed for discount_codes/
-- reviews (migration 031) and refund_requests (migration 029): a
-- column-scoped or table-scoped REVOKE was applied to authenticated
-- (migrations 003 and 028), but anon was never independently targeted.
-- REVOKE/GRANT are per-role, independent ACL entries -- narrowing one
-- role's privileges has zero effect on another's -- so anon has retained
-- Supabase's full ambient default table-level privileges (SELECT,
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) on every
-- column of profiles, including role, stripe_account_id, and
-- stripe_payouts_enabled, since the table was created.
--
-- Not exploitable via a normal anon request today: the UPDATE policy's
-- `auth.uid() = id` independently blocks it at the row level, since a
-- request that resolves to the anon role structurally has no
-- auth.uid() (the anon API key carries no `sub` claim; role and
-- identity both come from the same verified JWT). But this is precisely
-- the "RLS restricts rows, not privileges -- relying on that instead of
-- an explicit revoke is the gap itself" lesson this codebase has applied
-- everywhere else, and the columns exposed here are higher-stakes than
-- discount_codes' ever were: role gates every admin-authorization check
-- in the app (is_admin(), requireAdmin()), and stripe_account_id
-- controls where an author's payout money is sent.
--
-- LAUNCH-1 P1-5 audit (full trace of every profiles read/write in
-- src/, every RLS policy, every existing GRANT/REVOKE in this repo, and
-- a live production information_schema/pg_policies verification) found
-- no other gap: authenticated's UPDATE grant was already correctly
-- narrowed to display_name/bio/avatar_path by migration 028; INSERT and
-- DELETE are already unconditionally blocked for every role by RLS's
-- own default-deny (profiles has zero INSERT and zero DELETE policies,
-- so no policy ever matches, regardless of ACL); no SECURITY DEFINER
-- function writes profiles.role or the Stripe columns; service_role is
-- untouched by anything below and already has everything the server
-- legitimately needs (confirmed: it already successfully writes
-- stripe_account_id/stripe_payouts_enabled and handle_new_user()'s
-- INSERT already runs as the function owner, not as any PostgREST role,
-- so none of this touches signup either).
--
-- Reset-and-regrant, not a narrower REVOKE: `revoke all ... from anon,
-- authenticated` first removes every privilege type (including the ones
-- Supabase's own ambient defaults hand out that this repo's own SQL has
-- never once explicitly named -- SELECT, INSERT, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER), then each role is re-granted exactly what it
-- legitimately needs. This is deliberately more thorough than a
-- targeted `revoke update ... from anon` alone would be: it also closes
-- INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER for anon and authenticated,
-- which were never independently verified safe before (they happen to
-- be inert today only because of RLS's default-deny for INSERT/DELETE,
-- and because no application code or migration ever needed
-- TRUNCATE/REFERENCES/TRIGGER on this table through PostgREST) -- making
-- that inertness explicit and structural rather than incidental.
revoke all on public.profiles from anon, authenticated;

-- Both roles keep public readability -- "Profiles are viewable by
-- everyone" (the SELECT policy) is intentional, unchanged product
-- behavior, not part of this gap.
grant select
  on public.profiles
  to anon, authenticated;

-- Unchanged from migration 028's own narrow grant, just re-established
-- from a clean slate: authenticated may UPDATE exactly the three
-- columns updateProfile() (src/app/dashboard/profile/actions.ts) ever
-- writes. anon gets no UPDATE grant at all -- it has no legitimate
-- reason to update anything on this table, unlike authenticated.
grant update (display_name, bio, avatar_path)
  on public.profiles
  to authenticated;

-- Defense-in-depth, not a substitute for the column ACL above: makes
-- the post-update ownership invariant an explicit WITH CHECK rather
-- than relying on Postgres's implicit reuse of USING when WITH CHECK is
-- absent (the exact same upgrade already applied to discount_codes/
-- reviews in migration 031, and to the same structural gap class this
-- table shares with them). auth.uid() = id is already true before this
-- statement for every row this policy can ever match, and updateProfile()
-- never includes id in its update payload, so no legitimate write is
-- affected -- this only forecloses a row's id ever changing out from
-- under its owner via a raw PATCH, which the column ACL doesn't
-- separately guard against (id was never included in authenticated's
-- granted column set, but making the invariant explicit here means it
-- holds even if that ever changed).
alter policy "Users can update their own profile"
  on public.profiles
  using (auth.uid() = id)
  with check (auth.uid() = id);
