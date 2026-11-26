-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for LR1 patch 3
-- (supabase/migrations/20261125200000_libraria_banner_slides.sql).
-- Drops the three staff functions, the helper, the public view and the
-- slides table (Libraria then shows no banner). The "libraria" storage
-- bucket STAYS, with any pictures in it: removing stored files is a
-- separate, deliberate step.

begin;

drop function public.staff_move_libraria_banner_slide(uuid, boolean);
drop function public.staff_delete_libraria_banner_slide(uuid);
drop function public.staff_save_libraria_banner_slide(uuid, uuid, text, text, text, text, date, date);
drop function public.libraria_banner_busiest_day_count(uuid, date, date);
drop view public.public_libraria_banner_slides;
drop table public.libraria_banner_slides;

commit;
