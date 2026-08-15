-- Librum: self-publishing platform database schema.
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- after creating a new Supabase project.

-- ============================================================
-- profiles: one row per signed-up user (author or reader)
-- ============================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('author', 'reader')),
  display_name text not null,
  bio text,
  avatar_path text,
  stripe_account_id text,
  stripe_payouts_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by everyone"
  on public.profiles for select
  using (true);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- stripe_account_id / stripe_payouts_enabled are only ever written by
-- server code using the service role key (see src/lib/supabase/admin.ts),
-- never by the user directly — otherwise an author could just set
-- stripe_payouts_enabled = true on themselves via the API.
revoke update (stripe_account_id, stripe_payouts_enabled) on public.profiles from authenticated;

-- Auto-create a profile row whenever someone signs up, using the
-- role/display_name passed in from the signup form's metadata.
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'reader'),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- books: owned by an author, visible to everyone once published
-- ============================================================

-- Keep this list in sync with GENRES in src/lib/genres.ts.
create table public.books (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',
  genre text check (genre in (
    'Fiction', 'Non-Fiction', 'Mystery & Thriller', 'Romance', 'Fantasy',
    'Science Fiction', 'Horror', 'Biography & Memoir', 'Self-Help',
    'History', 'Poetry', 'Young Adult', 'Children''s', 'Business'
  )),
  price_cents integer not null default 0 check (price_cents >= 0),
  cover_path text,
  file_path text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.books enable row level security;

create policy "Published books are viewable by everyone, drafts by their author"
  on public.books for select
  using (status = 'published' or auth.uid() = author_id);

create policy "Authors can insert their own books"
  on public.books for insert
  with check (auth.uid() = author_id);

create policy "Authors can update their own books"
  on public.books for update
  using (auth.uid() = author_id);

create policy "Authors can delete their own books"
  on public.books for delete
  using (auth.uid() = author_id);

create index books_author_id_idx on public.books(author_id);
create index books_status_idx on public.books(status);
create index books_genre_idx on public.books(genre);

-- ============================================================
-- storage: cover images (public) and manuscript files (private)
-- ============================================================

insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('manuscripts', 'manuscripts', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Files are stored as "<owner_id>/<filename>" so ownership can be
-- checked from the path itself via storage.foldername(name).

create policy "Cover images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'covers');

create policy "Authors can upload their own cover images"
  on storage.objects for insert
  with check (bucket_id = 'covers' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can replace their own cover images"
  on storage.objects for update
  using (bucket_id = 'covers' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can upload their own manuscripts"
  on storage.objects for insert
  with check (bucket_id = 'manuscripts' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can read their own manuscripts"
  on storage.objects for select
  using (bucket_id = 'manuscripts' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can replace their own manuscripts"
  on storage.objects for update
  using (bucket_id = 'manuscripts' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Avatars are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Users can upload their own avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can replace their own avatar"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ============================================================
-- purchases: one row per completed sale, written only by the
-- Stripe webhook (via the service role key, which bypasses RLS) —
-- there is deliberately no insert policy for regular users.
-- ============================================================

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  reader_id uuid not null references public.profiles(id) on delete cascade,
  stripe_checkout_session_id text not null unique,
  amount_cents integer not null,
  created_at timestamptz not null default now(),
  unique (book_id, reader_id)
);

alter table public.purchases enable row level security;

create policy "Readers can view their own purchases"
  on public.purchases for select
  using (auth.uid() = reader_id);

create policy "Authors can view purchases of their own books"
  on public.purchases for select
  using (
    exists (
      select 1 from public.books
      where books.id = purchases.book_id
      and books.author_id = auth.uid()
    )
  );

create index purchases_reader_id_idx on public.purchases(reader_id);
create index purchases_book_id_idx on public.purchases(book_id);

-- ============================================================
-- reviews: one per reader per book — only buyers can write one,
-- resubmitting overwrites their existing review (see the unique
-- constraint + the app's upsert on book_id/reader_id)
-- ============================================================

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  reader_id uuid not null references public.profiles(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  body text not null default '',
  created_at timestamptz not null default now(),
  unique (book_id, reader_id)
);

alter table public.reviews enable row level security;

create policy "Reviews are viewable by everyone"
  on public.reviews for select
  using (true);

create policy "Buyers can review books they own"
  on public.reviews for insert
  with check (
    auth.uid() = reader_id
    and exists (
      select 1 from public.purchases
      where purchases.book_id = reviews.book_id
      and purchases.reader_id = auth.uid()
    )
  );

create policy "Readers can update their own review"
  on public.reviews for update
  using (auth.uid() = reader_id);

create policy "Readers can delete their own review"
  on public.reviews for delete
  using (auth.uid() = reader_id);

create index reviews_book_id_idx on public.reviews(book_id);

-- ============================================================
-- wishlist_items: a reader saves a book for later, no purchase implied
-- ============================================================

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

-- ============================================================
-- book_reports: readers flag a book for review. Write-only from the
-- app's perspective — there's no in-app moderation UI yet, so there's
-- deliberately no select policy for regular users (not even the
-- reported book's own author). Review reports directly in the
-- Supabase dashboard's Table Editor for now.
-- ============================================================

create table public.book_reports (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);

alter table public.book_reports enable row level security;

create policy "Readers can report a book"
  on public.book_reports for insert
  with check (auth.uid() = reporter_id);

create index book_reports_book_id_idx on public.book_reports(book_id);
