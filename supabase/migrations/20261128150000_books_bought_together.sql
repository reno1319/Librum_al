-- AMAZON BOOK PAGE P5 (Renato 2026-11-28: bp9 b, fb1 a, fb2 b, fb3 b,
-- fb4 a): "Blihen shpesh bashkë" and the "Blerë bashkë me këtë" chip of
-- the "Lexuesit blenë edhe" shelf on the book page.
--
-- WHAT CHANGES:
--   1. public.books_bought_together(book): the other books that at
--      least 3 different readers bought as well as this one, most shared
--      readers first. It returns only (book_id, sort_order): never a
--      count, a reader, an amount or a date.
--
--      What counts as bought (fb1 a, fb4 a): a PAID copy, at any time
--      since the start -- a purchases row with amount_cents > 0 that is
--      not refunded and whose payment did not lose a dispute (the same
--      test as user_owns_book() and book_sales_ranks()). A bundle's book
--      counts when its share of the bundle price is above 0. Free
--      downloads (amount 0, 'free_...') and claimed gifts (amount 0,
--      'gift_...', the friend's copy) never count. A paid gift is not
--      counted: the buyer did not buy the book for themself (and the
--      gifts table has no reader to pair).
--
--      Whose copies count: a reader whose account still exists
--      (reader_id not null), never the author of either book (an author
--      cannot make a pair by buying their own books).
--
--      Which books: both books must be listed in Libraria now (published
--      or pre-order, priced), the same test as book_sales_ranks(). A pair
--      shows only with 3 or more shared readers, so a single reader's
--      purchases can never be read off the page. Ties: the newer book
--      first, then by id, so the order never changes between visits.
--
--      security definer: purchases are readable only by the reader
--      involved, and this needs every row to count. EXECUTE is for
--      service_role only (the book page's server-side admin client), like
--      book_sales_ranks(); revoked from public, anon and authenticated.
--
-- No table, view, row or storage change.
--
-- ROLLBACK: drop function public.books_bought_together(uuid);

create or replace function public.books_bought_together(p_book_id uuid)
returns table (book_id uuid, sort_order integer)
language sql
security definer
set search_path = ''
stable
as $$
  with listed as (
    select b.id, b.author_id, b.created_at
    from public.books b
    where public.book_is_publicly_listed(b)
      and b.price_all is not null
  ),
  paid as (
    select distinct p.reader_id, p.book_id
    from public.purchases p
    join listed l on l.id = p.book_id
    where p.amount_cents > 0
      and p.refunded_at is null
      and p.reader_id is not null
      and p.reader_id <> l.author_id
      and not public.payment_intent_has_lost_dispute(p.stripe_payment_intent_id)
  ),
  this_book as (
    select paid.reader_id
    from paid
    where paid.book_id = p_book_id
  ),
  pairs as (
    select o.book_id, count(*) as readers
    from this_book t
    join paid o on o.reader_id = t.reader_id and o.book_id <> p_book_id
    group by o.book_id
    having count(*) >= 3
  )
  select pr.book_id, (row_number() over (order by pr.readers desc, l.created_at desc, pr.book_id))::integer as sort_order
  from pairs pr
  join listed l on l.id = pr.book_id
  order by sort_order
  limit 21;
$$;

revoke all on function public.books_bought_together(uuid) from public;
revoke all on function public.books_bought_together(uuid) from anon;
revoke all on function public.books_bought_together(uuid) from authenticated;
grant execute on function public.books_bought_together(uuid) to service_role;
