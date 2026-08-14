-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It lets authors see purchases of their own books (needed for
-- the sales dashboard) — previously only the buyer could see a purchase
-- row at all. If you're setting up a fresh project, just run schema.sql
-- instead.

create policy "Authors can view purchases of their own books"
  on public.purchases for select
  using (
    exists (
      select 1 from public.books
      where books.id = purchases.book_id
      and books.author_id = auth.uid()
    )
  );

create index purchases_book_id_idx on public.purchases(book_id);
