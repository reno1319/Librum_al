-- POK-1: durable, provider-specific mapping for staging single-book
-- checkouts. The provider-neutral financial facts remain frozen on
-- book_checkout_intents; this table stores only POK order identity and the
-- creation claim needed to prevent two concurrent requests from intentionally
-- creating two hosted orders for the same intent.

create table public.pok_book_checkout_orders (
  intent_id uuid primary key
    references public.book_checkout_intents(id) on delete restrict,
  merchant_custom_reference text not null unique,
  provider_order_id text unique,
  checkout_url text,
  webhook_token uuid not null unique default gen_random_uuid(),
  creation_claim_id uuid not null,
  state text not null default 'creating'
    check (state in ('creating', 'ready', 'needs_reconciliation')),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (length(btrim(merchant_custom_reference)) > 0),
  check (provider_order_id is null or length(btrim(provider_order_id)) > 0),
  check (checkout_url is null or checkout_url ~ '^https://([A-Za-z0-9-]+\.)*pokpay\.io(/|$)'),
  check (
    (state = 'ready' and provider_order_id is not null and checkout_url is not null)
    or (state <> 'ready')
  )
);

alter table public.pok_book_checkout_orders enable row level security;
revoke all on public.pok_book_checkout_orders from public, anon, authenticated, service_role;
grant select, insert, update on public.pok_book_checkout_orders to service_role;

create index pok_book_checkout_orders_reconciliation_idx
  on public.pok_book_checkout_orders (updated_at)
  where state = 'needs_reconciliation';

create or replace function public.set_pok_book_checkout_order_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger pok_book_checkout_orders_set_updated_at
  before update on public.pok_book_checkout_orders
  for each row execute function public.set_pok_book_checkout_order_updated_at();

revoke all on function public.set_pok_book_checkout_order_updated_at() from public, anon, authenticated;

