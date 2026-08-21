-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Phase REFUND-1B Step 1: schema, RLS, and the two
-- SECURITY DEFINER functions (is_admin(), request_refund()) a
-- reader-initiated refund request needs. Deliberately schema-only --
-- no reader UI, no admin UI, and no change to the existing Stripe
-- webhook happen in this migration. See the Phase REFUND-1B plan for
-- the full design rationale; this file implements it, not re-derives
-- it.
--
-- Dependency order note: is_admin() is defined FIRST, before either
-- table, because both tables' "admin can view all" SELECT policies
-- reference it -- CREATE POLICY's USING expression is resolved at
-- creation time, not deferred, so the function must already exist. An
-- earlier draft of this migration defined is_admin() after both tables
-- (grouped with the other functions for readability) and failed to
-- apply for exactly this reason: "function public.is_admin() does not
-- exist". Every other object below follows the same rule -- nothing is
-- referenced before it is created -- see the ordering audit in the
-- Phase REFUND-1B implementation report for the full pass over this
-- file.
-- ============================================================
-- is_admin(): shared SECURITY DEFINER primitive for every admin-gated
-- RLS policy this and future phases need (refund review now; content
-- moderation, support tooling, etc. later -- see the Phase REFUND-1A
-- goal). Hardened per the Phase REFUND-1B security review: empty
-- search_path and a fully schema-qualified body, so nothing it touches
-- can be shadowed by an object in a schema the caller controls --
-- matches the same pattern already used by create_bundle_checkout_
-- snapshot(), user_owns_book(), and bestselling_books() in this file.
-- Depends only on public.profiles, which already exists as of
-- migration 001 -- no ordering dependency on anything else in this
-- file.
-- ============================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
revoke all on function public.is_admin() from authenticated;
grant execute on function public.is_admin() to authenticated;

-- ============================================================
-- refund_requests: one durable row per reader-initiated refund request,
-- always for an entire Stripe transaction (full-transaction refunds
-- only -- see the approved Phase REFUND-1B decisions; there is no
-- partial-amount concept anywhere in this design).
-- ============================================================

create table public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  -- Nullable, ON DELETE SET NULL -- not RESTRICT, and not the CASCADE
  -- purchases.reader_id itself uses. This is a financial/audit record:
  -- deleting the owning profile must not silently delete the record of
  -- what was requested, only detach it from the (now-gone) profile.
  -- request_refund() below always populates this from auth.uid() at
  -- creation time -- NULL is only ever reached afterward, as the result
  -- of profile deletion, never inserted directly.
  reader_id uuid references public.profiles(id) on delete set null,
  stripe_payment_intent_id text not null,
  -- Nullable: only populated for snapshot-based bundle purchases;
  -- legacy bundles and single-book purchases have no snapshot row.
  bundle_checkout_snapshot_id uuid references public.bundle_checkout_snapshots(id) on delete set null,
  -- Transaction-level amount, derived and validated by request_refund()
  -- -- never supplied by the client. NOT simply
  -- SUM(refund_request_items.amount_cents): for a bundle purchase where
  -- every book was already owned (the zero-eligible-item case from the
  -- Phase 9B-2 accounting audit), zero purchases rows exist for this
  -- payment intent at all, so refund_request_items is legitimately
  -- empty -- the only authoritative amount in that case is
  -- bundle_checkout_snapshots.total_amount_cents. See request_refund()'s
  -- own derivation of this value below.
  amount_cents integer not null check (amount_cents > 0),
  reason text check (reason is null or char_length(reason) <= 2000),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'refunded', 'cancelled')),
  requested_at timestamptz not null default now(),
  -- Nullable on purpose: a direct Stripe Dashboard refund (requested ->
  -- refunded with no prior approval step -- see the webhook's future
  -- extension, not part of this migration) leaves these null. That is a
  -- legitimate, expected terminal state, not a data gap.
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  admin_notes text,
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);

-- Prevents a reader from having two concurrently-open requests for the
-- same Stripe transaction. Partial (status-scoped), not a plain unique
-- constraint, so a rejected/cancelled request can still be followed by
-- a fresh one later. request_refund() also checks this explicitly
-- before inserting, to raise a friendly error rather than surface this
-- constraint's raw violation -- this index is the DB-level backstop for
-- that check, not the caller's only line of defense against it.
create unique index refund_requests_open_payment_intent_idx
  on public.refund_requests (stripe_payment_intent_id)
  where status in ('requested', 'approved');

