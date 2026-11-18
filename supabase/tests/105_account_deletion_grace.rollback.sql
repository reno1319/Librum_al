-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- DEL ROLLBACK: undoes migration 20261118170000_account_deletion_grace.sql.
--
-- Refuses while any account is waiting to be deleted: its books and
-- bundles are drafts and only the new app can restore it. Restore or
-- finish those first.
--
-- Data lost: the saved "why are you leaving?" answers, and every review
-- kept from an already deleted reader (reader_id null) -- the old schema
-- needs a reader on every review.
--
-- Residue: none.
--
-- Run only together with the app revert. Safe to run more than once.

begin;

do $$
declare
  v_pending boolean := false;
begin
  -- Dynamic, so a second run (the table already gone) still parses.
  if to_regclass('public.account_deletion_requests') is not null then
    execute 'select exists (select 1 from public.account_deletion_requests)' into v_pending;
  end if;
  if v_pending then
    raise exception 'accounts are waiting to be deleted; restore or finish them before this rollback';
  end if;
end $$;

drop function if exists public.account_deletion_claim(uuid);
drop function if exists public.my_account_deletion_date();
drop function if exists public.my_account_status();
drop function if exists public.restore_my_account();
drop function if exists public.request_account_deletion(text, text);

drop trigger if exists bundles_refuse_publish_while_deletion_pending on public.bundles;
drop function if exists public.bundles_refuse_publish_while_deletion_pending();
drop trigger if exists books_refuse_publish_while_deletion_pending on public.books;
drop function if exists public.books_refuse_publish_while_deletion_pending();

-- The three views as they were (same columns, so grants stay).
create or replace view public.public_reviews
  with (security_barrier)
as
  select r.id, r.book_id, r.rating, r.body, r.created_at,
         (select p.review_name from public.profiles p where p.id = r.reader_id) as reviewer_name,
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

create or replace view public.public_pen_names
  with (security_barrier)
as
  select pn.id, pn.name, pn.bio, pn.avatar_path, pn.links
  from public.pen_names pn
  where (
       exists (select 1 from public.books b
                where b.pen_name_id = pn.id
                  and public.book_makes_pen_name_public(b))
    or pn.author_id = auth.uid()
    or (auth.uid() is not null
        and exists (select 1 from public.books b
                     where b.pen_name_id = pn.id
                       and (b.pd_work_id is null or b.pd_editor_credit)
                       and public.user_owns_book(b.id)))
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = pn.author_id and sus.lifted_at is null
    );

create or replace view public.public_series
  with (security_barrier)
as
  select s.id, s.title, s.pen_name_id, s.created_at
  from public.series s
  where (
       exists (select 1 from public.books b
                where b.series_id = s.id
                  and public.book_makes_pen_name_public(b))
    or s.author_id = auth.uid()
    or (auth.uid() is not null
        and exists (select 1 from public.books b
                     where b.series_id = s.id
                       and public.user_owns_book(b.id)))
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = s.author_id and sus.lifted_at is null
    );

drop trigger if exists profiles_keep_approved_reviews on public.profiles;
drop function if exists public.profiles_keep_approved_reviews();

delete from public.reviews where reader_id is null;
alter table public.reviews drop column if exists deleted_reader_review_name;
alter table public.reviews drop constraint if exists reviews_reader_id_fkey;
alter table public.reviews
  add constraint reviews_reader_id_fkey
  foreign key (reader_id) references public.profiles(id) on delete cascade;
alter table public.reviews alter column reader_id set not null;

drop table if exists public.account_deletion_feedback;
drop table if exists public.account_deletion_requests;

commit;
