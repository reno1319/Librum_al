-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds "follow an author" — readers opt in to an email
-- when someone they follow publishes a new book. If you're setting up
-- a fresh project, just run schema.sql instead.

create table public.author_follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references public.profiles(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (follower_id, author_id),
  check (follower_id <> author_id)
);

alter table public.author_follows enable row level security;

create policy "Readers can view their own follows"
  on public.author_follows for select
  using (auth.uid() = follower_id);

create policy "Readers can follow an author"
  on public.author_follows for insert
  with check (auth.uid() = follower_id);

create policy "Readers can unfollow an author"
  on public.author_follows for delete
  using (auth.uid() = follower_id);

create index author_follows_follower_id_idx on public.author_follows(follower_id);
create index author_follows_author_id_idx on public.author_follows(author_id);
