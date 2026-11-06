-- BD16 CF1 (P4 audit carry-forward): a free claim is saved only while
-- the book is live.
--
-- Until now the only guard was the website's status check in
-- getFreeBook() (src/app/(public)/libra/[id]/actions.ts): it writes the
-- purchases row with the service role, and nothing in the database
-- looked at the book. So a bug there could hand out a free pre-order
-- before its release day, or an unpublished or taken-down book.
-- Renato's choice (6 Nov): refuse every book that isn't live
-- (status 'published'), not only pre-orders.
--
-- What counts as a free claim: the row getFreeBook() writes, amount 0,
-- no payment id, and a stripe_checkout_session_id that starts with
-- 'free_' (its documented non-Stripe placeholder). Paid rows are never touched: a
-- verified payment always grants the book (STALE-CHECKOUT-1), and a
-- bundle share or a full discount can be 0, so amount_cents = 0 alone
-- is not a free claim; a bundle sale upserted over an old free row keeps
-- the 'free_' id but carries its paid share and payment id (even a 0
-- share, for a free book in a bundle), so it is not one either.
--
-- Refused (LB509): inserting a free claim, or turning an existing row
-- into a new one (the upsert over a refunded or lost-dispute row writes
-- a new 'free_' id; clearing refunded_at; moving it to another book or
-- reader). Kept: readers who already own the book, and every other
-- change to an existing row (refunds, disputes, payment_id, the reader
-- detached when a profile is deleted).
--
-- The book row is read FOR SHARE, so a claim cannot slip past a
-- concurrent unpublish or takedown.
--
-- Rollback: supabase/tests/096_bd16_free_claim_guard.rollback.sql

create function public.purchases_free_claim_live_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  -- Not a free claim: a paid row, or a bundle sale upserted over an old
  -- free row (it keeps the 'free_' id but carries the paid share and its
  -- payment id; the share can be 0 for a free book in a bundle).
  -- getFreeBook() always writes a null payment id.
  if new.stripe_checkout_session_id is null
     or new.stripe_checkout_session_id not like 'free\_%'
     or new.amount_cents <> 0
     or new.stripe_payment_intent_id is not null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.stripe_checkout_session_id = old.stripe_checkout_session_id
     and new.book_id = old.book_id
     and (new.reader_id is not distinct from old.reader_id or new.reader_id is null)
     and not (old.refunded_at is not null and new.refunded_at is null)
  then
    return new;
  end if;

  select b.status into v_status
    from public.books b
   where b.id = new.book_id
     for share;

  if v_status is distinct from 'published' then
    raise exception 'A free book can be claimed only while it is live.'
      using errcode = 'LB509';
  end if;

  return new;
end;
$$;

revoke all on function public.purchases_free_claim_live_only()
  from public, anon, authenticated, service_role;

create trigger purchases_free_claim_live_only
  before insert or update on public.purchases
  for each row
  execute function public.purchases_free_claim_live_only();
