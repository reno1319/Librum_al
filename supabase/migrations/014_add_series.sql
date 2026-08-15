-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds book series (a named grouping with a reading order).
-- If you're setting up a fresh project, just run schema.sql instead.

create table public.series (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);

alter table public.series enable row level security;

create policy "Series are viewable by everyone"
  on public.series for select
  using (true);

create policy "Authors can create their own series"
  on public.series for insert
  with check (auth.uid() = author_id);

create policy "Authors can rename their own series"
  on public.series for update
  using (auth.uid() = author_id);

create policy "Authors can delete their own series"
  on public.series for delete
  using (auth.uid() = author_id);

alter table public.books
  add column series_id uuid references public.series(id) on delete set null,
  add column series_position integer check (series_position > 0);

create index books_series_id_idx on public.books(series_id);
