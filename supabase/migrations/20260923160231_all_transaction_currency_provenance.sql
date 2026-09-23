-- ALL-TXN-CURRENCY-4 (Patch 4): transaction currency provenance for
-- every displayed transaction amount.
--
-- Read-only. Adds four internal helpers and two caller-scoped read RPCs,
-- and widens four existing finance.view RPCs (migration 043) with two
-- TRAILING result columns, currency_state and currency. Nothing else about
-- those four changes: same arguments, same SECURITY DEFINER, STABLE,
-- search_path = '', same permission checks, filters, cursors, clamps,
-- ORDER BY and LIMIT, and the same EXECUTE grants, re-issued verbatim
-- below because a RETURNS TABLE change needs DROP + CREATE.
--
-- Writes no row, adds no column, stores no currency, backfills nothing.
-- Rollout: this migration is additive for the currently deployed app
-- (PostgREST ignores result columns a caller does not read), so it
-- must be applied BEFORE the application change that reads them.

-- ============================================================
-- ALL-TXN-CURRENCY-4 (Patch 4): transaction currency provenance.
--
-- A stored transaction amount never identifies its own currency.
-- purchases.amount_cents, refund_requests.amount_cents,
-- refund_request_items.amount_cents and payment_disputes.amount_cents
-- are all integer MINOR UNITS of whatever currency the underlying
-- transaction was charged in, and none of those tables carries a
-- currency column. Every display surface therefore needs the currency
-- from somewhere authoritative -- and readers, authors and refund
-- staff cannot read the one table that states it outright
-- (public.payments is finance.view-only under RLS), while
-- book_checkout_intents is not readable by authenticated at all.
--
-- These helpers answer "what currency is this transaction in?" from
-- IMMUTABLE or explicitly documented facts only, and never guess:
--
--   evidence, keyed by the transaction's provider payment reference
--   (purchases/refund_requests/payment_disputes call it
--   stripe_payment_intent_id; for a librum_ledger_v1 purchase it holds
--   the provider_payment_id of ANY provider, POK included -- see
--   finalize_ledger_book_payment/finalize_ledger_bundle_payment):
--     1. payments.currency           (immutable ledger payment record)
--     2. book_checkout_intents.currency       (immutable, migration 056)
--     3. bundle_checkout_snapshots.currency   (immutable, migration 056)
--     4. 'USD' for a purchases row in the ONE row class the schema
--        itself defines as legacy USD (comment on
--        purchases.amount_cents): payment_id is null AND
--        regime = 'legacy_stripe_connect_v1'.
--
--   classification of the DISTINCT evidence currencies:
--     none      -> 'unknown'   (never defaulted to USD or ALL)
--     exactly 1 -> 'resolved'  with that currency
--     several   -> 'conflict'  (never picks one)
--
-- purchases.payment_id is deliberately NOT read directly: the row is a
-- reusable current-entitlement row, and neither the legacy webhook's
-- upsert nor the free-acquisition upsert resets payment_id, so after a
-- reuse it can point at an OLDER payment than the one amount_cents now
-- describes. A still-current payment_id always matches evidence (1)
-- through the reference anyway (record_successful_sale writes
-- payments.provider_payment_id = purchases.stripe_payment_intent_id).
--
-- No row is written, no currency is stored, nothing is converted.
-- ============================================================

create or replace function public.transaction_currency_evidence(p_reference text)
returns table (currency text)
language sql
stable
set search_path = ''
as $$
  select p.currency
    from public.payments p
    where p_reference is not null
      and p.provider_payment_id = p_reference
  union all
  select i.currency
    from public.book_checkout_intents i
    where p_reference is not null
      and i.stripe_payment_intent_id = p_reference
  union all
  select s.currency
    from public.bundle_checkout_snapshots s
    where p_reference is not null
      and s.stripe_payment_intent_id = p_reference
  union all
  select 'USD'::text
    from public.purchases pu
    where p_reference is not null
      and pu.stripe_payment_intent_id = p_reference
      and pu.payment_id is null
      and pu.regime = 'legacy_stripe_connect_v1';
$$;

