-- CART (Renato 2026-11-25, item 32: c1 a, c2 a, c3 a, g1 a, g4 a; pictures
-- r2 ok): a signed-in reader's cart. One row per book in the cart; a row
-- with gift_email is a gift for that person (g1 a: Librum emails them a
-- link once the order is paid). Card payment is not open yet (c1 a), so
-- nothing here creates a purchase, an order or a gift: this is the saved
-- cart only. Gift delivery comes in the next batch.
--
-- WHAT CHANGES:
--   1. public.cart_items, row level security on; a reader reads, adds,
--      edits the gift fields of, and removes only their own rows.
--   2. public.cart_book_allowed(book): the add rule, checked by the insert
--      policy (definer, so it can read books.author_id):
--        - the book is live (status 'published'; c3 a: no pre-orders),
--        - it is paid (price_all > 0; c3 a: free books keep "Merre falas"),
--        - the reader is not its author (g4 a).
--      A copy for yourself is also refused while you own the book.
--   3. At most one copy for yourself per book, and one gift per book per
--      email (unique indexes); at most 50 rows per reader (LB529).
--
-- ROLLBACK: drop table public.cart_items; drop function
-- public.cart_book_allowed(uuid, boolean); drop function
-- public.cart_items_limit(). Nothing else uses them.

create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  reader_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  gift_email text,
  gift_note text,
  created_at timestamptz not null default now(),
  constraint cart_items_gift_email_check check (
    gift_email is null
    or (char_length(gift_email) between 3 and 254
        and gift_email = lower(gift_email)
        and gift_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  constraint cart_items_gift_note_check check (
    gift_note is null or (gift_email is not null and char_length(gift_note) between 1 and 300)
  )
);

create unique index cart_items_one_own_copy
  on public.cart_items (reader_id, book_id) where gift_email is null;
create unique index cart_items_one_gift_per_email
  on public.cart_items (reader_id, book_id, gift_email) where gift_email is not null;

comment on table public.cart_items is
  'CART (item 32): a signed-in reader''s saved cart. gift_email set = a gift for that person. See migration 20261125120000_cart_items.sql.';

create or replace function public.cart_book_allowed(target_book_id uuid, for_self boolean)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.books b
    where b.id = target_book_id
      and b.status = 'published'
      and b.price_all is not null
      and b.price_all > 0
      and b.author_id is distinct from auth.uid()
  )
  and not (for_self and public.user_owns_book(target_book_id));
$$;

revoke all on function public.cart_book_allowed(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.cart_book_allowed(uuid, boolean) to authenticated;

create or replace function public.cart_items_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.cart_items c where c.reader_id = new.reader_id) >= 50 then
    raise exception 'cart_items: at most 50 books in a cart' using errcode = 'LB529';
  end if;
  return new;
end;
$$;

revoke all on function public.cart_items_limit() from public, anon, authenticated, service_role;

create trigger cart_items_limit
  before insert on public.cart_items
  for each row
  execute function public.cart_items_limit();

alter table public.cart_items enable row level security;

revoke all on table public.cart_items from public, anon, authenticated, service_role;
grant select, delete on table public.cart_items to authenticated;
grant insert (book_id, reader_id, gift_email, gift_note) on table public.cart_items to authenticated;
grant update (gift_email, gift_note) on table public.cart_items to authenticated;

create policy "Readers see their own cart"
  on public.cart_items for select
  to authenticated
  using (auth.uid() = reader_id);

create policy "Readers add to their own cart"
  on public.cart_items for insert
  to authenticated
  with check (reader_id = auth.uid() and public.cart_book_allowed(book_id, gift_email is null));

-- Only the gift fields can change (column grants above); a gift stays a
-- gift (the email can be fixed, not removed).
create policy "Readers edit their own gifts"
  on public.cart_items for update
  to authenticated
  using (reader_id = auth.uid() and gift_email is not null)
  with check (reader_id = auth.uid() and gift_email is not null);

create policy "Readers remove from their own cart"
  on public.cart_items for delete
  to authenticated
  using (reader_id = auth.uid());
