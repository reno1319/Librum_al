-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- AUTHOR-EMAILS ROLLBACK: undoes migration
-- 20261117190000_author_welcome_sent_at.sql. Drops
-- profiles.author_welcome_sent_at (who was already welcomed is lost; the
-- reverted app neither reads nor writes it).
--
-- Residue: none.
--
-- Run only together with the app revert. Safe to run more than once.

begin;

alter table if exists public.profiles drop column if exists author_welcome_sent_at;

commit;
