-- DEL follow-up (Renato 11-18): a reader's reviews are never hidden when
-- they ask to delete their account, not even during the 30 days. This
-- replaces del3 a for reviews only: pen names, series, books, bundles
-- and pre-orders of a pending account stay hidden as before.
--
-- public_reviews is the view of 20261118170000_account_deletion_grace
-- without its "not exists account_deletion_requests" filter. Same
-- columns, so the grants stay. Approved reviews kept after the real
-- deletion, and unapproved ones going with the account, are unchanged.

create or replace view public.public_reviews
  with (security_barrier)
as
  select r.id, r.book_id, r.rating, r.body, r.created_at,
         coalesce(
           (select p.review_name from public.profiles p where p.id = r.reader_id),
           r.deleted_reader_review_name
         ) as reviewer_name,
         exists (
           select 1 from public.purchases pu
            where pu.book_id = r.book_id
              and pu.reader_id = r.reader_id
              and pu.refunded_at is null
              and pu.amount_cents > 0
              and not exists (
                select 1 from public.payment_disputes d
                 where d.stripe_payment_intent_id = pu.stripe_payment_intent_id
                   and d.status = 'lost'
              )
         ) as verified,
         r.reviewer_is_author
  from public.reviews r
  where r.status = 'approved'
    and exists (select 1 from public.public_books pb where pb.id = r.book_id)
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = r.reader_id and sus.lifted_at is null
    );
