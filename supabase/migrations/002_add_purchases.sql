-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds the new purchases table needed for Phase 3 (Stripe
-- checkout). If you're setting up a fresh project, just run schema.sql —
-- it already includes this table, so you don't need this file too.

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

create index purchases_reader_id_idx on public.purchases(reader_id);
