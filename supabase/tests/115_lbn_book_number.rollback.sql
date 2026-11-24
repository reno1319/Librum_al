-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for LBN (supabase/migrations/20261124190000_lbn_book_number.sql).
-- Drops the two triggers and their functions and the generator (new
-- books get no code), and lets books.lbn be empty again (drops its NOT
-- NULL and its CHECK, which refuses an empty value), so the reverted app
-- can still create books. The existing codes with their UNIQUE,
-- lbn_issued, lbn_check_char(), lbn_is_valid() and the public_books
-- column STAY: removing a view column means dropping
-- public.public_books, which other policies depend on.

begin;

drop trigger books_assign_lbn on public.books;
drop trigger books_lbn_never_changes on public.books;
drop function public.books_assign_lbn();
drop function public.books_lbn_never_changes();
drop function public.lbn_generate(text);

alter table public.books
  alter column lbn drop not null,
  drop constraint books_lbn_check;

commit;
