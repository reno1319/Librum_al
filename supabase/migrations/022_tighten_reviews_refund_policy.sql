-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Tightens the reviews INSERT policy so a refunded purchase no
-- longer qualifies a reader to write a review (see the Phase 7 book
-- detail page audit).
--
-- The existing policy (from 007_add_reviews.sql) checks only that a
-- purchases row exists for this reader/book -- it does not exclude
-- refunded ones. The application's submitReview action already adds a
-- "refunded_at is null" check before allowing a review submission
-- through the normal UI, but RLS itself doesn't enforce that, so a
-- refunded reader could still write a review via a direct API call
-- with their own session token, bypassing only the app-level check.
--
-- This is a pure narrowing of an existing check -- no new privilege is
-- granted, nothing that was previously disallowed becomes allowed. The
-- auth.uid() = reader_id requirement and the existing purchases-exists
-- shape are both preserved exactly; only "and purchases.refunded_at is
-- null" is added to the exists() subquery.
--
-- ALTER POLICY is used instead of drop+create so the policy is never
-- momentarily absent, and its name/other clauses are left untouched.
--
-- If you're setting up a fresh project, just run schema.sql instead (it
-- already includes this corrected policy -- run this migration
-- afterward either way, on a fresh or an existing project).

alter policy "Buyers can review books they own"
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