create index refund_requests_reader_id_idx on public.refund_requests(reader_id);
create index refund_requests_status_idx on public.refund_requests(status);

alter table public.refund_requests enable row level security;

-- Explicit least-privilege table grants, rather than relying on RLS
-- policies alone to narrow whatever table-level privilege Supabase's
-- default privilege provisioning happens to hand anon/authenticated on
-- a newly created public-schema table. This is the same lesson already
-- learned twice in this codebase -- migration 028's profiles fix (a
-- standing table-level GRANT isn't narrowed by a column-scoped REVOKE)
-- and the Phase REFUND-1B security audit that found this table's own
-- earlier UPDATE policies were only safe because nobody had yet
-- exploited the untouched table-level grant behind them -- so here the
-- privilege model is stated outright instead of left implicit: revoke
-- everything, then grant back only SELECT. INSERT/UPDATE/DELETE are
-- never granted to anon or authenticated at all, on either role, at any
-- point in this file -- every mutation happens exclusively through the
-- SECURITY DEFINER functions below (request_refund(),
-- cancel_refund_request(), review_refund_request()), which run as the
-- function owner and are therefore unaffected by these revokes.
-- service_role is untouched by both statements below (only anon and
-- authenticated are named) and keeps its own separate, Supabase-
-- provisioned privileges -- the future webhook extension that will
-- write status = 'refunded' runs under service_role, same as every
-- other webhook write in this schema (see fulfillBundleSnapshot() in
-- src/app/api/webhooks/stripe/route.ts), and needs no grant here.
revoke all on public.refund_requests from anon, authenticated;
grant select on public.refund_requests to authenticated;

-- The SELECT policies below are still required -- the GRANT above only
-- says authenticated may run SELECT statements against this table at
-- all; RLS is what narrows which rows a given SELECT actually returns.
-- No INSERT/UPDATE/DELETE policy is defined for this table anywhere in
-- this file: with RLS enabled, zero policies for a command denies it
-- outright for every role regardless of any table-level grant -- and as
-- of the revoke above, there is no table-level grant for those commands
-- to fall back on in the first place. Two independent layers now agree:
-- privilege (no grant) and RLS (no policy).
create policy "Readers can view their own refund requests"
  on public.refund_requests
  for select
  using (auth.uid() = reader_id);

create policy "Admins can view all refund requests"
  on public.refund_requests
  for select
  using (public.is_admin());

-- Deliberately NO update policy for authenticated (or anyone) here
-- either. An earlier draft of this migration allowed direct
-- authenticated UPDATE through two row/status-scoped policies (reader:
-- requested -> cancelled; admin: requested -> approved/rejected). A
-- pre-implementation security audit found that RLS is row-scoped, not
-- column-scoped: WITH CHECK only constrains the *status* column's new
-- value, so nothing stopped a caller who legitimately satisfied one of
-- those policies from ALSO rewriting every other column on the same
-- row in the same statement -- amount_cents, stripe_payment_intent_id,
-- bundle_checkout_snapshot_id, reader_id, reviewed_by, reviewed_at,
-- refunded_at, admin_notes -- none of which WITH CHECK examined.
--
-- The fix: close the raw-UPDATE surface entirely (policies removed
-- here; the revoke-all grant above already means authenticated holds
-- no table-level UPDATE privilege to fall back on regardless) and
-- replace both transitions with narrow SECURITY DEFINER RPCs --
-- cancel_refund_request() and review_refund_request(), defined after
-- request_refund() below -- that update only the exact columns each
-- transition needs and derive every identity/timestamp value
-- (auth.uid(), now()) internally rather than trusting client-supplied
-- column values. This matches the pattern this schema already uses
-- everywhere else a value must be trustworthy (request_refund() itself
-- never accepts reader_id or amount_cents as arguments, for the same
-- reason).

-- ============================================================
-- refund_request_items: the per-book line items a refund_requests row
-- covers, frozen at request-creation time by request_refund() --
-- mirrors how bundle_checkout_snapshots freezes items/prices rather
-- than re-deriving them live. Can be empty for a request whose
-- transaction produced zero purchases rows (the zero-eligible-item
-- bundle case) -- amount_cents on the parent refund_requests row is
-- still correctly populated in that case; see above.
-- ============================================================

