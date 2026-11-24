-- ROLLBACK for migration 20261123200000_author_tax_details.sql.
-- LOCAL/DISPOSABLE DATABASE TEST, or a deliberate rollback only.
-- Revert the app first (the old app never calls these). Safe to run
-- twice.
--
-- Lossy: every author's saved tax details are dropped with the table.
-- A foreign IBAN saved meanwhile STAYS in author_payout_destinations
-- (nothing is deleted there); after this rollback the old Albanian-only
-- rule applies to new saves again. Check for such rows before payouts:
--   select count(*) from public.author_payout_destinations
--    where currency = 'ALL' and iban not like 'AL%';

begin;

drop function if exists public.author_payment_details_ready_for(uuid);
drop function if exists public.author_payment_details_ready_self();
drop function if exists public.set_author_tax_details(text, text, text);
drop table if exists public.author_tax_details;

-- set_author_payout_destination(): back to the body before this
-- migration (055, Albanian IBANs only). CREATE OR REPLACE keeps the
-- grants (authenticated, service_role); restated so this file says the
-- whole truth on its own.
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

  if v_currency = 'ALL' and v_iban !~ '^AL[0-9]{2}[A-Z0-9]{24}$' then
    raise exception 'set_author_payout_destination: iban does not match the expected Albanian IBAN format (AL + 26 digits/letters)';
  end if;

  if not public.iban_mod97_valid(v_iban) then
    raise exception 'set_author_payout_destination: iban fails checksum validation -- this only confirms the format is well-formed, never that the account exists or belongs to you';
  end if;

  -- ON CONFLICT ON CONSTRAINT (not a bare column list): this
  -- function's own OUT parameter is also named "currency" (RETURNS
  -- TABLE above), which makes an unqualified "currency" in a bare
  -- ON CONFLICT (author_id, currency) column list ambiguous between
  -- the PL/pgSQL variable and the table column -- the same class of
  -- bug start_author_payout()'s own comment already documents once
  -- this session. Naming the constraint sidesteps it entirely.
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

revoke all on function public.set_author_payout_destination(text, text, text) from public, anon;
grant execute on function public.set_author_payout_destination(text, text, text) to authenticated, service_role;

commit;
