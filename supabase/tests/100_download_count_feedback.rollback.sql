-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- Download count + feedback ROLLBACK: undoes migration
-- 20261115200000_download_count_feedback.sql. Drops the five functions
-- and the reader_feedback table with its rows (readers' messages are
-- lost; the reverted app neither reads nor writes them).
--
-- Residue: none.
--
-- Run only together with the app revert. Safe to run more than once.

begin;

drop function if exists public.staff_set_reader_feedback_done(uuid, boolean);
drop function if exists public.staff_list_reader_feedback(text);
drop function if exists public.submit_reader_feedback(text, text, text);
drop table if exists public.reader_feedback;
drop function if exists public.book_download_count(uuid);

commit;
