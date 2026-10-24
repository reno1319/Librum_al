-- DOWNLOADS-1 (pipeline item 3: download log and the 14-day cancel
-- rule). ADDITIVE ONLY: one new table and three new functions. No drop,
-- no rename, no type change; no existing row, grant, policy or function
-- changes, and nothing is backfilled (downloads before this migration
-- were never recorded).
--
-- ROLLOUT ORDER. Apply this migration on staging BEFORE the application
-- in the same patch is deployed there: the new download route refuses to
-- hand a buyer the file when record_book_download() fails, and it does
-- not exist before this migration. The old code keeps working after it:
-- nothing it reads or writes changes. Production gets it only at a
-- release, through the authorized route.
--
-- WHAT CHANGES (Renato's answers 2026-10-24: 1a log before the file is
-- sent, no file without a log row; 2a date and time, the purchase and
-- the file version only, as the Privacy page says; 3a buyer and staff
-- see it, authors never; 4a a warning line while the cancel window is
-- open; 5 no cancel flow until POK is live):
--
--   1. public.book_downloads: one row each time a buyer is handed a
--      book's file. purchase_id (CASCADE: the Privacy page keeps a
--      download record as long as the purchase record it belongs to),
--      payment_id = the purchase's payment AT THAT MOMENT (purchases
--      has unique(book_id, reader_id) and the row is reused when a
--      refunded book is bought again, so the cancel rule asks about a
--      payment, never about the purchase row), reader_id (SET NULL when
--      the account is deleted, like purchases.reader_id), file_path (the
--      manuscript key served: which version) and downloaded_at. No IP
--      address and no browser (2a).
--        * RLS on with no policy; anon, authenticated and PUBLIC hold
--          nothing (the key holds the author's account id, which a buyer
--          must never see -- PEN-NAMES-2); service_role holds SELECT
--          only. Rows are written only by record_book_download() below,
--          owned by the migration owner; nobody may UPDATE or DELETE.
--
--   2. record_book_download(reader, book, file_path): service_role only
--      (the download route, after its own entitlement decision). Finds
--      the reader's ACTIVE purchase of the book (not refunded, no lost
--      dispute, the user_owns_book() predicate) and locks it FOR SHARE,
--      so a refund that updates the purchase waits for this row and then
--      sees it. Refuses a missing reader or book (LB470), a missing or
--      over-long file key (LB471) and no active purchase (LB472).
--
--   3. purchase_download_states(reader): service_role only (the admin
--      person page, after requireStaff). One row per purchase of that
--      account: book, payment, amount and currency, bought_at (the
--      payment's paid_at, else the purchase's created_at), refunded_at,
--      this payment's download count and first/last download of this
--      book, the first download of ANY book in the same payment (a
--      bundle), and cancel_open_until: bought_at + 14 days while the
--      purchase is a succeeded payment, not refunded, without a lost
--      dispute, nothing in that payment was downloaded and the 14 days
--      have not passed; null otherwise (free books, legacy Stripe rows
--      and anything not cancellable).
--
--   4. my_purchase_download_states(): authenticated, the caller's own
--      rows only (auth.uid()), and only book_id, first_downloaded_at and
--      cancel_open_until -- no payment id, no file key.
--
-- UNCHANGED: every existing table, view, function, grant and policy. The
-- refund functions (request_refund, review_refund_request) and the
-- Stripe-era 14-day request window are not touched (Stripe removal is
-- pipeline item 10). Cancelling a purchase and the checkout agreement
-- ship with the live POK build.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/080_book_downloads.test.sql and
-- 080_book_downloads_catalog_equivalence.sh.

-- ------------------------------------------------------------
-- 1. The download log
-- ------------------------------------------------------------
create table public.book_downloads (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete cascade,
  reader_id uuid references public.profiles(id) on delete set null,
  file_path text not null
    constraint book_downloads_file_path_check check (char_length(file_path) between 1 and 1024),
  downloaded_at timestamptz not null default now()
);

create index book_downloads_purchase_id_downloaded_at_idx
  on public.book_downloads (purchase_id, downloaded_at);

create index book_downloads_payment_id_idx
  on public.book_downloads (payment_id)
  where payment_id is not null;

create index book_downloads_reader_id_idx
  on public.book_downloads (reader_id);

alter table public.book_downloads enable row level security;