create or replace function public.classify_transaction_currency(p_currencies text[])
returns table (currency_state text, currency text)
language sql
immutable
set search_path = ''
as $$
  with distinct_currencies as (
    select distinct c
      from pg_catalog.unnest(coalesce(p_currencies, '{}'::text[])) as c
      where c is not null
  )
  select
    case (select pg_catalog.count(*) from distinct_currencies)
      when 0 then 'unknown'
      when 1 then 'resolved'
      else 'conflict'
    end,
    case
      when (select pg_catalog.count(*) from distinct_currencies) = 1
        then (select c from distinct_currencies)
    end;
$$;

-- Always exactly one row. p_bundle_checkout_snapshot_id adds that
-- snapshot's frozen currency as further evidence (a refund request
-- stores it alongside its reference).
create or replace function public.transaction_currency_provenance(
  p_reference text,
  p_bundle_checkout_snapshot_id uuid default null
)
returns table (currency_state text, currency text)
language sql
stable
set search_path = ''
as $$
  select c.currency_state, c.currency
    from public.classify_transaction_currency(array(
      select e.currency from public.transaction_currency_evidence(p_reference) e
      union all
      select s.currency
        from public.bundle_checkout_snapshots s
        where p_bundle_checkout_snapshot_id is not null
          and s.id = p_bundle_checkout_snapshot_id
    )) c;
$$;

-- Always exactly one row. A purchases row with no provider reference
-- and a zero amount is a free acquisition (acquireFreeBook): no money
-- moved, so it is 'free' and carries no currency at all. Any other row
-- is classified by its reference; a non-zero row with no reference has
-- no evidence and is therefore 'unknown'.
create or replace function public.purchase_currency_provenance(
  p_reference text,
  p_amount_cents integer
)
returns table (currency_state text, currency text)
language sql
stable
set search_path = ''
as $$
  select 'free'::text, null::text
    where p_reference is null and p_amount_cents is not distinct from 0
  union all
  select c.currency_state, c.currency
    from public.transaction_currency_provenance(p_reference) c
    where not (p_reference is null and p_amount_cents is not distinct from 0);
$$;

revoke all on function public.transaction_currency_evidence(text)
  from public, anon, authenticated, service_role;
revoke all on function public.classify_transaction_currency(text[])
  from public, anon, authenticated, service_role;
