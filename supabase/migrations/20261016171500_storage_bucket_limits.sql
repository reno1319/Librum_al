-- STORAGE-BUCKET-LIMITS-1: every Storage bucket gets a per-file size
-- limit and an allow-list of content types.
--
-- WHY. All four buckets were created with file_size_limit and
-- allowed_mime_types left NULL (no limit). The application checks size
-- and type before it uploads, but Storage RLS lets any signed-in user
-- upload straight to their own "<uid>/..." folder through the Storage
-- API, skipping the application. In the public buckets (covers,
-- avatars) that made Librum free public hosting for any file of any
-- type; in every bucket it let one account fill the project's storage
-- quota (audit 2026-09-26, L06).
--
-- WHAT CHANGES, and nothing else. The limits equal what the application
-- already enforces, so no upload the application makes today is refused:
--   * covers, avatars, blog: 5 MiB; image/jpeg and image/png only
--     (cover-field.tsx, avatar-field.tsx, blog-cover-field.tsx and the
--     server actions that re-check them);
--   * manuscripts: 50 MiB; application/epub+zip, the .docx type, and
--     image/jpeg / image/png, because the browser stages cover, avatar
--     and blog images in this private bucket before the server action
--     verifies and moves them (manuscript-field.tsx, docx-actions.ts).
-- Storage compares the content type the uploader declares, not the
-- bytes; the application still verifies the bytes itself.
--
-- UNCHANGED: bucket ids, names and public flags; every policy; every
-- existing object (limits apply to new uploads only). No DML on any
-- table outside storage.buckets.
--
-- The declarative equivalent is at the end of supabase/schema.sql;
-- supabase/tests/071_storage_bucket_limits.test.sql checks the values.

do $$
declare
  updated integer := 0;
  n integer;
begin
  update storage.buckets
     set file_size_limit = 5242880,
         allowed_mime_types = array['image/jpeg', 'image/png']
   where id in ('covers', 'avatars', 'blog');
  get diagnostics n = row_count;
  updated := updated + n;

  update storage.buckets
     set file_size_limit = 52428800,
         allowed_mime_types = array[
           'application/epub+zip',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'image/jpeg',
           'image/png'
         ]
   where id = 'manuscripts';
  get diagnostics n = row_count;
  updated := updated + n;

  -- Fail rather than silently leave a bucket unlimited.
  if updated <> 4 then
    raise exception 'storage bucket limits: expected 4 buckets, updated %', updated;
  end if;
end;
$$;
