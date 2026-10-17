-- Committed SQL regression suite for STORAGE-BUCKET-LIMITS-1
-- (migrations/20261016171500_storage_bucket_limits.sql). It pins the
-- size limit and content-type allow-list of every Storage bucket, and
-- that no bucket is left without them.
--
-- Postgres only stores these values; the Storage API enforces them, so
-- the refusal itself is verified on staging, not here.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/071_storage_bucket_limits.test.sql

begin;

do $$
declare
  images constant text[] := array['image/jpeg', 'image/png'];
  manuscripts constant text[] := array[
    'application/epub+zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png'
  ];
  b record;
  seen integer := 0;
begin
  for b in select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id loop
    seen := seen + 1;
    if b.file_size_limit is null or b.allowed_mime_types is null then
      raise exception 'FAIL: bucket % has no size or type limit', b.id;
    end if;
    case b.id
      when 'covers', 'avatars', 'blog' then
        if not b.public or b.file_size_limit <> 5242880 or b.allowed_mime_types <> images then
          raise exception 'FAIL: bucket % is %, %, %', b.id, b.public, b.file_size_limit, b.allowed_mime_types;
        end if;
      when 'manuscripts' then
        if b.public or b.file_size_limit <> 52428800 or b.allowed_mime_types <> manuscripts then
          raise exception 'FAIL: bucket % is %, %, %', b.id, b.public, b.file_size_limit, b.allowed_mime_types;
        end if;
      else
        raise exception 'FAIL: unexpected bucket %', b.id;
    end case;
  end loop;
  if seen <> 4 then
    raise exception 'FAIL: expected 4 buckets, found %', seen;
  end if;
end $$;

select 'STORAGE-BUCKET-LIMITS-1 071 suite: all assertions passed' as result;

rollback;
