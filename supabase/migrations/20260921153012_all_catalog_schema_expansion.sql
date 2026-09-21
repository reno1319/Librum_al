-- ALL-CATALOG-1: the additive, ALL-only catalog price and discount
-- fields.
--
-- WHAT THIS IS. Phase 3 of the ALL/POK cutover sequence in ROADMAP.md:
-- new, nullable, ALL-only columns alongside the untouched legacy
-- `price_cents` / `amount_off_cents` fields. It adds three columns and
-- four named CHECK constraints, and it replaces one anonymous CHECK with
-- a named three-way equivalent. It reads and mutates NO existing data
-- row.
--
-- WHY THE COLUMNS ARE NEW RATHER THAN A REINTERPRETATION. `price_cents`
-- is a USD minor-unit field, proven so by the checkout code that wrote
-- it (regime `legacy_stripe_connect_v1` hardcodes `"usd"`). ROADMAP.md's
-- decision record forbids relabelling, scaling, converting or inferring
-- any existing `price_cents` value as ALL. A separate column is the only
-- representation in which "this row has no ALL price yet" is
-- expressible, and every existing row is exactly that: null.
--
-- THE UNIT, stated once so it is never guessed. `price_all` and
-- `amount_off_all` hold WHOLE ALL -- `99` means ninety-nine lek, never
-- 0.99 ALL and never 9,900 of anything. They are CATALOG fields, and
-- the catalog domain is whole lek by product decision.
--
-- HOW THAT RELATES TO THE MONEY THAT ACTUALLY MOVES. Transaction
-- accounting in this schema is, and stays, INTEGER MINOR UNITS, 100
-- minor units to one ALL: 99.00 ALL is 9900, and 179.10 ALL is 17910.
-- Payments, refunds, author-ledger entries and payouts keep using that
-- existing integer minor-unit model (normally `bigint`). This migration
-- introduces NO second persistent financial representation and proposes
-- none: a `numeric` may appear as an intermediate in a calculation where
-- one is genuinely needed, never as a stored money column beside the
-- minor-unit ledger. Two persistent representations of the same money
-- can disagree, and nothing then says which one is the amount owed.
--
-- A catalog value is therefore not a ledger value: `price_all = 99` is
-- the same money as a ledger amount of `9900`, written in the unit each
-- layer is defined in. Any calculation that lands below one whole minor
-- unit -- a percentage share, a split, an allocation -- needs an
-- explicit deterministic rounding or allocation rule decided BEFORE the
-- result is persisted, so that the same inputs always produce the same
-- stored integers. That rule is Phase 6 work; this migration
-- neither contains nor presumes one.
--
-- THE DOMAIN, and why `0` is separate from the 99..100000 band.
-- `0` is an explicit, author-chosen free price that bypasses POK
-- entirely; it is not "cheap". Every other valid price is at least 99
-- ALL, which is the paid floor. There is no valid value in 1..98: such
-- a row could never be charged, because a paid checkout's final price
-- must be at least 99.00 ALL (9900 minor units). Admitting one would
-- create a book that is neither free nor sellable, which is precisely
-- the state this CHECK exists to make unrepresentable. The 100,000 ALL
-- ceiling is the product decision recorded in ROADMAP.md.
--
-- WHY `amount_off_all` starts at 1 and not 0. A zero fixed discount is
-- not a discount; it is a discount code that does nothing, which is
-- indistinguishable at checkout from a code that failed to apply. A
-- discount can also never be the mechanism that makes a paid book free
-- -- only an explicit catalog price of zero is free -- so the absence
-- of 0 from this domain is a product invariant, not an oversight. This
-- constraint bounds the STORED discount only; whether a given code
-- yields a legal final price for a given book is a checkout-time
-- decision, and an invalid combination is REJECTED there, never clamped
-- to the floor.
--
-- WHY THE DISCOUNT XOR IS REPLACED RATHER THAN ADDED TO. The existing
-- constraint is `(percent_off is null) <> (amount_off_cents is null)`:
-- an exclusive-or over exactly two columns. Leaving it in place and
-- adding a second constraint for the third column cannot express
-- "exactly one of three" -- the old constraint would still demand one
-- of the two legacy columns, making an ALL-only discount code
-- unrepresentable. `num_nonnulls(...) = 1` states the real invariant in
-- one place. It is named explicitly, because the constraint it replaces
-- was auto-named `discount_codes_check` from its declaration order, and
-- declaration order is exactly what the two build paths (schema.sql and
-- migrations) do not share.
--
-- WHY THE GUARD RUNS FIRST, BEFORE ANY `alter table`. The replacement is
-- GUARDED rather than `drop ... if exists`: this migration refuses to
-- run unless the constraint it expects to remove is present with the
-- definition it expects. A `drop if exists` that silently matched
-- nothing would leave a database with no exactly-one-discount invariant
-- at all and report success.
--
-- The guard is the FIRST statement in the file, ahead of every DDL
-- statement, so that a refusal leaves the database structurally
-- untouched even when this file is applied statement-by-statement --
-- psql without `--single-transaction`, a console that sends one
-- statement at a time, a tool that splits on semicolons. With the guard
-- last, such a run would have already added three columns, four
-- constraints and three comments before refusing, and the operator would
-- be left reconciling a half-applied migration by hand.
--
-- That is a SECOND line of defence, not a replacement for the first.
-- The real rollout requirement is unchanged and is not relaxed by this
-- reordering: apply this file in a SINGLE TRANSACTION (`supabase db
-- push`, or `psql --single-transaction -v ON_ERROR_STOP=1`). The guard
-- protects only against a failure at the guard itself; a failure at any
-- later statement -- a constraint that will not validate, a lost
-- connection between two `alter table`s -- still leaves a partial schema
-- unless the whole file is one transaction.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO:
--   * no DEFAULT on any new column -- a default would write a value
--     into rows that have no authored ALL price, which is the inference
--     the decision record forbids;
--   * no BACKFILL, for the same reason. Every existing row keeps null;
--   * no INDEX. No query reads these columns in this phase, and an
--     index on a wholly-null column earns nothing;
--   * no `currency_code` column. `price_all` and `amount_off_all` are
--     ALL-only by name; a second mutable currency fact could disagree
--     with them, and the only way to resolve that disagreement is to
--     trust one of two sources that were supposed to be one;
--   * no change to RLS, policies, grants, ownership or privileges;
--   * no change to any function, trigger or RPC. Nothing reads these
--     columns yet. Phase 4 wires them.
--
-- ROLLBACK. Dropping the three columns restores the previous shape, but
-- the discount XOR must be restored with it, in the same transaction,
-- or `discount_codes` is left with no exactly-one invariant.
--
-- PAID_CHECKOUT_MODE and PAID_PUBLISHING_MODE are neither read nor set
-- by this migration. Applying it alone enables no checkout and charges
-- nobody.

