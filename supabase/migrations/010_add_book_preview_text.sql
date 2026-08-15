-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds the optional "Look inside" excerpt field. If you're
-- setting up a fresh project, just run schema.sql instead.

alter table public.books
  add column preview_text text not null default '';
