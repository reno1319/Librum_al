-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds the wishlist_items table. If you're setting up a
-- fresh project, just run schema.sql instead.

create table public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  reader_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (reader_id, book_id)
);

alter table public.wishlist_items enable row level security;

create policy "Readers can view their own wishlist"
  on public.wishlist_items for select
  using (auth.uid() = reader_id);

create policy "Readers can add to their own wishlist"
  on public.wishlist_items for insert
  with check (auth.uid() = reader_id);

create policy "Readers can remove from their own wishlist"
  on public.wishlist_items for delete
  using (auth.uid() = reader_id);

create index wishlist_items_reader_id_idx on public.wishlist_items(reader_id);