-- ============================================================
-- Part 1: the guard. FIRST, before any DDL.
--
-- If the expected constraint is absent, or present with a different
-- definition, this migration stops having changed NOTHING: no column,
-- no constraint, no comment. A database whose discount invariant is not
-- the one this migration was written against is a database whose
-- invariant this migration is not entitled to replace.
-- ============================================================

do $$
declare
  v_def text;
begin
  select pg_catalog.pg_get_constraintdef(con.oid)
    into v_def
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'discount_codes'
     and con.conname = 'discount_codes_check'
     and con.contype = 'c';

  if v_def is null then
    raise exception
      'ALL-CATALOG-1: public.discount_codes has no constraint named discount_codes_check -- refusing to replace a discount invariant this migration cannot find';
  end if;

  if v_def <> 'CHECK (((percent_off IS NULL) <> (amount_off_cents IS NULL)))' then
    raise exception
      'ALL-CATALOG-1: public.discount_codes.discount_codes_check is %, not the two-column exclusive-or this migration was written to replace -- refusing to drop it',
      v_def;
  end if;
end $$;

-- ============================================================
-- Part 2: the catalog price columns.
-- ============================================================

alter table public.books
  add column price_all integer
    constraint books_price_all_range_check
    check (price_all is null or price_all = 0
           or (price_all >= 99 and price_all <= 100000));

comment on column public.books.price_all is
  'Catalog price in WHOLE ALL (99 = ninety-nine lek), or null for a row with no authored ALL price. 0 means explicitly free and bypasses POK; every other valid value is 99..100000. Never derived from price_cents, which is legacy USD minor units. Transaction accounting stays in integer minor units, 100 per ALL.';

alter table public.bundles
  add column price_all integer
    constraint bundles_price_all_range_check
    check (price_all is null or price_all = 0
           or (price_all >= 99 and price_all <= 100000));

comment on column public.bundles.price_all is
  'Catalog price in WHOLE ALL (99 = ninety-nine lek), or null for a row with no authored ALL price. 0 means explicitly free and bypasses POK; every other valid value is 99..100000. Never derived from price_cents, which is legacy USD minor units. Transaction accounting stays in integer minor units, 100 per ALL.';

-- ============================================================
-- Part 3: the fixed-ALL discount column.
-- ============================================================

alter table public.discount_codes
  add column amount_off_all integer
    constraint discount_codes_amount_off_all_range_check
    check (amount_off_all is null
           or (amount_off_all >= 1 and amount_off_all <= 100000));

comment on column public.discount_codes.amount_off_all is
  'Fixed discount in WHOLE ALL (1..100000), or null. Whether a code yields a legal final price for a given book is decided at checkout and rejected there when it does not -- never clamped.';

-- ============================================================
-- Part 4: exactly one discount type, over three columns.
--
-- The guard in Part 1 has already established that the constraint
-- dropped here is the one this migration expects, which is why the drop
-- carries no `if exists`.
-- ============================================================

alter table public.discount_codes
  drop constraint discount_codes_check;

alter table public.discount_codes
  add constraint discount_codes_exactly_one_discount_type_check
  check (num_nonnulls(percent_off, amount_off_cents, amount_off_all) = 1);
