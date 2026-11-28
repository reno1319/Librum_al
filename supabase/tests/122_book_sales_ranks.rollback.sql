-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for Amazon book page P4
-- (supabase/migrations/20261128130000_book_sales_ranks.sql).
-- Drops the rank function. The book page then shows no "Renditja" line
-- and no "Nr. 1 në ..." badge (its read fails quietly); the
-- "Zgjedhja e Librum" badge needs no database change and stays. No data
-- changes.

begin;

drop function public.book_sales_ranks(uuid);

commit;
