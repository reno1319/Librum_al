-- LIBRUM 2.0 LEDGER-1D: author-facing financial reporting + safe read
-- model. Built on migrations 048/049, both already LIVE in production
-- and NOT modified by this file in any way (048/049's own DDL text is
-- byte-unchanged; this migration only ADDS new objects and DROPS one
-- now-superseded RLS policy on an already-empty table).
--
-- CRITICAL BUSINESS FACT (unchanged from LEDGER-1C/1C.1): Librum's
-- current checkout still uses Stripe Connect destination charges --
-- nothing in this migration is called by any Stripe checkout/webhook/
-- refund/dispute code path, and it creates no rows. All five financial
-- tables have zero production rows at the time this migration is
-- written; the reporting functions below are exercised in production
-- only once real ledger entries eventually exist.
--
-- ============================================================
-- SCOPE: this migration adds exactly two new SECURITY DEFINER
-- functions -- get_author_financial_summary() and
-- list_author_financial_activity() -- and drops one RLS policy
-- (author_ledger_entries' own "Authors can view their own ledger
-- entries" policy, migration 048). No new table. No new column.
-- ============================================================

-- ============================================================
-- Part 1: tighten author-facing raw table access (LEDGER-1D Section
-- 10). Migration 048 originally gave authors a direct RLS policy onto
-- author_ledger_entries' base table -- reasonable when written (no
-- author-facing UI existed yet to actually expose those columns), but
-- this table also carries payment_id/payout_id/payment_refund_id/
-- reference_type/reference_id, which an author has no legitimate need
-- to see directly even though none of them individually leaks another
-- person's data (migration 048's own Section 45 already established
-- that). Since zero production rows exist yet and no application code
-- reads this table today, THIS is the clean moment to close that direct
-- path before any real usage pattern has to be migrated off of it.
--
-- DROP POLICY, not a grant change: the table-level `grant select ... to
-- authenticated` (migration 048) is left untouched, because
-- staff_has_permission('finance.view')'s own SELECT policy on this same
-- table -- also from migration 048, also untouched -- still needs that
-- grant to have anything to narrow. Dropping ONLY the author-own policy
-- means: staff with finance.view keeps reading this table exactly as
-- before (unaffected -- finance.view is never broken by this
-- migration); an ordinary authenticated caller who is NOT staff now
-- matches zero policies on this table and sees zero rows (the same
-- "grant present, no matching policy -> empty result set" behavior
-- migration 048's own test suite already established for every other
-- non-owning role) -- there is no longer a policy under which an author
-- could read their OWN raw rows directly. Their new, safe path is
-- exclusively the two functions below.
-- ============================================================

drop policy "Authors can view their own ledger entries" on public.author_ledger_entries;

