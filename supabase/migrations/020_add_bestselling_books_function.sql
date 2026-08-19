-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Adds a small, read-only aggregate function so the bookstore
-- can rank bestselling books without fetching every purchases row into
-- the app to count them in memory (see the Phase 6 bookstore audit).
--
-- security definer is required because RLS on purchases restricts SELECT
-- to the reader/author involved in each row -- this function needs to
-- read across all of them to produce a count. This is not a new
-- privilege: the app's own admin/service-role client already bypasses
-- RLS for this exact same purpose (see fetchBestsellers and the
-- "bestselling" sort in src/app/bookstore/page.tsx) -- this function
-- just moves that same aggregate work into the database instead of
-- pulling every row into application memory first.
--
-- Only ever returns (book_id, purchase_count) pairs -- never reader_id,
-- amount_cents, or any other column -- so it cannot be used to expose
-- who bought what.
--
-- EXECUTE is intentionally restricted to service_role only (revoked from
-- PUBLIC, anon, and authenticated below). This is a SECURITY DEFINER
-- function that reads across every reader's purchase rows, bypassing the
-- RLS policies that would otherwise scope that read to one reader/author
-- at a time -- it must never be callable directly by a public/browser
-- client, only by the app's server-side admin client, exactly like every
-- other current caller of it already does.
--
-- result_limit is clamped server-side (via least/greatest/coalesce in
-- the query below) to a safe range of 1-100 regardless of what a caller
-- passes in -- NULL, 0, negative, or an oversized value all resolve to a
-- sane bound -- so no caller can force an unbounded or absurdly large
-- aggregate scan.
--
-- schema.sql already includes this function (kept in sync with this
-- migration) for fresh project setups -- if you're setting up a fresh
-- project, running schema.sql alone is sufficient. This migration file
-- exists to add or update the function on an existing, already-running
-- database that was set up before this function existed.

create or replace function public.bestselling_books(
  book_ids uuid[] default null,
  result_limit int default null
)
returns table (book_id uuid, purchase_count bigint)
language sql
security definer
set search_path = public
stable
as $$
  select purchases.book_id, count(*) as purchase_count
  from public.purchases
  where purchases.refunded_at is null
    and (book_ids is null or purchases.book_id = any(book_ids))
  group by purchases.book_id
  order by purchase_count desc
  limit least(greatest(coalesce(result_limit, 100), 1), 100);
$$;

-- Explicitly close off public/browser access -- only the server-side
-- admin (service-role) client may call this function.
revoke all on function public.bestselling_books(uuid[], int) from public;
revoke all on function public.bestselling_books(uuid[], int) from anon;
revoke all on function public.bestselling_books(uuid[], int) from authenticated;
grant execute on function public.bestselling_books(uuid[], int) to service_role;
