-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for FV1 file versions
-- (supabase/migrations/20261125120000_book_file_versions.sql).
-- Drops the trigger, its function and the table. The files the table
-- named stay in Storage; the reverted app no longer keeps them, so its
-- next retention cleanup of each book may remove them.

begin;

drop trigger books_track_file_versions on public.books;
drop function public.books_track_file_versions();
drop table public.book_file_versions;

commit;
