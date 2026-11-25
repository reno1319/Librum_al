-- GIFTS (Renato 2026-11-25, item 32 batch 2: g1 a, g2 a, g3 a, g4 a,
-- b2q1 a, b2q2 a, b2q3 a, b2q4 a, b2q5 a; pictures b2 r1 ok): a gift a
-- reader bought for someone else, and the secret link that gives it to
-- them.
--
-- Card payment is not open yet (b2q5 a: "build it now, money part
-- later"). NOTHING here creates a gift: the POK cart checkout will add
-- the row once the order is paid (one row per gift line of the cart) and
-- send the first email. Until then the table stays empty on every
-- database.
--
-- WHAT CHANGES:
--   1. public.gifts: the buyer, the book, the friend's email and note,
--      the HASH of the secret link token (never the token), the state
--      (waiting / claimed / recipient_owns), how many emails went out and
--      when, and who claimed it. Row level security on. The buyer reads
--      their own rows, and only the columns listed in the grant below
--      (never the token hash or who claimed it). Nobody but the
--      functions below writes.
--   2. public.gift_preview(token): what the link page shows (book, the
--      buyer's first name, the note, the state). Signed-out visitors may
--      call it (g1 a: the friend may not have an account yet).
--   3. public.claim_gift(token): the signed-in reader who opens the link
--      first gets the book (b2q4 a). If they already own it, the gift is
--      marked recipient_owns and stays open so the buyer can send it to
--      someone else (g3 a). The buyer can't claim their own gift.
--      Ownership is a purchases row for the friend, amount 0, session id
--      'gift_<gift id>' (the money sits with the buyer's paid order).
--   4. public.gift_resend(gift) and public.gift_change_email(gift, email):
--      the buyer's two buttons in the Library (g2 a, b2q3 a). Each checks
--      the rules and makes a NEW link, but only as PENDING: the live link,
--      the address and the count do not change yet. The app sends the
--      email with the pending link, then:
--        - sent: public.gift_confirm_send(gift, token) makes the pending
--          link the live one (the old one stops working) and counts the
--          email;
--        - not sent: public.gift_cancel_send(gift, token) drops the
--          pending link. Nothing was used up and the old link still works
--          (audit S1).
--      At most 3 emails per address, at most one a day. A DIFFERENT
--      address starts a new count (b2q3 a); the same address again keeps
--      counting (audit F2). Only one send can be pending at a time (a
--      minute), so parallel clicks can't send many emails.
--
-- Errors: LB530 the gift is not this reader's or does not exist, LB531
-- three emails already sent to this address, LB532 an email already went
-- out today, LB533 the gift was already claimed, LB534 the email is not
-- valid, LB535 another send is still pending, LB536 the pending link is
-- not this one (it was replaced or cancelled).
--
-- ROLLBACK: drop the ten functions (gift_token_hash, gift_new_token,
-- gift_buyer_first_name, gift_preview, claim_gift, gift_for_send,
-- gift_resend, gift_change_email, gift_confirm_send, gift_cancel_send),
-- then drop table public.gifts. The purchases rows of claimed gifts STAY
-- (they are the friends' books).

create table public.gifts (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid references public.profiles(id) on delete set null,
  book_id uuid not null references public.books(id) on delete restrict,
  recipient_email text not null,
  note text,
  token_hash text not null,
  status text not null default 'waiting',
  send_count integer not null default 0,
  last_sent_at timestamptz,
  claimed_by uuid references public.profiles(id) on delete set null,
  claimed_at timestamptz,
  purchase_id uuid references public.purchases(id) on delete set null,
  pending_token_hash text,
  pending_email text,
  pending_at timestamptz,
  created_at timestamptz not null default now(),
  constraint gifts_recipient_email_check check (
    char_length(recipient_email) between 3 and 254
    and recipient_email = lower(recipient_email)
    and recipient_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint gifts_note_check check (note is null or char_length(note) between 1 and 300),
  constraint gifts_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint gifts_token_hash_key unique (token_hash),
  constraint gifts_status_check check (status in ('waiting', 'claimed', 'recipient_owns')),
  constraint gifts_send_count_check check (send_count between 0 and 3),
  constraint gifts_claimed_check check (
    (status = 'claimed') = (claimed_at is not null)
  ),
  constraint gifts_pending_check check (
    (pending_token_hash is null and pending_email is null and pending_at is null)
    or (pending_token_hash ~ '^[0-9a-f]{64}$' and pending_email is not null and pending_at is not null)
  )
);

create index gifts_buyer_id_idx on public.gifts (buyer_id);

comment on table public.gifts is
  'GIFTS (item 32 batch 2): a bought gift and its secret link (only the sha256 of the token is stored). Rows come from the POK cart checkout. See migration 20261125140000_cart_gifts.sql.';

alter table public.gifts enable row level security;

revoke all on table public.gifts from public, anon, authenticated, service_role;
grant select (id, buyer_id, book_id, recipient_email, note, status, send_count, last_sent_at, claimed_at, created_at)
  on table public.gifts to authenticated;

create policy "Buyers see their own gifts"
  on public.gifts for select
  to authenticated
  using (auth.uid() = buyer_id);

-- A token from a link, as stored: sha256 hex.
create or replace function public.gift_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

revoke all on function public.gift_token_hash(text) from public, anon, authenticated, service_role;

-- A fresh link token: two random UUIDs without dashes, 64 hex characters.
create or replace function public.gift_new_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

revoke all on function public.gift_new_token() from public, anon, authenticated, service_role;

-- The buyer's first name as the friend sees it (b2q1 a).
create or replace function public.gift_buyer_first_name(p_buyer_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(split_part(btrim(p.display_name), ' ', 1), '') from public.profiles p where p.id = p_buyer_id),
    'Një lexues'
  );
$$;

revoke all on function public.gift_buyer_first_name(uuid) from public, anon, authenticated, service_role;

create or replace function public.gift_preview(p_token text)
returns table (book_id uuid, buyer_name text, note text, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select g.book_id, public.gift_buyer_first_name(g.buyer_id), g.note, g.status
    from public.gifts g
   where p_token is not null
     and char_length(p_token) = 64
     and g.token_hash = public.gift_token_hash(p_token);
$$;

revoke all on function public.gift_preview(text) from public, anon, authenticated, service_role;
grant execute on function public.gift_preview(text) to anon, authenticated;

create or replace function public.claim_gift(p_token text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_gift public.gifts%rowtype;
  v_pid uuid;
begin
  if v_uid is null then
    return 'signed_out';
  end if;
  if p_token is null or char_length(p_token) <> 64 then
    return 'invalid';
  end if;

  select * into v_gift
    from public.gifts g
   where g.token_hash = public.gift_token_hash(p_token)
   for update;

  if not found then
    return 'invalid';
  end if;
  if v_gift.status = 'claimed' then
    return 'used';
  end if;
  if v_gift.buyer_id = v_uid then
    return 'own_gift';
  end if;
  if public.user_owns_book(v_gift.book_id) then
    update public.gifts set status = 'recipient_owns' where id = v_gift.id;
    return 'owned';
  end if;

  insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id, refunded_at)
  values (v_gift.book_id, v_uid, 0, 'gift_' || v_gift.id::text, null, null)
  on conflict (book_id, reader_id) do update set
    amount_cents = excluded.amount_cents,
    stripe_checkout_session_id = excluded.stripe_checkout_session_id,
    stripe_payment_intent_id = null,
    refunded_at = null
  returning id into v_pid;

  update public.gifts
     set status = 'claimed', claimed_by = v_uid, claimed_at = now(), purchase_id = v_pid
   where id = v_gift.id;

  return 'claimed';
end;
$$;

revoke all on function public.claim_gift(text) from public, anon, authenticated, service_role;
grant execute on function public.claim_gift(text) to authenticated;

-- The buyer's own gift, locked, with the once-a-day rule checked and no
-- other send pending (a pending send older than a minute is abandoned).
create or replace function public.gift_for_send(p_gift_id uuid)
returns public.gifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gift public.gifts%rowtype;
begin
  select * into v_gift from public.gifts g where g.id = p_gift_id for update;
  if not found or v_gift.buyer_id is distinct from auth.uid() or auth.uid() is null then
    raise exception 'gifts: not your gift' using errcode = 'LB530';
  end if;
  if v_gift.status = 'claimed' then
    raise exception 'gifts: already claimed' using errcode = 'LB533';
  end if;
  if v_gift.last_sent_at is not null and v_gift.last_sent_at > now() - interval '1 day' then
    raise exception 'gifts: one email a day' using errcode = 'LB532';
  end if;
  if v_gift.pending_at is not null and v_gift.pending_at > now() - interval '1 minute' then
    raise exception 'gifts: a send is pending' using errcode = 'LB535';
  end if;
  return v_gift;
end;
$$;

revoke all on function public.gift_for_send(uuid) from public, anon, authenticated, service_role;

create or replace function public.gift_resend(p_gift_id uuid)
returns table (recipient_email text, token text, book_id uuid, buyer_name text, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gift public.gifts%rowtype := public.gift_for_send(p_gift_id);
  v_token text := public.gift_new_token();
begin
  if v_gift.status <> 'waiting' then
    raise exception 'gifts: already claimed' using errcode = 'LB533';
  end if;
  if v_gift.send_count >= 3 then
    raise exception 'gifts: three emails already sent' using errcode = 'LB531';
  end if;
  update public.gifts g
     set pending_token_hash = public.gift_token_hash(v_token), pending_email = g.recipient_email, pending_at = now()
   where g.id = v_gift.id;
  return query select v_gift.recipient_email, v_token, v_gift.book_id, public.gift_buyer_first_name(v_gift.buyer_id), v_gift.note;
end;
$$;

revoke all on function public.gift_resend(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gift_resend(uuid) to authenticated;

create or replace function public.gift_change_email(p_gift_id uuid, p_email text)
returns table (recipient_email text, token text, book_id uuid, buyer_name text, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_gift public.gifts%rowtype;
  v_token text;
begin
  if not (char_length(v_email) between 3 and 254 and v_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'gifts: email not valid' using errcode = 'LB534';
  end if;
  v_gift := public.gift_for_send(p_gift_id);
  -- The same address again is not a new count (audit F2).
  if v_email = v_gift.recipient_email and v_gift.send_count >= 3 then
    raise exception 'gifts: three emails already sent' using errcode = 'LB531';
  end if;
  v_token := public.gift_new_token();
  update public.gifts g
     set pending_token_hash = public.gift_token_hash(v_token), pending_email = v_email, pending_at = now()
   where g.id = v_gift.id;
  return query select v_email, v_token, v_gift.book_id, public.gift_buyer_first_name(v_gift.buyer_id), v_gift.note;
end;
$$;

revoke all on function public.gift_change_email(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.gift_change_email(uuid, text) to authenticated;

-- The email with the pending link went out: it becomes the live link,
-- the old one stops working, and the email counts. A different address
-- starts a new count of 1; the same address counts on (audit F2).
create or replace function public.gift_confirm_send(p_gift_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gift public.gifts%rowtype;
begin
  select * into v_gift from public.gifts g where g.id = p_gift_id for update;
  if not found or v_gift.buyer_id is distinct from auth.uid() or auth.uid() is null then
    raise exception 'gifts: not your gift' using errcode = 'LB530';
  end if;
  if v_gift.status = 'claimed' then
    raise exception 'gifts: already claimed' using errcode = 'LB533';
  end if;
  if v_gift.pending_token_hash is null or v_gift.pending_token_hash <> public.gift_token_hash(p_token) then
    raise exception 'gifts: not the pending link' using errcode = 'LB536';
  end if;
  update public.gifts g
     set token_hash = g.pending_token_hash,
         recipient_email = g.pending_email,
         status = 'waiting',
         send_count = case when g.pending_email = g.recipient_email then least(g.send_count + 1, 3) else 1 end,
         last_sent_at = now(),
         pending_token_hash = null, pending_email = null, pending_at = null
   where g.id = v_gift.id;
end;
$$;

revoke all on function public.gift_confirm_send(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.gift_confirm_send(uuid, text) to authenticated;

-- The email did not go out: drop the pending link. Nothing is used up
-- and the live link keeps working (audit S1).
create or replace function public.gift_cancel_send(p_gift_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.gifts g
     set pending_token_hash = null, pending_email = null, pending_at = null
   where g.id = p_gift_id
     and g.buyer_id = auth.uid()
     and g.pending_token_hash = public.gift_token_hash(p_token);
end;
$$;

revoke all on function public.gift_cancel_send(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.gift_cancel_send(uuid, text) to authenticated;