-- ============================================================
-- Part 2: get_author_financial_summary() -- the one safe, currency-
-- grouped snapshot of "what does Librum currently owe this author."
--
-- AUTHENTICATION (Section 11/14): takes NO parameters. The caller's own
-- identity comes from auth.uid() alone -- there is structurally no way
-- to request another author's summary, unlike, say, a hypothetical
-- get_author_financial_summary(p_author_id uuid) this migration
-- deliberately does not build. A reader (or any authenticated caller
-- with zero ledger rows) gets zero result rows back -- not an error --
-- exactly the "reader account: no financial data" requirement.
--
-- SECURITY DEFINER (not SECURITY INVOKER): required precisely because
-- Part 1 above just removed the author-own RLS policy this function
-- would otherwise need as an invoker -- as the function OWNER, it reads
-- author_ledger_entries directly (RLS does not apply to a table's
-- owner), then filters to auth.uid() ITSELF, in the query text, which
-- is what makes this safe despite bypassing RLS: the WHERE clause IS
-- the access control here, exactly like every other SECURITY DEFINER
-- function in this schema (staff_has_permission(), review_book_report(),
-- etc.).
--
-- MULTI-CURRENCY (Section 8): grouped by currency, never summed across
-- currencies -- an author with both EUR and USD activity gets two
-- separate rows, never one combined (meaningless) number. No FX
-- conversion anywhere.
--
-- THE PENDING/AVAILABLE FORMULA (Sections 3-4, the critical part of
-- this whole migration): naively bucketing each ledger row by its OWN
-- available_at column is WRONG the moment a refund reverses a sale that
-- has not yet settled -- migration 048's own AVAILABLE_AT SEMANTICS
-- comment already establishes that a 'refund' entry's own available_at
-- is ALWAYS immediate (= created_at), regardless of whether the sale it
-- reverses was itself still pending. A naive per-row split would then
-- count the sale's full amount as "pending" (its own available_at is
-- still in the future) while ALSO counting the refund as already
-- "available" (its own available_at is now) -- producing pending=800,
-- available=-800 for a sale reversed before it ever settled, when the
-- true economic answer is pending=0, available=0: nothing was ever
-- actually released, so there is nothing to be negative about.
--
-- The fix: a 'refund' entry is re-attributed to the SAME bucket as the
-- ORIGINAL SALE it reverses, not its own available_at. Every canonical
-- refund this schema can ever produce (record_refund(), migration 049)
-- shares its purchase_id with exactly one 'sale' entry (the partial
-- unique indexes on both entry types guarantee this 1:1 relationship) --
-- so "the sibling sale's available_at" is always well-defined and
-- looked up directly, with the refund's own available_at kept only as
-- an unreachable-in-practice defensive fallback (a refund with no
-- sibling sale should never exist given record_refund()'s own design,
-- which requires an existing sale before it will ever create one).
--
-- 'sale' entries use their own available_at (that IS the frozen
-- settlement snapshot). 'payout' and 'adjustment' entries use their own
-- available_at too, WITH ONE EXPLICIT DESIGN DECISION (Section 16, made
-- here because migration 048 only ever documented an EXPECTATION for
-- future callers, never enforced it structurally beyond 'sale' entries'
-- own NOT NULL-via-CHECK requirement): if a 'payout' or 'adjustment'
-- entry's available_at is ever NULL (schema-legal, though no RPC in
-- this codebase creates one that way today), it is treated as
-- IMMEDIATELY available (coalesced to its own created_at) -- exactly
-- the behavior migration 048's own comment already documents as the
-- expected convention for these two entry types, made an explicit,
-- tested rule here rather than left an ambiguous possibility. This
-- migration does not add a payout- or adjustment-recording RPC (both
-- remain deferred to LEDGER-1E and a future finance-admin phase
-- respectively) -- it only defines how THIS reporting function
-- interprets whatever such a future entry eventually looks like.
--
-- LEDGER-1D.1: THE ADJUSTMENT RULE, STATED ON ITS OWN (this was
-- ambiguous in LEDGER-1D's own report -- it is not an accidental SQL
-- consequence, it is a deliberate, chosen rule, restated here in full):
--
--   effective_at(adjustment) = COALESCE(available_at, created_at)
--   effective_at(adjustment) > now()  => the adjustment is PENDING
--   effective_at(adjustment) <= now() => the adjustment is AVAILABLE
--
-- This applies IDENTICALLY regardless of the adjustment's own sign --
-- a positive (credit) adjustment and a negative (debit) adjustment are
-- bucketed by the exact same rule; amount_minor's sign has no bearing on
-- which bucket a row falls into, only on how much it contributes once
-- there. A NULL available_at (schema-legal, since only 'sale' entries
-- carry a NOT NULL CHECK on this column) resolves to "immediately
-- available," matching this file's own payout convention above and
-- migration 048's own stated default for every non-sale entry type.
-- REJECTED ALTERNATIVE: always treating every adjustment as immediately
-- available regardless of its own available_at value (i.e. ignoring a
-- future-dated available_at on this one entry type). This was rejected
-- as financially UNSAFE: it would let a deliberately future-dated staff
-- credit or correction (e.g. "this credit becomes available in 30
-- days," a shape a future finance-admin adjustment RPC may well want)
-- silently show up as spendable balance today, which is a stronger
-- (wrong-direction) claim than this reporting layer should ever make on
-- its own. The COALESCE rule costs nothing in the common case (NULL
-- behaves exactly like "immediate," matching 048's documented
-- expectation) and correctly defers the rare future-dated case instead
-- of overstating available funds.
--
-- With every row's EFFECTIVE bucket timestamp resolved this way:
--   pending_minor    = sum(amount_minor) where effective bucket is in the future
--   current_balance_minor = sum(amount_minor) across every row, unconditionally
--   available_minor  = current_balance_minor - pending_minor (Section 3's own
--                      formula, restated) -- equivalently, the sum of every row
--                      whose effective bucket has already arrived.
-- This satisfies every worked case in the LEDGER-1D brief: a sale
-- reversed before its own settlement date now correctly nets to
-- pending=0/available=0/current_balance=0 (Section 4); a sale reversed
-- AFTER settlement nets to pending=0/available=0 (Section 5, the sale
-- and its refund both land in the "already released" bucket and
-- cancel); a sale that was paid out and is LATER refunded correctly
-- shows pending=0 and a NEGATIVE available/current_balance (Section 6,
-- never clamped to zero -- a real, visible payable-back position); and
-- refunding exactly one purchase within a multi-purchase bundle payment
-- only ever reverses THAT purchase's own sale credit, since every
-- amount here is scoped per purchase_id, never per payment (Section 7).
--
-- LIFETIME_REFUND_MINOR / PAID_OUT_MINOR (Section 3/17): reported as
-- POSITIVE magnitudes (the absolute value of the negative ledger
-- debits) -- "how much has been refunded"/"how much has already been
-- paid out" are naturally positive quantities to a human reader, even
-- though the underlying rows are negative by the ledger's own signed-
-- amount convention (migration 048). NET_EARNINGS_MINOR is the one
-- SIGNED sum across sale+refund+adjustment (excluding payout debits
-- entirely, per Section 3's own formula) -- payouts reduce what is
-- currently AVAILABLE, never what the author has NET EARNED historically.
-- ============================================================

create or replace function public.get_author_financial_summary()
returns table (
  currency text,
  lifetime_sale_minor bigint,
  lifetime_refund_minor bigint,
  lifetime_adjustment_minor bigint,
  net_earnings_minor bigint,
  paid_out_minor bigint,
  pending_minor bigint,
  available_minor bigint,
  current_balance_minor bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  with entries as (
    select
      ale.currency,
      ale.entry_type,
      ale.amount_minor,
      case
        when ale.entry_type = 'sale' then ale.available_at
        when ale.entry_type = 'refund' then coalesce(
          (
            select sib.available_at
            from public.author_ledger_entries sib
            where sib.purchase_id = ale.purchase_id and sib.entry_type = 'sale'
            limit 1
          ),
          ale.available_at
        )
        else coalesce(ale.available_at, ale.created_at)
      end as effective_available_at
    from public.author_ledger_entries ale
    where ale.author_id = auth.uid()
  )
  select
    currency,
    coalesce(sum(amount_minor) filter (where entry_type = 'sale'), 0)::bigint as lifetime_sale_minor,
    coalesce(-sum(amount_minor) filter (where entry_type = 'refund'), 0)::bigint as lifetime_refund_minor,
    coalesce(sum(amount_minor) filter (where entry_type = 'adjustment'), 0)::bigint as lifetime_adjustment_minor,
    coalesce(sum(amount_minor) filter (where entry_type in ('sale', 'refund', 'adjustment')), 0)::bigint as net_earnings_minor,
    coalesce(-sum(amount_minor) filter (where entry_type = 'payout'), 0)::bigint as paid_out_minor,
    coalesce(sum(amount_minor) filter (where effective_available_at > now()), 0)::bigint as pending_minor,
    (
      coalesce(sum(amount_minor), 0)
      - coalesce(sum(amount_minor) filter (where effective_available_at > now()), 0)
    )::bigint as available_minor,
    coalesce(sum(amount_minor), 0)::bigint as current_balance_minor
  from entries
  group by currency;
$$;

-- LEDGER-1D.1: explicit revoke-then-grant, matching migration 049's own
-- convention exactly (e.g. record_successful_sale()) rather than
-- relying on default PUBLIC-derived EXECUTE -- `from public, anon`
-- alone was already functionally safe here (the very next statement
-- grants authenticated EXECUTE regardless of whether it was named in
-- this revoke), but naming all three roles explicitly removes any
-- ambiguity about what this function's grant state actually is, and
-- matches how every other SECURITY DEFINER function in this schema
-- documents its own privilege boundary.
revoke all on function public.get_author_financial_summary() from public, anon, authenticated;
grant execute on function public.get_author_financial_summary() to authenticated;

-- ============================================================
-- Part 3: list_author_financial_activity() -- bounded, keyset-paginated
-- author-facing activity feed. Mirrors the exact pagination convention
-- already established by list_admin_audit_events() (migration 042) and
-- the migration-043 finance reconciliation readers: p_limit clamped to
-- [1, 100] (default 25), keyset cursor as a (created_at, id) tuple
-- compared with `<` for strict descending pagination, and the same
-- "cursor fields must both be null or both be set" validation.
--
-- SAFE FIELDS ONLY (Section 12): id, entry_type, amount_minor,
-- currency, gross_amount_minor, librum_amount_minor, royalty_rate_bps,
-- available_at, created_at, plus book_id/book_title WHEN this entry has
-- a purchase_id (sale and refund entries only -- payout/adjustment
-- entries return null book context, exactly reflecting that they are
-- not tied to one specific book sale). Never selects payment_id,
-- payment_refund_id, payout_id, reference_type, reference_id, or
-- anything from payments/purchases beyond the book's own id/title --
-- no buyer identity, no provider identifier, ever reaches this
-- function's own result set.
--
-- OWNERSHIP: identical posture to get_author_financial_summary() --
-- auth.uid() alone, no p_author_id parameter, SECURITY DEFINER for the
-- same reason (Part 1's dropped policy).
-- ============================================================

create or replace function public.list_author_financial_activity(
  p_limit integer default 25,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns table (
  id uuid,
  entry_type text,
  amount_minor bigint,
  currency text,
  gross_amount_minor bigint,
  librum_amount_minor bigint,
  royalty_rate_bps integer,
  available_at timestamptz,
  created_at timestamptz,
  book_id uuid,
  book_title text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
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
      ale.id,
      ale.entry_type,
      ale.amount_minor,
      ale.currency,
      ale.gross_amount_minor,
      ale.librum_amount_minor,
      ale.royalty_rate_bps,
      ale.available_at,
      ale.created_at,
      b.id as book_id,
      b.title as book_title
    from public.author_ledger_entries ale
    left join public.purchases pu on pu.id = ale.purchase_id
    left join public.books b on b.id = pu.book_id
    where ale.author_id = auth.uid()
      and (
        p_cursor_created_at is null
        or (ale.created_at, ale.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by ale.created_at desc, ale.id desc
    limit v_limit;
end;
$$;

-- LEDGER-1D.1: same explicit revoke-then-grant hardening as
-- get_author_financial_summary() above.
revoke all on function public.list_author_financial_activity(integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_author_financial_activity(integer, timestamptz, uuid) to authenticated;

-- ============================================================
-- Part 4: production rollout compatibility -- every object this
-- migration adds is a new function nothing existing calls, plus one RLS
-- policy DROP against a table with zero production rows and zero
-- current application readers. No existing column, constraint, grant,
-- or function is altered; migrations 048 and 049 remain byte-unchanged.
-- finance.view staff access to author_ledger_entries is completely
-- unaffected (its own policy and the underlying table grant are both
-- untouched). The current Stripe Connect flow continues to run
-- completely unaffected, and both new functions are grantable to
-- authenticated precisely because they are read-only, self-scoped via
-- auth.uid(), and expose no internal correlation identifiers.
-- ============================================================
