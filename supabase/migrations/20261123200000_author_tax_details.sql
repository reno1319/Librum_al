-- BUILD 3 (Renato 11-23): "Të dhënat e pagesës" -- the author's tax
-- details and bank account, required before a PAID book can be sent
-- for review or go live (sg1 a). Free books never need them.
--
-- Decisions this migration encodes:
--   * t1 a: one flat 15% withholding for everyone, so no treaty data,
--     no residence certificates.
--   * t2 a: an author living outside Albania gives ONE identifier, the
--     tax number of their home country, plus that country. An author in
--     Albania gives the NID (numri personal). Legal name in both cases.
--     No passport number, no date of birth, no ID scans, no address.
--   * t3 a: everything stays in lek. A foreign IBAN is accepted for the
--     ALL payout destination; the bank converts on payday.
--
-- 1. author_tax_details: one row per author. The author reads only
--    their own row (RLS); nobody else has any grant on the table, not
--    even service_role -- the same posture as author_payout_destinations
--    (migration 055). The only write path is set_author_tax_details().
--    No staff read path exists yet: it comes with the payouts work.
-- 2. set_author_tax_details(): SECURITY DEFINER, scoped by auth.uid(),
--    no author id parameter. Its error messages never echo the input.
-- 3. set_author_payout_destination(): the ALL currency now takes any
--    well-formed IBAN (Albanian ones keep their exact AL + 26 rule);
--    the MOD-97 check stays. Everything else is unchanged from 055.
-- 4. author_payment_details_ready_self() / _for(uuid): a yes/no
--    answer only (never a value), for the publish gate. _self is for
--    the signed-in author (authenticated); _for is for the staff
--    Approve action (service_role only). Grants, not a role check,
--    decide who may ask.
--
-- The row goes with the account: author_id references profiles ON
-- DELETE CASCADE, so the day-30 account deletion removes it.

