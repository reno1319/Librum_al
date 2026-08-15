-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds an optional comma-separated keywords field, searched
-- the same way as title/description. If you're setting up a fresh
-- project, just run schema.sql instead.

alter table public.books
  add column keywords text not null default '';
