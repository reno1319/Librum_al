-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for LR1 patch 2
-- (supabase/migrations/20261125150000_libraria_only_on_librum.sql).
-- Drops the two staff functions and the category buttons table (the
-- page then shows the first 4 categories with books, A–Zh). The two
-- books columns, their CHECK and the public_books column STAY: removing
-- a view column means dropping public.public_books, which other
-- policies depend on, and the reverted app never reads or writes them.

begin;

drop function public.staff_set_libraria_category_buttons(text[]);
drop function public.staff_remove_only_on_librum(uuid);
drop table public.libraria_category_buttons;

commit;
