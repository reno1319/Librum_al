-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- K8 + K10 ROLLBACK: undoes migration 20261115160000_reader_marks.sql.
-- Drops the re-anchor function, the refund trigger, the limit triggers and their functions, and
-- the three tables with their rows (readers' places, bookmarks,
-- highlights and notes are lost; the reverted app neither reads nor
-- writes them).
--
-- Residue: none.
--
-- Run only together with the app revert. Safe to run more than once.

begin;

drop function if exists public.reader_highlights_reanchor(uuid, jsonb, uuid[]);
drop trigger if exists purchases_delete_reader_marks_on_refund on public.purchases;
drop function if exists public.reader_marks_delete_on_refund();
drop table if exists public.reader_highlights;
drop table if exists public.reader_bookmarks;
drop table if exists public.reading_places;
drop function if exists public.reader_marks_enforce_limit();

commit;
