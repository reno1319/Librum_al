-- ============================================================
-- FV1 file versions (migration 20261125120000): every book file that
-- was once the live file buyers got is kept, with its dates.
-- Renato, 24-25 Nov 2026: buyers always get the newest file (fv1 a);
-- the author's Content tab and the staff book page list the earlier
-- files (fv2 a); no "use again" button (fv3 a); only files that were
-- once live are kept (fv4 a); an unsold book's earlier files go with
-- the book (fv5 a).
--
-- What it changes, and nothing else:
--   1. book_file_versions: one row per file that was live for a book
--      (book id + storage key), with when it first went live and when
--      it was replaced (null while it is still the book's file). Rows
--      go with their book (ON DELETE CASCADE). Only service_role reads
--      it; RLS on, no policy. Nobody but the trigger writes it.
--   2. books_track_file_versions(): AFTER INSERT OR UPDATE OF status,
--      file_path on books. A book whose file changes gets replaced_at
--      on the old file's row (if it has one); a published book's file
--      gets a row (once).
--   3. Backfill: one row for the current file of every published book,
--      and one for the file buyers of every book taken off sale are
--      served (its latest approved file), closed when it is no longer
--      the book's current file; live since published_at.
--
-- No existing row changes; no existing function, policy or SQLSTATE.
-- The app keeps the files this table names (retention cleanup), lists
-- them, and removes them only with their unsold book (deleteBook,
-- account deletion).
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/116_book_file_versions.test.sql.
-- Rollback: supabase/tests/116_book_file_versions.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The table.
-- ------------------------------------------------------------
create table public.book_file_versions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  file_path text not null constraint book_file_versions_file_path_check check (file_path <> ''),
  live_from timestamptz not null default now(),
  replaced_at timestamptz,
  constraint book_file_versions_book_file_key unique (book_id, file_path),
  constraint book_file_versions_dates_check check (replaced_at is null or replaced_at >= live_from)
);

alter table public.book_file_versions enable row level security;

-- Read with the service key only (the editor after its own ownership
-- check, the staff page, the two download routes, retention and
-- deletion). Written only by the trigger below.
revoke all on public.book_file_versions from public, anon, authenticated, service_role;
grant select on public.book_file_versions to service_role;

comment on table public.book_file_versions is
  'FV1: every file that was once a book''s live file, with when it went live and when it was replaced. Written only by books_track_file_versions().';

-- ------------------------------------------------------------
-- 2. The trigger.
-- ------------------------------------------------------------
create function public.books_track_file_versions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.file_path is not null
     and old.file_path is distinct from new.file_path then
    update public.book_file_versions
       set replaced_at = pg_catalog.now()
     where book_id = new.id
       and file_path = old.file_path
       and replaced_at is null;
  end if;
  if new.status = 'published' and new.file_path is not null and new.file_path <> '' then
    insert into public.book_file_versions (book_id, file_path)
    values (new.id, new.file_path)
    on conflict on constraint book_file_versions_book_file_key do nothing;
  end if;
  return null;
end;
$$;

revoke all on function public.books_track_file_versions() from public, anon, authenticated, service_role;

create trigger books_track_file_versions
  after insert or update of status, file_path on public.books
  for each row execute function public.books_track_file_versions();

-- ------------------------------------------------------------
-- 3. Backfill (audit r1 N1, r2 N1-r2).
--    a. Every published book: its current file, still live.
--    b. Every book once on sale and now taken off sale (draft with
--       published_at): the file its buyers are served, which is its
--       latest approved file (as the download route picks it: latest
--       decision, then latest send). Closed now when the book's current
--       file is another one -- taking a book off sale swaps in its
--       waiting change (books_take_pending_changes_offline), and a draft
--       may have changed its file since. A file never approved is never
--       recorded.
-- ------------------------------------------------------------
insert into public.book_file_versions (book_id, file_path, live_from)
select b.id, b.file_path, least(coalesce(b.published_at, pg_catalog.now()), pg_catalog.now())
  from public.books b
 where b.status = 'published'
   and b.file_path is not null
   and b.file_path <> ''
on conflict on constraint book_file_versions_book_file_key do nothing;

insert into public.book_file_versions (book_id, file_path, live_from, replaced_at)
select b.id, a.file_path,
       least(b.published_at, pg_catalog.now()),
       case when a.file_path = b.file_path then null else pg_catalog.now() end
  from public.books b
  cross join lateral (select r.file_path
                        from public.book_reviews r
                       where r.book_id = b.id
                         and r.status = 'approved'
                         and r.file_path is not null
                         and r.file_path <> ''
                       order by r.decided_at desc nulls last, r.submitted_at desc, r.id desc
                       limit 1) a
 where b.status = 'draft'
   and b.published_at is not null
on conflict on constraint book_file_versions_book_file_key do nothing;
