-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for Amazon book page P5
-- (supabase/migrations/20261128150000_books_bought_together.sql).
-- Drops the "bought together" function. The book page then always fills
-- "Blihen shpesh bashkë" with a same-genre book and shows no
-- "Blerë bashkë me këtë" chip (its read fails quietly). No data changes.

begin;

drop function public.books_bought_together(uuid);

commit;
