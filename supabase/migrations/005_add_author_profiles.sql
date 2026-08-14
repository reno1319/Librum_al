-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds a bio + avatar to profiles and a public avatars
-- storage bucket, needed for public author profile pages. If you're
-- setting up a fresh project, just run schema.sql instead.

alter table public.profiles
  add column bio text,
  add column avatar_path text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "Avatars are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Users can upload their own avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can replace their own avatar"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
