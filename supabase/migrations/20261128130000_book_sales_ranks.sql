-- AMAZON BOOK PAGE P4 (Renato 2026-11-28: bp6 a, bp7 a, rk1 b, rk2 a):
-- the book page's "Renditja" (rank) line and its "Nr. 1 në ..." badge.
--
-- WHAT CHANGES:
--   1. public.book_sales_ranks(book): the rank of ONE book among the
--      books Libraria lists now (published or pre-order, priced), first
--      in all of Libraria, then in each of the book's own categories, in
--      the book's own category order. It returns only (category, rank,
--      sort_order): never a sales count, a reader, an amount or another
--      book's id.
--
--      What counts as a sale (bp7 a, rk1 b, rk2 a): a PAID sale in the
--      last 30 days.
--        - a purchases row with amount_cents > 0 that is not refunded
--          and whose payment did not lose a dispute (the same test as
--          user_owns_book()); its time is the payment's paid_at, or the
--          row's created_at for a row with no payments row. Free
--          downloads (amount 0, 'free_...') and claimed gifts (amount 0,
--          'gift_...', the friend's copy) never count. A bundle's book
--          counts when its share of the bundle price is above 0.
--        - a public.gifts row made in the last 30 days: one paid gift
--          (the POK cart checkout adds the row only once the order is
--          paid; today the table is empty everywhere).
--
--      When a rank shows (bp6 a): the book has at least 10 such sales,
--      and the scope (Libraria, or that category) has at least 3 listed
--      books with at least one such sale. Otherwise that scope is left
--      out; a book with no rank gets no rows. Equal sales share a rank
--      (1, 1, 3).
--
--      security definer: purchases and gifts are readable only by the
--      reader/buyer involved, and this needs every row to count. EXECUTE
--      is for service_role only (the book page's server-side admin
--      client), like public.bestselling_books(); revoked from public,
--      anon and authenticated.
--
-- No table, view, row or storage change. public.bestselling_books() is
-- not changed.
--
-- ROLLBACK: drop function public.book_sales_ranks(uuid);

create or replace function public.book_sales_ranks(p_book_id uuid)
returns table (category text, sales_rank integer, sort_order integer)
language sql
security definer
set search_path = ''
stable
as $$
  with since as (
    select pg_catalog.now() - interval '30 days' as t
  ),
  listed as (
    select b.id, b.categories
    from public.books b
    where public.book_is_publicly_listed(b)
      and b.price_all is not null
  ),
  sales as (
    select p.book_id
    from public.purchases p
    left join public.payments pay on pay.id = p.payment_id
    cross join since
    where p.amount_cents > 0
      and p.refunded_at is null
      and not public.payment_intent_has_lost_dispute(p.stripe_payment_intent_id)
      and coalesce(pay.paid_at, p.created_at) >= since.t
    union all
    select g.book_id
    from public.gifts g
    cross join since
    where g.created_at >= since.t
  ),
  totals as (
    select l.id, l.categories, count(*)::integer as n
    from listed l
    join sales s on s.book_id = l.id
    group by l.id, l.categories
  ),
  scopes as (
    select null::text as category, 0 as sort_order, t.id, t.n
    from totals t
    union all
    select c.category, c.sort_order::integer, t.id, t.n
    from totals t
    cross join lateral pg_catalog.unnest(t.categories) with ordinality as c(category, sort_order)
  ),
  ranked as (
    select
      s.category,
      s.sort_order,
      s.id,
      s.n,
      (rank() over (partition by s.category order by s.n desc))::integer as sales_rank,
      count(*) over (partition by s.category) as books_with_sales
    from scopes s
  )
  select r.category, r.sales_rank, r.sort_order
  from ranked r
  where r.id = p_book_id
    and r.n >= 10
    and r.books_with_sales >= 3
  order by r.sort_order;
$$;

revoke all on function public.book_sales_ranks(uuid) from public;
revoke all on function public.book_sales_ranks(uuid) from anon;
revoke all on function public.book_sales_ranks(uuid) from authenticated;
grant execute on function public.book_sales_ranks(uuid) to service_role;