create table public.refund_request_items (
  id uuid primary key default gen_random_uuid(),
  refund_request_id uuid not null references public.refund_requests(id) on delete cascade,
  -- Nullable, ON DELETE SET NULL: purchases.reader_id cascades on
  -- profile deletion (existing, already-shipped behavior -- see
  -- schema.sql), so a purchases row this line item points at can be
  -- deleted out from under it as a side effect of the reader's account
  -- being deleted. RESTRICT here would then block that entire profile
  -- deletion from completing at all -- exactly the problem
  -- refund_requests.reader_id's own ON DELETE SET NULL exists to avoid,
  -- just one join further away. book_id and amount_cents below are
  -- untouched by this -- both are frozen at request-creation time and
  -- remain fully intact even if purchase_id later becomes null, so the
  -- audit record still answers "which book, how much" regardless.
  -- request_refund() always inserts a real purchase_id for every
  -- purchase-backed line item -- NULL is only ever reached afterward.
  purchase_id uuid references public.purchases(id) on delete set null,
  book_id uuid not null references public.books(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  unique (refund_request_id, purchase_id)
);

create index refund_request_items_refund_request_id_idx on public.refund_request_items(refund_request_id);

alter table public.refund_request_items enable row level security;

-- Same explicit least-privilege grant as refund_requests above, for
-- the same reason: state the privilege model outright rather than
-- relying on RLS alone to narrow an implicit table-level grant.
-- service_role is untouched (only anon and authenticated are named).
revoke all on public.refund_request_items from anon, authenticated;
grant select on public.refund_request_items to authenticated;

-- No insert/update/delete policy for authenticated here either --
-- request_refund() (SECURITY DEFINER) is the sole writer; deleting a
-- refund_requests row cascades these away automatically, and nothing
-- in this design ever updates an existing line item in place. As with
-- refund_requests, this is now doubly enforced: no table-level grant
-- for those commands (revoke above) and no RLS policy for them either.
create policy "Readers can view items on their own refund requests"
  on public.refund_request_items
  for select
  using (
    exists (
      select 1 from public.refund_requests
      where refund_requests.id = refund_request_items.refund_request_id
        and refund_requests.reader_id = auth.uid()
    )
  );

create policy "Admins can view all refund request items"
  on public.refund_request_items
  for select
  using (public.is_admin());

-- ============================================================
-- request_refund(): the sole path by which a refund_requests row (and
-- its refund_request_items) can ever be created. SECURITY DEFINER so
-- it can read/write past this table's otherwise-empty INSERT policy
-- surface, but every financial and ownership fact it uses is derived
-- and re-validated from authoritative tables inside this function --
-- never trusted from its own arguments. Hardened the same way as
-- is_admin() above: empty search_path, every table/function reference
-- schema-qualified. Genuine pg_catalog functions used below (length,
-- char_length, now, sum, min, count) are additionally qualified as
-- pg_catalog.* for consistency, though this is belt-and-suspenders --
-- pg_catalog is implicitly searched first regardless of search_path (it
-- is unconditionally consulted before any explicit path entry, and here
-- the explicit path is empty), so these could never actually be
-- shadowed even left unqualified. coalesce and nullif are deliberately
-- left unqualified: per the SQL standard, COALESCE/NULLIF are special
-- conditional expressions parsed directly by the SQL grammar, not
-- schema-resolvable function calls, so they carry no search_path
-- exposure and pg_catalog.coalesce(...)/pg_catalog.nullif(...) is not
-- valid syntax to begin with. The bare trim(...) calls below are left
-- unqualified for the same reason: PostgreSQL's TRIM(...) is SQL-
-- standard special syntax, not a plain call to a catalog function
-- literally named "trim" (the standard syntax is rewritten internally
-- to btrim/ltrim/rtrim) -- qualifying it as pg_catalog.trim(...) risks
-- referencing a function that does not exist under that name, for no
-- security benefit, since the special syntax is immune to search_path
-- shadowing by construction.
--
-- Arguments accepted from the client -- exactly these two, nothing
-- else:
--   p_stripe_payment_intent_id: a lookup key, not a financial or
--     ownership claim. The reader's own client already has legitimate
--     visibility into it via their own purchases rows.
--   p_reason: free text, no financial/ownership implication, length-
--     capped by this table's own CHECK constraint.
--
-- Everything else -- reader_id, whether this payment intent is really
-- theirs, whether it's already refunded, whether it's still within the
-- 14-day window, whether a request is already open for it, the exact
-- line items, and the transaction-level amount -- is derived and
-- validated here, never accepted as input.
-- ============================================================

create or replace function public.request_refund(
  p_stripe_payment_intent_id text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reader_id uuid;
  v_snapshot record;
  v_purchase_reader_count int;
  v_earliest_created_at timestamptz;
  v_amount_cents integer;
  v_request_id uuid;
  v_open_count int;
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
  end if;

  if p_stripe_payment_intent_id is null or pg_catalog.length(trim(p_stripe_payment_intent_id)) = 0 then
    raise exception 'stripe_payment_intent_id is required';
  end if;

  -- Ownership verification (anti-spoofing): at least one purchases row
  -- for this exact payment intent must belong to the caller, OR the
  -- matching bundle_checkout_snapshots row (if any) must belong to the
  -- caller -- the latter covers the zero-eligible-item bundle case,
  -- where no purchases row exists for this payment intent at all. A
  -- reader can never request a refund for a transaction that isn't
  -- theirs, even if they somehow learn or guess its payment intent id.
  select pg_catalog.count(*) into v_purchase_reader_count
  from public.purchases
  where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
    and purchases.reader_id = v_reader_id;

  select bcs.id, bcs.reader_id, bcs.total_amount_cents, bcs.fulfilled_at, bcs.refunded_at
  into v_snapshot
  from public.bundle_checkout_snapshots bcs
  where bcs.stripe_payment_intent_id = p_stripe_payment_intent_id;

  if v_purchase_reader_count = 0
     and (v_snapshot.id is null or v_snapshot.reader_id is distinct from v_reader_id) then
    raise exception 'no matching purchase found for this payment intent';
  end if;

  -- Already-refunded check -- full-transaction refunds only, so a
  -- single check covers it: any matching purchases row already
  -- refunded, or the matching snapshot already refunded, blocks a new
  -- request outright.
  if exists (
    select 1
    from public.purchases
    where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
      and purchases.reader_id = v_reader_id
      and purchases.refunded_at is not null
  ) or (v_snapshot.id is not null and v_snapshot.refunded_at is not null) then
    raise exception 'this purchase has already been refunded';
  end if;

  -- 14-day eligibility window (approved Phase REFUND-1B decision),
  -- measured from the earliest matching purchases row, or the
  -- snapshot's fulfilled_at when there are no purchases rows at all.
  -- This gates SUBMISSION only -- it says nothing about approval.
  select pg_catalog.min(purchases.created_at) into v_earliest_created_at
  from public.purchases
  where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
    and purchases.reader_id = v_reader_id;

  if v_earliest_created_at is null then
    v_earliest_created_at := v_snapshot.fulfilled_at;
  end if;

  if v_earliest_created_at is null or v_earliest_created_at < (pg_catalog.now() - interval '14 days') then
    raise exception 'this purchase is outside the refund request window';
  end if;

  -- Existing-open-request check -- a friendlier error than the raw
  -- unique index violation, which still exists as the DB-level
  -- backstop for this same rule.
  select pg_catalog.count(*) into v_open_count
  from public.refund_requests
  where refund_requests.stripe_payment_intent_id = p_stripe_payment_intent_id
    and refund_requests.status in ('requested', 'approved');

  if v_open_count > 0 then
    raise exception 'a refund request for this purchase is already open';
  end if;

  -- Transaction-level amount: sum of this reader's own purchases rows
  -- for this payment intent, or the snapshot's own total when there are
  -- none (the zero-eligible-item bundle case) -- see the Phase 9B-2
  -- accounting audit for why purchases rows alone are not always
  -- authoritative for a bundle transaction's full amount.
  select coalesce(pg_catalog.sum(purchases.amount_cents), 0) into v_amount_cents
  from public.purchases
  where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
    and purchases.reader_id = v_reader_id;

  if v_amount_cents = 0 then
    v_amount_cents := v_snapshot.total_amount_cents;
  end if;

  if v_amount_cents is null or v_amount_cents <= 0 then
    raise exception 'unable to determine a refundable amount for this payment intent';
  end if;

  insert into public.refund_requests (
    reader_id, stripe_payment_intent_id, bundle_checkout_snapshot_id,
    amount_cents, reason, status
  )
  values (
    v_reader_id, p_stripe_payment_intent_id, v_snapshot.id,
    v_amount_cents, nullif(trim(coalesce(p_reason, '')), ''), 'requested'
  )
  returning id into v_request_id;

  -- Line items: one per this reader's own purchases row on this payment
  -- intent with a positive amount. A legitimate $0 row (e.g. a free
  -- book bundled alongside paid ones) is still part of the transaction
  -- the webhook will later revoke entitlement for -- it just has no
  -- money to audit, so it gets no line item here (see this table's own
  -- CHECK (amount_cents > 0)).
  insert into public.refund_request_items (refund_request_id, purchase_id, book_id, amount_cents)
  select v_request_id, purchases.id, purchases.book_id, purchases.amount_cents
  from public.purchases
  where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
    and purchases.reader_id = v_reader_id
    and purchases.amount_cents > 0;

  return v_request_id;
end;
$$;

revoke all on function public.request_refund(text, text) from public;
revoke all on function public.request_refund(text, text) from anon;
revoke all on function public.request_refund(text, text) from authenticated;
grant execute on function public.request_refund(text, text) to authenticated;

-- ============================================================
-- cancel_refund_request(): the sole path by which a reader may move
-- their own refund_requests row from 'requested' to 'cancelled'. Exists
-- because direct authenticated UPDATE on refund_requests is revoked
-- above (see the comment on that revoke) -- an RLS policy's WITH CHECK
-- can only constrain the status column's new value, not pin every other
-- column to its prior value, so a raw UPDATE surface would let a caller
-- ride arbitrary column changes alongside a legitimate status
-- transition. This function only ever writes status, nothing else.
-- ============================================================

create or replace function public.cancel_refund_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reader_id uuid;
  v_updated_id uuid;
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
  end if;

  update public.refund_requests
  set status = 'cancelled'
  where id = p_id
    and reader_id = v_reader_id
    and status = 'requested'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no cancellable refund request found for this id';
  end if;
end;
$$;

revoke all on function public.cancel_refund_request(uuid) from public;
revoke all on function public.cancel_refund_request(uuid) from anon;
revoke all on function public.cancel_refund_request(uuid) from authenticated;
grant execute on function public.cancel_refund_request(uuid) to authenticated;

-- ============================================================
-- review_refund_request(): the sole path by which an admin may move a
-- refund_requests row from 'requested' to 'approved' or 'rejected'.
-- Same rationale as cancel_refund_request() above -- direct
-- authenticated UPDATE is revoked, so this is the only way to write
-- these columns. reviewed_by and reviewed_at are always derived
-- internally (auth.uid(), now()) and can never be supplied by the
-- caller, so an admin can never backdate a review or attribute it to a
-- different admin. p_decision only ever accepts 'approved' or
-- 'rejected' -- 'refunded' is not a reachable value through this
-- function (or through any other authenticated-accessible path; see
-- the revoked update above and the absence of any UPDATE policy).
-- ============================================================

create or replace function public.review_refund_request(
  p_id uuid,
  p_decision text,
  p_admin_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_updated_id uuid;
begin
  v_admin_id := auth.uid();
  if v_admin_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'p_decision must be ''approved'' or ''rejected''';
  end if;

  -- Same 2000-character cap as refund_requests.reason, for consistency.
  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  update public.refund_requests
  set status = p_decision,
      reviewed_at = pg_catalog.now(),
      reviewed_by = v_admin_id,
      admin_notes = nullif(trim(coalesce(p_admin_notes, '')), '')
  where id = p_id
    and status = 'requested'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no reviewable refund request found for this id';
  end if;
end;
$$;

revoke all on function public.review_refund_request(uuid, text, text) from public;
revoke all on function public.review_refund_request(uuid, text, text) from anon;
revoke all on function public.review_refund_request(uuid, text, text) from authenticated;
grant execute on function public.review_refund_request(uuid, text, text) to authenticated;
