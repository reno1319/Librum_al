-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LAUNCH-1 P1-2 + P1-3 correction: hardens the UPDATE policies
-- on discount_codes and reviews, both of which had a USING clause but
-- NO with check -- the same "RLS restricts which rows, not which
-- columns/values" defect class already found and fixed for
-- refund_requests in earlier phases. Without a WITH CHECK, Postgres
-- reuses the USING expression for the post-update check, which for both
-- of these policies only re-verifies the identity column (author_id /
-- reader_id) is unchanged -- every OTHER column (book_id, most
-- critically) is completely unconstrained on UPDATE via a direct
-- authenticated API call.
--
-- ALTER POLICY is used instead of DROP+CREATE (matching migration 022,
-- the direct precedent for this exact class of fix on reviews' INSERT
-- policy) so neither policy is ever momentarily absent, and each
-- policy's own USING clause and name are left untouched -- only a WITH
-- CHECK is added.
--
-- Privilege model check before this (per the audit, same method already
-- used and documented in migration 030): no migration has ever added an
-- explicit GRANT/REVOKE for discount_codes or reviews -- both have only
-- ever relied on Supabase's own default table-level privilege
-- provisioning for authenticated, which (confirmed directly against a
-- live project via information_schema.role_table_grants -- see
-- schema.sql's own comment on the profiles table) grants UPDATE on
-- every column by default, unless explicitly narrowed. RLS's WITH CHECK
-- constrains which ROW VALUES are acceptable; it says nothing about
-- which COLUMNS may appear in the UPDATE's SET list at all -- that is a
-- separate, independent privilege layer, addressed per-table below.
--
-- If you're setting up a fresh project, just run schema.sql instead (it
-- already includes these corrected policies -- run this migration
-- afterward either way, on a fresh or an existing project).