-- ------------------------------------------------------------
-- 1. The table
-- ------------------------------------------------------------
create table public.author_tax_details (
  author_id uuid primary key references public.profiles(id) on delete cascade,
  -- ISO 3166-1 alpha-2 country of tax residence ('AL' = Albania;
  -- Kosovo is 'XK').
  country_code text not null
    constraint author_tax_details_country_check check (country_code ~ '^[A-Z]{2}$'),
  legal_name text not null
    constraint author_tax_details_legal_name_check
    check (btrim(legal_name) <> '' and char_length(legal_name) <= 200),
  -- Albania: the NID (letter, 8 digits, letter). Elsewhere: the home
  -- country's tax number, letters/digits only after normalising.
  tax_id text not null
    constraint author_tax_details_tax_id_check
    check (
      (country_code = 'AL' and tax_id ~ '^[A-Z][0-9]{8}[A-Z]$')
      or (country_code <> 'AL' and tax_id ~ '^[A-Z0-9]{4,30}$')
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.author_tax_details enable row level security;

revoke all on public.author_tax_details from public, anon, authenticated, service_role;
grant select on public.author_tax_details to authenticated;

create policy "Authors can view their own tax details"
  on public.author_tax_details for select
  using (auth.uid() = author_id);

-- ------------------------------------------------------------
-- 2. The one write path
-- ------------------------------------------------------------
create or replace function public.set_author_tax_details(
  p_country_code text,
  p_legal_name text,
  p_tax_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_country text;
  v_name text;
  v_tax_id text;
begin
  if v_uid is null then
    raise exception 'set_author_tax_details: not authenticated';
  end if;

  v_country := upper(btrim(coalesce(p_country_code, '')));
  v_name := btrim(regexp_replace(coalesce(p_legal_name, ''), '\s+', ' ', 'g'));
  -- Spaces, dashes, dots and slashes are typing help only.
  v_tax_id := upper(regexp_replace(coalesce(p_tax_id, ''), '[\s./-]+', '', 'g'));

  if v_country !~ '^[A-Z]{2}$' then
    raise exception 'set_author_tax_details: country is required';
  end if;
  if v_name = '' or char_length(v_name) > 200 then
    raise exception 'set_author_tax_details: legal name is required';
  end if;
  if v_country = 'AL' and v_tax_id !~ '^[A-Z][0-9]{8}[A-Z]$' then
    raise exception 'set_author_tax_details: nid format is not valid';
  end if;
  if v_country <> 'AL' and v_tax_id !~ '^[A-Z0-9]{4,30}$' then
    raise exception 'set_author_tax_details: tax number format is not valid';
  end if;

  insert into public.author_tax_details (author_id, country_code, legal_name, tax_id, updated_at)
  values (v_uid, v_country, v_name, v_tax_id, now())
  on conflict on constraint author_tax_details_pkey do update
    set country_code = excluded.country_code,
        legal_name = excluded.legal_name,
        tax_id = excluded.tax_id,
        updated_at = now();
end;
$$;

revoke all on function public.set_author_tax_details(text, text, text) from public, anon, authenticated;
grant execute on function public.set_author_tax_details(text, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Foreign IBANs for the lek payout destination (t3 a)
-- ------------------------------------------------------------
create or replace function public.set_author_payout_destination(
  p_currency text,
  p_beneficiary_name text,
  p_iban text
)
returns table (
  currency text,
  beneficiary_name text,
  iban text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_beneficiary_name text;
  v_iban text;
begin
  v_currency := upper(btrim(coalesce(p_currency, '')));
  v_beneficiary_name := btrim(coalesce(p_beneficiary_name, ''));
  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'set_author_payout_destination: currency must be a 3-letter ISO code';
  end if;

  if v_beneficiary_name = '' then
    raise exception 'set_author_payout_destination: beneficiary_name is required and must not be blank';
  end if;

  if v_iban = '' then
    raise exception 'set_author_payout_destination: iban is required and must not be blank';
  end if;

  -- BUILD 3 (t3 a): any country's IBAN shape (15-34 characters); an
  -- Albanian one must still be exactly AL + 26.
  if v_currency = 'ALL' and v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then
    raise exception 'set_author_payout_destination: iban does not match the expected IBAN format';
  end if;

  if v_currency = 'ALL' and v_iban like 'AL%' and v_iban !~ '^AL[0-9]{2}[A-Z0-9]{24}$' then
    raise exception 'set_author_payout_destination: iban does not match the expected Albanian IBAN format (AL + 26 digits/letters)';
  end if;

  if not public.iban_mod97_valid(v_iban) then
    raise exception 'set_author_payout_destination: iban fails checksum validation -- this only confirms the format is well-formed, never that the account exists or belongs to you';
  end if;

  -- ON CONFLICT ON CONSTRAINT: see migration 055 (the OUT parameter
  -- "currency" makes a bare column list ambiguous).
  insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban, updated_at)
  values (auth.uid(), v_currency, v_beneficiary_name, v_iban, now())
  on conflict on constraint author_payout_destinations_pkey do update
    set beneficiary_name = excluded.beneficiary_name,
        iban = excluded.iban,
        updated_at = now();

  currency := v_currency;
  beneficiary_name := v_beneficiary_name;
  iban := v_iban;
  select apd.updated_at into updated_at
  from public.author_payout_destinations apd
  where apd.author_id = auth.uid() and apd.currency = v_currency;
  return next;
end;
$$;

-- CREATE OR REPLACE keeps the existing grants (authenticated from 055,
-- service_role from 20261024200000); restated here so this file says
-- the whole truth on its own.
revoke all on function public.set_author_payout_destination(text, text, text) from public, anon;
grant execute on function public.set_author_payout_destination(text, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Ready to sell? (yes/no only)
-- ------------------------------------------------------------
-- Two functions, so the grants decide who may ask (no token-claim
-- check): the author asks about themselves only; the staff Approve
-- action (service_role) asks about the book's author.
create or replace function public.author_payment_details_ready_self()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (select 1 from public.author_tax_details t where t.author_id = auth.uid())
     and exists (
       select 1 from public.author_payout_destinations d
       where d.author_id = auth.uid() and d.currency = 'ALL'
     );
$$;

revoke all on function public.author_payment_details_ready_self() from public, anon, authenticated, service_role;
grant execute on function public.author_payment_details_ready_self() to authenticated;

create or replace function public.author_payment_details_ready_for(p_author_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_author_id is not null
     and exists (select 1 from public.author_tax_details t where t.author_id = p_author_id)
     and exists (
       select 1 from public.author_payout_destinations d
       where d.author_id = p_author_id and d.currency = 'ALL'
     );
$$;

revoke all on function public.author_payment_details_ready_for(uuid) from public, anon, authenticated, service_role;
grant execute on function public.author_payment_details_ready_for(uuid) to service_role;
