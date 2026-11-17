-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- K6 classics ROLLBACK: undoes migration
-- 20261116180000_classic_authors.sql. Drops the two functions, the
-- view, pd_works.classic_author_id (its links are lost) and the
-- classic_authors table with its rows (the staff-written bios are lost;
-- the reverted app neither reads nor writes them).
--
-- Residue: none.
--
-- Run only together with the app revert. Safe to run more than once.

begin;

drop function if exists public.staff_set_pd_work_classic_author(uuid, uuid);
drop function if exists public.staff_save_classic_author(uuid, text, text, integer, integer, text, text, text);
drop view if exists public.public_classic_authors;
drop index if exists public.pd_works_classic_author_id_idx;
alter table if exists public.pd_works drop column if exists classic_author_id;
drop table if exists public.classic_authors;

commit;
