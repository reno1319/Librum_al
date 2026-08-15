-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds the book_reports table. If you're setting up a
-- fresh project, just run schema.sql instead.
--
-- Write-only from the app's perspective — no select policy, since
-- there's no in-app moderation UI yet. Review reports directly in the
-- Supabase dashboard's Table Editor.

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
