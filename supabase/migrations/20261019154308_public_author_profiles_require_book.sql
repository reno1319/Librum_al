-- AUTHOR-VIEW-REQUIRE-BOOK-1: public.public_author_profiles shows an
-- author only once they have at least one book, of any status.
--
-- WHY. The view (migration 045) is readable by anon and returns id,
-- public_author_name, bio and avatar_path for EVERY profiles row with
-- role = 'author'. handle_new_user() creates that row the moment someone
-- signs up as an author -- before they confirm their email and whether
-- or not they ever start a book -- and copies the signup form's "Name"
-- box into public_author_name. So the name a person typed at signup was
-- readable through the public API even if they never wrote anything.
-- Renato, 2026-10-19: show only authors who have at least one book,
-- draft or live ("published only" was rejected: it would blank the
-- author's name in a buyer's Library and Wishlist once the author
-- unpublishes everything, and on an author's own first-draft preview).
--
-- WHAT CHANGES, and nothing else:
--   * the view body gains `exists (select 1 from public.books ...)`.
--     Same four columns, same order and types, so CREATE OR REPLACE VIEW
--     keeps the view's owner, ACL and reloptions (security_invoker stays
--     unset -- deliberately; see migration 045 and
--     20260911154752_restrict_public_author_profiles_grants.sql). The
--     view still runs as its owner, so books' own RLS does not apply
--     inside it and a draft-only author counts. books_author_id_idx
--     serves the EXISTS.
--   * the revoke/grant from 20260911154752 is re-stated, unchanged and
--     idempotent, so the view's privileges are pinned by this file too.
--
-- NOT CHANGED: profiles, books, every policy and grant on them,
-- search_books() (it reads the view only for authors of published books,
-- who always have a book), and no row of any table.
--
-- Visible effect: an author with zero books has no row, so
-- /authors/[id] for them is "not found", a follower's Following list
-- skips them, and a review they wrote shows no name (as a reader's does).
--
-- Rollback: re-run migration 045's view body with CREATE OR REPLACE VIEW.
--
-- If you're setting up a fresh project, just run schema.sql instead --
-- it already includes all of this.

create or replace view public.public_author_profiles as
  select p.id, p.public_author_name, p.bio, p.avatar_path
  from public.profiles p
  where p.role = 'author'
    and exists (
      select 1
      from public.books b
      where b.author_id = p.id
    );

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.public_author_profiles
  from anon, authenticated;

grant select
  on table public.public_author_profiles
  to anon, authenticated;