-- ============================================================
-- discount_codes
-- ============================================================
--
-- WITH CHECK mirrors the existing INSERT policy's ownership check
-- exactly ("Authors can create discount codes for their own books"):
-- after the update, the row must still belong to the authenticated
-- author AND still point at a book that same author owns. This closes
-- the cross-author hijack (author A repoints their own code's book_id
-- to author B's book via a raw PATCH) without changing what the app
-- itself does -- traced against src/app/dashboard/discounts/actions.ts
-- in full: createDiscountCode only INSERTs; toggleDiscountCode and
-- deleteDiscountCode are the only UPDATE/DELETE paths, and
-- toggleDiscountCode's payload is exactly `{ active: !currentlyActive
-- }` -- it never touches book_id, author_id, code, percent_off,
-- amount_off_cents, or expires_at. The app therefore never needs to
-- move a code to a different book (even one it owns) or change any
-- other identity/pricing field via UPDATE at all.
--
-- Column-level grant: because toggleDiscountCode's UPDATE payload is a
-- plain, single-key object (not an upsert -- Supabase's .update() sets
-- exactly the columns given, nothing implicitly), narrowing the
-- grantable column set to exactly what the app uses is safe and carries
-- no risk of breaking that call. Mirrors the same two-layer pattern
-- already established for public.profiles (see schema.sql): RLS
-- constrains which rows/values, the column grant constrains which
-- columns can be named in an UPDATE's SET clause at all, independent of
-- RLS.
--
-- Revokes from BOTH anon and authenticated, not authenticated alone (a
-- post-apply information_schema.column_privileges check on production
-- caught this: an earlier version of this statement below only revoked
-- from authenticated, leaving anon's own separate, ambient default
-- table-level UPDATE grant on every column completely untouched --
-- REVOKE/GRANT are per-role, independent ACL entries, so revoking one
-- role's privilege has zero effect on another role's). Matches the
-- established least-privilege pattern already used for refund_requests
-- (migration 029: `revoke all on public.refund_requests from anon,
-- authenticated`) rather than the narrower, authenticated-only form
-- used for public.profiles above, which turned out not to generalize
-- safely. Not independently exploitable today regardless -- both this
-- table's RLS policies require auth.uid() to match a real row's
-- author_id/reader_id, and auth.uid() is NULL for an anon session, so a
-- raw anon UPDATE already matched zero rows via RLS alone -- but relying
-- on that instead of an explicit revoke is exactly the "RLS restricts
-- rows, not privileges" gap this entire migration exists to close
-- everywhere else; anon is given the same explicit, defense-in-depth
-- treatment as authenticated here, not left implicit.
alter policy "Authors can update their own discount codes"
  on public.discount_codes
  with check (
    auth.uid() = author_id
    and exists (
      select 1 from public.books
      where books.id = discount_codes.book_id
      and books.author_id = auth.uid()
    )
  );

revoke update on public.discount_codes from anon, authenticated;

grant update (active)
  on public.discount_codes
  to authenticated;

-- ============================================================
-- reviews
-- ============================================================
--
-- WITH CHECK mirrors the existing INSERT policy's ownership+refund
-- check exactly ("Buyers can review books they own", as tightened by
-- migration 022): after the update, the row must still belong to the
-- authenticated reader AND that reader must currently hold a
-- non-refunded purchase of the (possibly new) book_id. This closes both
-- gaps found: repointing a review's book_id to a book the reader never
-- purchased, and editing a review indefinitely after the underlying
-- purchase was refunded.
--
-- Fail-closed on post-refund editing is a deliberate choice, not an
-- assumption: traced against src/app/books/[id]/actions.ts's
-- submitReview in full -- it already re-checks `purchases.refunded_at
-- is null` at the application level, before ever attempting the write,
-- and redirects with "Buy this book to review it" if that check fails.
-- The product's own existing behavior already refuses to let a refunded
-- reader edit their review through the normal UI; this migration only
-- makes that same, already-intended behavior hold at the database layer
-- too, exactly the same relationship migration 022 already established
-- between submitReview's pre-check and the INSERT policy.
--
-- Mirroring the INSERT check exactly (not merely "same reader_id") is
-- required, not optional, for the app's own genuine edit flow to keep
-- working: submitReview implements "edit my review" as
-- `.upsert({ book_id, reader_id, rating, body }, { onConflict:
-- "book_id,reader_id" })` -- when this hits its own existing row, it
-- executes as a real UPDATE subject to this UPDATE policy, not the
-- INSERT policy, so the UPDATE policy's WITH CHECK must accept exactly
-- the same shape (own reader_id, current non-refunded purchase for that
-- book_id) or genuine, no-op-on-book_id re-submissions would start
-- failing.
--
-- Column-level grant: deliberately NOT narrowed here, unlike
-- discount_codes above. submitReview's edit path is an upsert whose
-- payload includes book_id and reader_id alongside rating/body -- on
-- the conflict-update branch, Postgres's generated SET list for an
-- ON CONFLICT DO UPDATE conventionally includes every column supplied
-- to the upsert call, including book_id/reader_id, even though their
-- values are unchanged from the existing row (they're the columns the
-- conflict itself matched on). Column-level UPDATE privilege in
-- Postgres is checked against which columns appear in the SET list, not
-- against whether the value actually differs -- so revoking UPDATE on
-- book_id/reader_id here would very likely break this app's own
-- legitimate review-edit flow. Unlike discount_codes' toggleDiscountCode
-- (a plain .update() naming only the one column it changes), this
-- couldn't be verified safe against a live Postgres instance in this
-- environment, so it is deliberately left as a WITH-CHECK-only (value
-- based, not column based) correction -- the safer, conservative choice
-- per "audit first; do not blindly broaden or revoke."
alter policy "Readers can update their own review"
  on public.reviews
  with check (
    auth.uid() = reader_id
    and exists (
      select 1 from public.purchases
      where purchases.book_id = reviews.book_id
      and purchases.reader_id = auth.uid()
      and purchases.refunded_at is null
    )
  );
