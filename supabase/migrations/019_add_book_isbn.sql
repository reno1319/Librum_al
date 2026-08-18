-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds an optional ISBN field authors can fill in if they
-- already own one -- metadata only, Librum doesn't issue or register
-- ISBNs. If you're setting up a fresh project, just run schema.sql
-- instead.

alter table public.books
  add column isbn text;
