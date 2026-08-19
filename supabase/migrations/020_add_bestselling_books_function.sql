-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Adds a small, read-only aggregate function so the bookstore
-- can rank bestselling books without fetching every purchases row into
-- the app to count them in memory (see the Phase 6 bookstore audit).
--
-- security definer is required because RLS on purchases restricts SELECT
-- to the reader/author involved in each row -- this function needs to
-- read across all of them to produce a count. This is not a new
-- privilege: the app's own admin/service-role client already bypasses
-- RLS for this exact same purpose (see fetchCuratedHome's existing
-- bestseller logic in src/app/bookstore/page.tsx) -- this function just
-- moves that same aggregate work into the database instead of pulling
-- every row into application memory first.
--
-- Only ever returns (book_id, purchase_count) pairs -- never reader_id,
-- amount_cents, or any other column -- so it cannot be used to expose
-- who bought what.
--
-- If you're setting up a fresh project, just run schema.sql instead (it
-- does not include this function -- run this migration afterward either
-- way, on a fresh or an existing project).

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
  limit result_limit;
$$;

grant execute on function public.bestselling_books(uuid[], int) to anon, authenticated;