revoke all on public.book_downloads from public, anon, authenticated, service_role;
grant select on public.book_downloads to service_role;

-- ------------------------------------------------------------
-- 2. Writing a row
-- ------------------------------------------------------------
create function public.record_book_download(
  p_reader_id uuid,
  p_book_id uuid,
  p_file_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_payment_id uuid;
  v_id uuid;
begin
  if p_reader_id is null or p_book_id is null then
    raise exception 'record_book_download: reader and book are required'
      using errcode = 'LB470';
  end if;

  if p_file_path is null or pg_catalog.char_length(p_file_path) not between 1 and 1024 then
    raise exception 'record_book_download: a file key of 1 to 1024 characters is required'
      using errcode = 'LB471';
  end if;

  select p.id, p.payment_id
    into v_purchase_id, v_payment_id
    from public.purchases p
   where p.book_id = p_book_id
     and p.reader_id = p_reader_id
     and p.refunded_at is null
     and not public.payment_intent_has_lost_dispute(p.stripe_payment_intent_id)
   for share;

  if v_purchase_id is null then
    raise exception 'record_book_download: no active purchase of this book'
      using errcode = 'LB472';
  end if;

  insert into public.book_downloads (purchase_id, payment_id, reader_id, file_path)
  values (v_purchase_id, v_payment_id, p_reader_id, p_file_path)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_book_download(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_book_download(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 3. Download state and the cancel window, per purchase
-- ------------------------------------------------------------
create function public.purchase_download_states(p_reader_id uuid)
returns table (
  purchase_id uuid,
  book_id uuid,
  payment_id uuid,
  amount_minor integer,
  currency text,
  bought_at timestamptz,
  refunded_at timestamptz,
  download_count integer,
  first_downloaded_at timestamptz,
  last_downloaded_at timestamptz,
  payment_first_downloaded_at timestamptz,
  cancel_open_until timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select p.id as purchase_id,
           p.book_id,
           p.payment_id,
           p.amount_cents as amount_minor,
           pay.currency,
           pay.status as payment_status,
           coalesce(pay.paid_at, p.created_at) as bought_at,
           p.refunded_at,
           public.payment_intent_has_lost_dispute(p.stripe_payment_intent_id) as lost_dispute,
           (select pg_catalog.count(*)::integer
              from public.book_downloads d
             where d.purchase_id = p.id
               and d.payment_id is not distinct from p.payment_id) as download_count,
           (select pg_catalog.min(d.downloaded_at)
              from public.book_downloads d
             where d.purchase_id = p.id
               and d.payment_id is not distinct from p.payment_id) as first_downloaded_at,
           (select pg_catalog.max(d.downloaded_at)
              from public.book_downloads d
             where d.purchase_id = p.id
               and d.payment_id is not distinct from p.payment_id) as last_downloaded_at,
           case when p.payment_id is not null then
             (select pg_catalog.min(d.downloaded_at)
                from public.book_downloads d
               where d.payment_id = p.payment_id)
           end as payment_first_downloaded_at
      from public.purchases p
      left join public.payments pay on pay.id = p.payment_id
     where p_reader_id is not null
       and p.reader_id = p_reader_id
  )
  select b.purchase_id,
         b.book_id,
         b.payment_id,
         b.amount_minor,
         b.currency,
         b.bought_at,
         b.refunded_at,
         b.download_count,
         b.first_downloaded_at,
         b.last_downloaded_at,
         b.payment_first_downloaded_at,
         case
           when b.payment_id is not null
            and b.payment_status = 'succeeded'
            and b.refunded_at is null
            and not b.lost_dispute
            and b.payment_first_downloaded_at is null
            and b.bought_at + interval '14 days' > pg_catalog.now()
           then b.bought_at + interval '14 days'
         end as cancel_open_until
    from base b;
$$;

revoke all on function public.purchase_download_states(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.purchase_download_states(uuid) to service_role;

-- ------------------------------------------------------------
-- 4. The buyer's own view
-- ------------------------------------------------------------
create function public.my_purchase_download_states()
returns table (
  book_id uuid,
  first_downloaded_at timestamptz,
  cancel_open_until timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.book_id, s.first_downloaded_at, s.cancel_open_until
    from public.purchase_download_states(auth.uid()) s;
$$;

revoke all on function public.my_purchase_download_states()
  from public, anon, authenticated, service_role;
grant execute on function public.my_purchase_download_states() to authenticated;
