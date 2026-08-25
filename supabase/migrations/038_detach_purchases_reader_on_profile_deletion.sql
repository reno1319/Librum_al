-- LAUNCH-1: purchase history retention alignment. purchases.reader_id
-- was the one outlier among this schema's transaction-adjacent tables --
-- ON DELETE CASCADE, unlike bundle_checkout_snapshots.reader_id,
-- refund_requests.reader_id, and book_checkout_intents.reader_id, all of
-- which already use ON DELETE SET NULL specifically because they are
-- financial/audit records: deleting the owning profile must not
-- silently delete the record of what was purchased/requested, only
-- detach it from the (now-gone) profile. See the Purchase History
-- Retention Alignment audit/design report for the full reasoning,
-- including the exhaustive trace proving no application code (RLS,
-- user_owns_book(), refund issuance, dispute processing, the Sales
-- dashboard) assumes purchases.reader_id is non-null.
--
-- Constraint name verified empirically against a freshly-applied
-- schema.sql (Postgres's own default inline-FK naming convention, not
-- assumed) before writing this migration: purchases_reader_id_fkey.
--
-- Deliberately touches nothing else: book_id stays RESTRICT (a book
-- with any acquisition history must never be deletable), bundle_id and
-- discount_code_id are already SET NULL, amount_cents/refunded_at/the
-- Stripe identifier columns/unique(book_id, reader_id)/RLS policies are
-- all untouched -- this is a pure FK-action change, no data is
-- rewritten and no existing row is touched by applying this migration.
-- Only a FUTURE profile deletion invokes the new SET NULL action.

alter table public.purchases
  alter column reader_id drop not null;

alter table public.purchases
  drop constraint purchases_reader_id_fkey;

alter table public.purchases
  add constraint purchases_reader_id_fkey
    foreign key (reader_id) references public.profiles(id) on delete set null;
