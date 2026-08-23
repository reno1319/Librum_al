-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LAUNCH-1 P1-6 remediation: closes the P2 findings from the
-- full database authorization surface audit. None of these are
-- currently exploitable -- every one is independently closed today by
-- RLS (either a correctly row-scoped policy, or zero policy at all for
-- the risky command, which default-denies it regardless of ACL) -- but
-- each is the same "ambient default privilege never independently
-- revoked" defect class already found and fixed for profiles (033) and
-- discount_codes/reviews (031), on tables/functions where it happened
-- not to be reachable rather than tables where it was. Making that
-- inertness explicit and structural, rather than incidental, is the
-- whole point of closing it anyway. If you're setting up a fresh
-- project, just run schema.sql instead -- it already includes all of
-- this.

-- ============================================================
-- 1. purchases: the money ledger. Never had an explicit table-level
-- ACL statement -- ambient default privileges (SELECT, INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES, TRIGGER) have stood, un-revoked, for
-- anon and authenticated since this table was created. Inert only
-- because this table defines zero INSERT/UPDATE/DELETE policy for any
-- role (see the P1-6 audit) -- the Stripe webhook, via service_role,
-- is the only writer. authenticated needs SELECT only: every
-- request-scoped read against this table in this codebase (library
-- order history, the sales dashboard, every ownership/eligibility
-- check in books/[id]/actions.ts and the download route) runs behind
-- an explicit `if (!user) redirect(...)` or an equivalent
-- already-authenticated guard. anon gets nothing at all: both existing
-- SELECT policies ("Readers can view their own purchases", "Authors
-- can view purchases of their own books") require auth.uid(), which an
-- anon session never has, so an anon grant would return zero rows
-- through RLS regardless -- there is no legitimate anon read path to
-- preserve. service_role is untouched (only anon and authenticated are
-- named below) -- it already has everything the webhook needs.
-- ============================================================
revoke all on public.purchases from anon, authenticated;

grant select
  on public.purchases
  to authenticated;

-- ============================================================
-- 2. bundle_checkout_snapshots: the same pattern, same reasoning. Both
-- existing SELECT policies ("Authors can view their own fulfilled
-- bundle snapshot transactions", "Readers can view their own fulfilled
-- bundle snapshot transactions") require auth.uid(), so anon gets
-- nothing; every request-scoped read (library.page.tsx's refund-window
-- grouping, dashboard/sales/page.tsx's revenue rollup) runs behind an
-- already-authenticated guard. Zero INSERT/UPDATE/DELETE policy exists
-- for any role -- create_bundle_checkout_snapshot() (SECURITY DEFINER)
-- and the Stripe webhook (service_role) are the only writers.
-- service_role is untouched.
-- ============================================================
revoke all on public.bundle_checkout_snapshots from anon, authenticated;

grant select
  on public.bundle_checkout_snapshots
  to authenticated;

-- ============================================================
-- 3. discount_codes: migration 031 revoked UPDATE from anon/
-- authenticated and re-granted UPDATE(active) to authenticated, but --
-- unlike profiles (033) and refund_requests (029) -- never reset
-- SELECT/INSERT/DELETE the same way: those three have stood on
-- Supabase's ambient default privileges, un-revoked, since this table
-- was created. Not exploitable (every policy on this table is
-- correctly row-scoped to auth.uid() = author_id, re-verified against
-- real book ownership on every write), but inconsistent with this
-- codebase's own reset-and-regrant convention. This supersedes 031's
-- narrower `revoke update` with the full model, traced end-to-end
-- against src/app/dashboard/discounts/actions.ts (the only
-- authenticated-client writer): createDiscountCode INSERTs,
-- dashboard/discounts/page.tsx SELECTs the author's own codes,
-- toggleDiscountCode UPDATEs exactly `{ active }`, deleteDiscountCode
-- DELETEs. No authenticated code path ever needs anything beyond that
-- four-operation set, and no anon code path needs this table at all --
-- the one anon-adjacent lookup (matching a code string at checkout) is
-- done server-side with the service role key against books/[id]/
-- actions.ts, never through a client-facing select. The UPDATE
-- policy's own WITH CHECK (added by migration 031) is untouched by
-- this migration -- only the table/column ACL layer changes here.
-- ============================================================
revoke all on public.discount_codes from anon, authenticated;

grant select, insert, delete
  on public.discount_codes
  to authenticated;

grant update (active)
  on public.discount_codes
  to authenticated;

-- ============================================================
-- 4. handle_new_user(): normalizes search_path from public to the
-- empty-string convention every other SECURITY DEFINER function in
-- this schema uses. Confirmed non-exploitable as it already stood, by
-- direct code read (P1-6 audit): every table reference in the body is
-- already schema-qualified (public.profiles), and its one unqualified
-- call, split_part(), resolves via pg_catalog regardless of
-- search_path, since pg_catalog is always implicitly searched first
-- unless explicitly repositioned in search_path -- there is no object
-- a caller could plant in `public` to shadow it. This is a consistency
-- fix, not a live exploit closure.
--
-- Also revokes EXECUTE from public/anon/authenticated -- the same
-- belt-and-suspenders treatment already given to this schema's other
-- two trigger functions (clear_expired_book_reservations,
-- clear_expired_reader_holds, both revoked in schema.sql). This cannot
-- break signup: RETURNS TRIGGER already makes direct invocation
-- structurally impossible ("trigger functions can only be called as
-- triggers" -- a Postgres-level restriction, independent of EXECUTE
-- grants), and the trigger mechanism that fires this function after
-- insert on auth.users never checks EXECUTE privilege on the function
-- it's firing. service_role is untouched. CREATE OR REPLACE FUNCTION
-- does not reset a function's existing ACL -- the explicit revoke
-- below is what actually closes the ambient PUBLIC EXECUTE grant this
-- function has held, unrevoked, since it was first created.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    case
      when new.raw_user_meta_data->>'role' = 'author' then 'author'
      else 'reader'
    end,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer set search_path = '';

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ============================================================
-- 5. Explicit WITH CHECK on books/bundles/series UPDATE policies.
-- Already proven non-exploitable: with no WITH CHECK, Postgres reuses
-- the USING expression as the post-update check, so an author
-- attempting to reassign author_id to escape ownership already fails
-- (the new row would need auth.uid() = <new author_id> to pass, which
-- it structurally never does for anyone but the row's original owner).
-- Made explicit here purely for consistency with the pattern already
-- established for profiles (033) and discount_codes/reviews (031) --
-- the check expression is identical to what was already being
-- implicitly enforced, so no RLS behavior changes for any legitimate
-- caller.
-- ============================================================
alter policy "Authors can update their own books"
  on public.books
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

alter policy "Authors can update their own bundles"
  on public.bundles
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

alter policy "Authors can rename their own series"
  on public.series
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);
