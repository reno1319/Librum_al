-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Changes purchases.book_id from ON DELETE CASCADE to ON
-- DELETE RESTRICT, and adds the storage DELETE policies deleteBook
-- needs (see the Phase 8 audit's CRITICAL finding: deleting a book was
-- cascading to permanently destroy every purchase/acquisition record
-- for it, wiping out real readers' proof of ownership -- the app-level
-- fix in src/app/dashboard/books/actions.ts now blocks that case before
-- it reaches the database, but this migration is the authoritative,
-- database-level guarantee behind it).
--
-- ============================================================
-- 1. purchases.book_id: CASCADE -> RESTRICT
-- ============================================================
--
-- RESTRICT (not the default NO ACTION): both behave identically for an
-- immediate (non-deferred) constraint like this one, but RESTRICT
-- states the actual intent explicitly -- a book with any purchase
-- history must never be deletable, full stop.
--
-- book_id stays NOT NULL -- ownership is never severed. This is
-- deliberately different from purchases.bundle_id's existing
-- "on delete set null" (correct for bundle_id, since deleting a bundle
-- shouldn't affect the underlying per-book purchase records it fanned
-- out to) -- book_id is the purchase's actual subject, not an optional
-- grouping label, so severing it would be wrong.
--
-- No existing purchases rows are read, modified, or deleted by this
-- migration -- it only changes what's allowed to happen on a *future*
-- attempt to delete a referenced books row.
--
-- The constraint name below (purchases_book_id_fkey) is Postgres's
-- standard auto-generated name for a single-column inline "references"
-- constraint declared without an explicit name, exactly matching how
-- schema.sql's own "purchases" table declares it. If your live
-- database's constraint has some other name, this will fail loudly
-- with an error rather than silently doing nothing, so it's safe to
-- attempt -- if it fails, nothing about your data will have changed.
--
-- Wrapped in an explicit transaction so the drop and the recreate
-- either both happen or neither does -- without this, a failure on the
-- second statement (however unlikely) would leave the table with no
-- foreign key on book_id at all until manually corrected.

begin;

alter table public.purchases
  drop constraint purchases_book_id_fkey;

alter table public.purchases
  add constraint purchases_book_id_fkey
  foreign key (book_id) references public.books(id) on delete restrict;

commit;

-- ============================================================
-- 2. Storage DELETE policies for covers/manuscripts
-- ============================================================
--
-- deleteBook (src/app/dashboard/books/actions.ts) removes an author's
-- own cover/manuscript files when deleting a zero-acquisition book --
-- but no DELETE policy existed for storage.objects on any bucket, so
-- those removal calls were silently blocked by RLS and did nothing
-- (the deleted book's storage files were left orphaned). These mirror
-- the existing owner-scoped pattern already used for insert/update on
-- these same buckets: only the object's own path prefix (its owner's
-- user id) may delete it -- never another author's files, and never a
-- public/anonymous delete. avatars is intentionally not included here
-- -- nothing in deleteBook (or any other current code path) needs to
-- delete an avatar, so no DELETE policy is added for that bucket.

create policy "Authors can delete their own cover images"
  on storage.objects for delete
  using (bucket_id = 'covers' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can delete their own manuscripts"
  on storage.objects for delete
  using (bucket_id = 'manuscripts' and auth.uid()::text = (storage.foldername(name))[1]);