revoke all on function public.transaction_currency_provenance(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.purchase_currency_provenance(text, integer)
  from public, anon, authenticated, service_role;

-- ============================================================
-- list_purchase_currencies(): the currency of each purchases row the
-- CALLER can already see -- exactly the two purchases SELECT policies,
-- re-applied server-side: the caller's own purchases, or purchases of
-- books the caller authors. Ids the caller cannot see are silently
-- absent, exactly as the table read itself would omit them; the
-- function can therefore never disclose that another reader's purchase
-- exists. Returns currency facts only -- no amount, reference, payment
-- id, provider or buyer identity.
-- ============================================================
create or replace function public.list_purchase_currencies(p_purchase_ids uuid[])
returns table (purchase_id uuid, currency_state text, currency text)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  return query
    select pu.id, cp.currency_state, cp.currency
      from public.purchases pu
      cross join lateral public.purchase_currency_provenance(
        pu.stripe_payment_intent_id, pu.amount_cents
      ) cp
      where pu.id = any(coalesce(p_purchase_ids, '{}'::uuid[]))
        and (
          pu.reader_id = auth.uid()
          or exists (
            select 1 from public.books b
            where b.id = pu.book_id
              and b.author_id = auth.uid()
          )
        )
      order by pu.id;
end;
$$;

revoke all on function public.list_purchase_currencies(uuid[]) from public;
revoke all on function public.list_purchase_currencies(uuid[]) from anon;
revoke all on function public.list_purchase_currencies(uuid[]) from authenticated;
grant execute on function public.list_purchase_currencies(uuid[]) to authenticated;

-- ============================================================
-- list_refund_request_currencies(): the currency of each refund
-- request, for staff holding refunds.view -- the same permission the
-- refund_requests/refund_request_items SELECT policies require. A
-- request's currency is its own frozen reference's (plus its frozen
-- bundle snapshot's), never the CURRENT purchases row's: that row may
-- have been reused by a later transaction since the request was made.
-- Its refund_request_items were copied from the same reference's
-- purchases rows by request_refund(), so they share this currency.
-- ============================================================
create or replace function public.list_refund_request_currencies(p_refund_request_ids uuid[])
returns table (refund_request_id uuid, currency_state text, currency text)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.view') then
    raise exception 'not authorized';
  end if;

  return query
    select rr.id, cp.currency_state, cp.currency
      from public.refund_requests rr
      cross join lateral public.transaction_currency_provenance(
        rr.stripe_payment_intent_id, rr.bundle_checkout_snapshot_id
      ) cp
      where rr.id = any(coalesce(p_refund_request_ids, '{}'::uuid[]))
      order by rr.id;
end;
$$;

revoke all on function public.list_refund_request_currencies(uuid[]) from public;
revoke all on function public.list_refund_request_currencies(uuid[]) from anon;
revoke all on function public.list_refund_request_currencies(uuid[]) from authenticated;
grant execute on function public.list_refund_request_currencies(uuid[]) to authenticated;

-- ============================================================
-- list_refund_reconciliation_states: widened with trailing currency_state/currency.
-- ============================================================
drop function public.list_refund_reconciliation_states(text, boolean, timestamptz, uuid, integer);

create or replace function public.list_refund_reconciliation_states(
  p_operational_state text default null,
  p_needs_attention boolean default null,
  p_cursor_requested_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  refund_request_id uuid,
  reader_id uuid,
  reader_display_name text,
  amount_cents integer,
  refund_request_status text,
  requested_at timestamptz,
  reviewed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  latest_attempt_created_at timestamptz,
  latest_attempt_updated_at timestamptz,
  stripe_refund_id text,
  stripe_status text,
  operational_state text,
  needs_attention boolean,
  currency_state text,
  currency text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  if p_operational_state is not null and p_operational_state not in (
    'requested', 'rejected', 'refunded', 'cancelled',
    'approved_unattempted', 'approved_attempt_initiated',
    'approved_attempt_stale_initiated', 'approved_attempt_unknown',
    'approved_attempt_failed', 'approved_attempt_submitted'
  ) then
    raise exception 'invalid operational_state filter';
  end if;

  if (p_cursor_requested_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      r.refund_request_id,
      r.reader_id,
      p.display_name as reader_display_name,
      r.amount_cents,
      r.refund_request_status,
      r.requested_at,
      r.reviewed_at,
      r.latest_attempt_id,
      r.latest_attempt_status,
      r.latest_attempt_created_at,
      r.latest_attempt_updated_at,
      r.stripe_refund_id,
      r.stripe_status,
      r.operational_state,
      r.needs_attention,
      cp.currency_state,
      cp.currency
    from public.refund_reconciliation_rows() r
    left join public.profiles p on p.id = r.reader_id
    left join public.refund_requests rq on rq.id = r.refund_request_id
    cross join lateral public.transaction_currency_provenance(
      rq.stripe_payment_intent_id, rq.bundle_checkout_snapshot_id
    ) cp
    where (p_operational_state is null or r.operational_state = p_operational_state)
      and (p_needs_attention is null or r.needs_attention = p_needs_attention)
      and (
        p_cursor_requested_at is null
        or (r.requested_at, r.refund_request_id) < (p_cursor_requested_at, p_cursor_id)
      )
    order by r.requested_at desc, r.refund_request_id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from public;
revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from anon;
revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) to authenticated;

-- ALL-TXN-CURRENCY-4: stated explicitly, so recreating this function
-- (a RETURNS TABLE change needs DROP + CREATE) keeps the EXECUTE that
-- staging's service_role already holds without relying on the
-- platform's default privileges.
grant execute on function public.list_refund_reconciliation_states(text, boolean, timestamptz, uuid, integer) to service_role;

-- ============================================================
-- list_finance_disputes: widened with trailing currency_state/currency.
-- ============================================================
drop function public.list_finance_disputes(boolean, timestamptz, uuid, integer);

create or replace function public.list_finance_disputes(
  p_needs_attention boolean default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  stripe_dispute_id text,
  stripe_payment_intent_id text,
  reader_id uuid,
  reader_display_name text,
  status text,
  reason text,
  amount_cents integer,
  created_at timestamptz,
  updated_at timestamptz,
  transfer_reversal_status text,
  stripe_transfer_reversal_id text,
  transfer_reversal_attempt_count integer,
  transfer_reversal_attempted_at timestamptz,
  transfer_reversal_succeeded_at timestamptz,
  transfer_reversal_failure_code text,
  needs_attention boolean,
  currency_state text,
  currency text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      pd.id,
      pd.stripe_dispute_id,
      pd.stripe_payment_intent_id,
      coalesce(bundle_ctx.reader_id, purchase_ctx.reader_id) as reader_id,
      coalesce(bundle_ctx.reader_display_name, purchase_ctx.reader_display_name) as reader_display_name,
      pd.status,
      pd.reason,
      pd.amount_cents,
      pd.created_at,
      pd.updated_at,
      pd.transfer_reversal_status,
      pd.stripe_transfer_reversal_id,
      pd.transfer_reversal_attempt_count,
      pd.transfer_reversal_attempted_at,
      pd.transfer_reversal_succeeded_at,
      pd.transfer_reversal_failure_code,
      (
        pd.status not in ('won', 'lost', 'warning_closed', 'charge_refunded')
        or (
          pd.status = 'lost'
          and (
            pd.transfer_reversal_status = 'failed'
            or (
              pd.transfer_reversal_status = 'attempting'
              and pd.transfer_reversal_attempted_at <= (now() - interval '10 minutes')
            )
          )
        )
      ) as needs_attention,
      cp.currency_state,
      cp.currency
    from public.payment_disputes pd
    left join lateral (
      select bcs.reader_id, pr.display_name as reader_display_name
      from public.bundle_checkout_snapshots bcs
      left join public.profiles pr on pr.id = bcs.reader_id
      where bcs.stripe_payment_intent_id = pd.stripe_payment_intent_id
      limit 1
    ) bundle_ctx on true
    left join lateral (
      select pu.reader_id, pr2.display_name as reader_display_name
      from public.purchases pu
      left join public.profiles pr2 on pr2.id = pu.reader_id
      where pu.stripe_payment_intent_id = pd.stripe_payment_intent_id
      order by pu.created_at desc, pu.id desc
      limit 1
    ) purchase_ctx on true
    cross join lateral public.transaction_currency_provenance(pd.stripe_payment_intent_id) cp
    where (
      p_needs_attention is null
      or (
        pd.status not in ('won', 'lost', 'warning_closed', 'charge_refunded')
        or (
          pd.status = 'lost'
          and (
            pd.transfer_reversal_status = 'failed'
            or (
              pd.transfer_reversal_status = 'attempting'
              and pd.transfer_reversal_attempted_at <= (now() - interval '10 minutes')
            )
          )
        )
      ) = p_needs_attention
    )
    and (
      p_cursor_created_at is null
      or (pd.created_at, pd.id) < (p_cursor_created_at, p_cursor_id)
    )
    order by pd.created_at desc, pd.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from public;
revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from anon;
revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) to authenticated;

-- ALL-TXN-CURRENCY-4: stated explicitly, so recreating this function
-- (a RETURNS TABLE change needs DROP + CREATE) keeps the EXECUTE that
-- staging's service_role already holds without relying on the
-- platform's default privileges.
grant execute on function public.list_finance_disputes(boolean, timestamptz, uuid, integer) to service_role;

-- ============================================================
-- list_finance_checkout_exceptions: widened with trailing currency_state/currency.
-- ============================================================
drop function public.list_finance_checkout_exceptions(timestamptz, uuid, integer);

create or replace function public.list_finance_checkout_exceptions(
  p_cursor_completed_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  intent_id uuid,
  book_id uuid,
  book_title text,
  reader_id uuid,
  reader_display_name text,
  price_cents_at_checkout integer,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  completed_at timestamptz,
  reconciliation_reason text,
  created_at timestamptz,
  currency_state text,
  currency text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  if (p_cursor_completed_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      bci.id as intent_id,
      bci.book_id,
      bci.book_title,
      bci.reader_id,
      p.display_name as reader_display_name,
      bci.price_cents_at_checkout,
      bci.stripe_checkout_session_id,
      bci.stripe_payment_intent_id,
      bci.completed_at,
      bci.reconciliation_reason,
      bci.created_at,
      'resolved'::text as currency_state,
      bci.currency
    from public.book_checkout_intents bci
    left join public.profiles p on p.id = bci.reader_id
    where bci.completed_at is not null
      and bci.fulfilled_at is null
      and (
        p_cursor_completed_at is null
        or (bci.completed_at, bci.id) < (p_cursor_completed_at, p_cursor_id)
      )
    order by bci.completed_at desc, bci.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from public;
revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from anon;
revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) to authenticated;

-- ALL-TXN-CURRENCY-4: stated explicitly, so recreating this function
-- (a RETURNS TABLE change needs DROP + CREATE) keeps the EXECUTE that
-- staging's service_role already holds without relying on the
-- platform's default privileges.
grant execute on function public.list_finance_checkout_exceptions(timestamptz, uuid, integer) to service_role;

-- ============================================================
-- list_finance_refund_entitlement_mismatches: widened with trailing currency_state/currency.
-- ============================================================
drop function public.list_finance_refund_entitlement_mismatches(integer);

create or replace function public.list_finance_refund_entitlement_mismatches(
  p_limit integer default 25
)
returns table (
  mismatch_type text,
  refund_request_id uuid,
  purchase_id uuid,
  bundle_checkout_snapshot_id uuid,
  reader_id uuid,
  reader_display_name text,
  stripe_payment_intent_id text,
  amount_cents integer,
  currency_state text,
  currency text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    (
      select
        'refunded_request_active_purchase'::text as mismatch_type,
        rr.id as refund_request_id,
        pu.id as purchase_id,
        null::uuid as bundle_checkout_snapshot_id,
        rr.reader_id,
        p.display_name as reader_display_name,
        rr.stripe_payment_intent_id,
        rr.amount_cents,
        cp.currency_state,
        cp.currency
      from public.refund_requests rr
      join public.purchases pu on pu.stripe_payment_intent_id = rr.stripe_payment_intent_id
      left join public.profiles p on p.id = rr.reader_id
      cross join lateral public.transaction_currency_provenance(
        rr.stripe_payment_intent_id, rr.bundle_checkout_snapshot_id
      ) cp
      where rr.status = 'refunded'
        and rr.bundle_checkout_snapshot_id is null
        and pu.refunded_at is null
    )
    union all
    (
      select
        'refunded_request_active_bundle_snapshot'::text,
        rr.id,
        null::uuid,
        bcs.id,
        rr.reader_id,
        p.display_name,
        rr.stripe_payment_intent_id,
        rr.amount_cents,
        cp.currency_state,
        cp.currency
      from public.refund_requests rr
      join public.bundle_checkout_snapshots bcs on bcs.id = rr.bundle_checkout_snapshot_id
      left join public.profiles p on p.id = rr.reader_id
      cross join lateral public.transaction_currency_provenance(
        rr.stripe_payment_intent_id, rr.bundle_checkout_snapshot_id
      ) cp
      where rr.status = 'refunded'
        and rr.bundle_checkout_snapshot_id is not null
        and bcs.refunded_at is null
    )
    union all
    (
      select
        'purchase_refunded_request_unresolved'::text,
        rr.id,
        pu.id,
        null::uuid,
        pu.reader_id,
        p.display_name,
        pu.stripe_payment_intent_id,
        pu.amount_cents,
        cp.currency_state,
        cp.currency
      from public.purchases pu
      join public.refund_requests rr on rr.stripe_payment_intent_id = pu.stripe_payment_intent_id
      left join public.profiles p on p.id = pu.reader_id
      cross join lateral public.purchase_currency_provenance(
        pu.stripe_payment_intent_id, pu.amount_cents
      ) cp
      where pu.refunded_at is not null
        and rr.status <> 'refunded'
    )
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from public;
revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from anon;
revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from authenticated;
grant execute on function public.list_finance_refund_entitlement_mismatches(integer) to authenticated;

-- ALL-TXN-CURRENCY-4: stated explicitly, so recreating this function
-- (a RETURNS TABLE change needs DROP + CREATE) keeps the EXECUTE that
-- staging's service_role already holds without relying on the
-- platform's default privileges.
grant execute on function public.list_finance_refund_entitlement_mismatches(integer) to service_role;
