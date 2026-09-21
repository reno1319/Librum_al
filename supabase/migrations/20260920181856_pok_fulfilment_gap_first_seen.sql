-- POK-FULFILMENT-1: the immutable first-seen marker for transient
-- fulfilment-evidence gaps.
--
-- The defect this exists to bound. A POK callback for a COMPLETED order
-- that is missing one of four optional fields (`transactionId`,
-- `capturedAmount`, `autoCapture`, `isCanceled`) cannot verify the
-- payment, and the application reported that as "pending", which the
-- webhook route turns into a 503 -- a RETRY signal. Retrieval uses
-- `?loadTransaction=true`, so those fields can genuinely be absent on one
-- read and present on the next; retrying is the right first answer. What
-- was missing was any way to stop.
--
-- Why this cannot be `updated_at`. That column already exists and looks
-- like a free first-seen marker, and it is not one:
-- `set_pok_book_checkout_order_updated_at` is an UNCONDITIONAL before-
-- update trigger, so every callback that keeps `last_error_code` current
-- also resets it. Two transient codes alternating A -> B -> A -> B would
-- push the deadline forward on every callback and 503 forever. The only
-- way to keep the latest observation AND a stable start point is a second
-- column that nothing is allowed to move.
--
-- So the column is DATABASE-OWNED, and that is enforced rather than
-- documented: the application never names it, the transition trigger
-- stamps it exactly once from `pg_catalog.now()`, and any statement that
-- tries to supply, change or clear it RAISES. Silent coercion was
-- considered and rejected -- an UPDATE that does not name a column
-- carries OLD into NEW, so the only statement a raise can ever fire on is
-- a deliberate write to a column the application is not allowed to write.
-- That is a programming error, and it should fail loudly. This file's own
-- retirement-facts guard already raises rather than coercing.
--
-- This migration is ADDITIVE. It adds one nullable column with no
-- default, one named CHECK, and it re-creates one trigger function and
-- its trigger. It reads and mutates NO existing data row: every existing
-- row keeps a null marker, and the CHECK admits null.
--
-- Deployment order is migration FIRST, application second, and the
-- interval between them is safe by construction: the deployed old
-- application's only `last_error_code` writer is repo.reconcile with
-- 'creation_unconfirmed', which does not match the gap prefix, so the
-- stamping branch never fires until the new application is live.
--
-- Rollback: this migration is the ROLLBACK FLOOR, together with the
-- URL-based resume correction it ships with. Reverting the application
-- behaviour on top of it is safe -- the reverted application never
-- selects, writes or names this column, `select("*")` returning an extra
-- column is inert, and rows that already carry the marker simply keep it.
-- Do NOT roll the column back to recover from an application defect.
--
-- PAID_CHECKOUT_MODE and PAID_PUBLISHING_MODE remain absent everywhere.
-- Applying this migration enables nothing.

-- ============================================================
-- Part 1: the column and its named constraint.
-- ============================================================

alter table public.pok_book_checkout_orders
  add column fulfilment_gap_first_seen_at timestamptz;

comment on column public.pok_book_checkout_orders.fulfilment_gap_first_seen_at is
  'POK-FULFILMENT-1: the database time at which this mapping first recorded a transient fulfilment-evidence gap. Database-owned: set once by the transition trigger, never supplied, changed or cleared by application code. Diagnostic history, never entitlement -- book_checkout_intents.fulfilled_at is the entitlement authority.';

-- Named EXPLICITLY, following the rule this repository already states for
-- itself on book_checkout_intents: an anonymous CHECK whose expression
-- spans more than one column is auto-named <table>_check<n>, and n depends
-- on declaration order, which a database built from schema.sql and one
-- built from base + this migration do not share. The name is what lets
-- supabase/tests/060_pok_fulfilment_gap_first_seen_catalog_equivalence.sh
-- compare the two catalogs byte for byte.
--
-- The residual, stated rather than hidden: a BACKWARD database-system
-- clock adjustment between a row's creation and its first gap observation
-- would make pg_catalog.now() precede created_at, and this constraint
-- would then reject an otherwise legitimate write. That failure is
-- fail-closed -- the UPDATE raises, the route answers 503, and the
-- observation is retried -- and it is preferred to accepting a marker
-- that claims a gap was seen before the mapping existed.
alter table public.pok_book_checkout_orders
  add constraint pok_book_checkout_orders_gap_first_seen_after_created_check
  check (fulfilment_gap_first_seen_at is null
         or fulfilment_gap_first_seen_at >= created_at);

-- ============================================================
-- Part 2: the transition trigger owns the column.
--
-- The whole body is restated because `create or replace function`
-- replaces it wholesale; the retirement guards above the new block are
-- byte-identical to what they already were.
--
-- The trigger now also fires BEFORE INSERT, for one reason only: to
-- refuse an insert that supplies the marker. It stamps nothing on insert
-- -- a brand-new mapping has by definition never observed a gap.
-- ============================================================

create or replace function public.enforce_pok_book_checkout_orders_transition_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- POK-FULFILMENT-1: INSERT may not supply the database-owned marker.
  -- `old` does not exist on this path, so it returns before the
  -- retirement guards, which are UPDATE rules by construction.
  if tg_op = 'INSERT' then
    if new.fulfilment_gap_first_seen_at is not null then
      raise exception
        'pok_book_checkout_orders: fulfilment_gap_first_seen_at is database-owned (intent %)',
        new.intent_id;
    end if;
    return new;
  end if;

  if old.state = 'retired' then
    if new.state is distinct from old.state then
      raise exception
        'pok_book_checkout_orders: a retired attempt cannot leave the retired state (intent %)',
        old.intent_id;
    end if;
    if new.retired_at is distinct from old.retired_at
       or new.retired_reason is distinct from old.retired_reason then
      raise exception
        'pok_book_checkout_orders: retirement facts are immutable (intent %)',
        old.intent_id;
    end if;
  end if;

  -- POK-FULFILMENT-1: fulfilment_gap_first_seen_at is DATABASE-OWNED.
  --
  -- The branch ORDER is load-bearing. Rejection of a supplied value comes
  -- BEFORE the stamping branch, so a statement that writes both a
  -- fulfilment_gap_* error code and its own timestamp is refused rather
  -- than quietly having its timestamp replaced -- the two look identical
  -- from the row afterwards, and only one of them tells the author their
  -- write was wrong.
  --
  -- Concurrent first observations converge without any of this raising:
  -- the second writer blocks on the row lock, re-evaluates against the
  -- committed version where the marker is already non-null, and -- since
  -- its UPDATE does not name the column, so NEW carries OLD -- takes the
  -- first branch with nothing distinct, preserving the first writer's
  -- value.
  if old.fulfilment_gap_first_seen_at is not null then
    if new.fulfilment_gap_first_seen_at is distinct from old.fulfilment_gap_first_seen_at then
      raise exception
        'pok_book_checkout_orders: fulfilment_gap_first_seen_at is immutable (intent %)',
        old.intent_id;
    end if;
  elsif new.fulfilment_gap_first_seen_at is not null then
    raise exception
      'pok_book_checkout_orders: fulfilment_gap_first_seen_at is database-owned (intent %)',
      old.intent_id;
  elsif new.last_error_code like 'fulfilment\_gap\_%'
        and new.state in ('ready', 'needs_reconciliation') then
    -- `\_` is a LITERAL underscore: backslash is LIKE's default escape
    -- character, and an unescaped `_` is a single-character wildcard that
    -- would also match, say, 'fulfilment5gap9...'. The prefix split is
    -- the whole mechanism by which a TERMINAL observation
    -- (fulfilment_blocked_*) can never create this marker, and
    -- 'creation_unconfirmed' -- the only last_error_code any earlier
    -- release writes -- matches neither.
    --
    -- The state condition is about the RESULTING row, not about which
    -- row the statement started from, and it is worth stating exactly
    -- what that does and does not guarantee.
    --
    -- What it guarantees: a row whose resulting state is still
    -- 'creating', or is 'retired', is never stamped. A retired row
    -- additionally cannot leave 'retired' at all -- the retirement guard
    -- above rejects any such update before this branch is reached.
    --
    -- What it does NOT guarantee: a hypothetical statement that moved a
    -- mapping from 'creating' to 'ready' or 'needs_reconciliation' while
    -- carrying a fulfilment_gap_* code WOULD stamp the marker, because
    -- the resulting row satisfies every condition. No such statement
    -- exists in the application: the only writer of a fulfilment_gap_*
    -- code is recordFulfilmentObservation, whose compare-and-set admits
    -- only rows already in 'ready' or 'needs_reconciliation', so it
    -- matches no 'creating' row and cannot be the statement that moves
    -- one. supabase/tests/059 pins both halves -- the transition that
    -- would stamp, and the CAS that never produces it.
    --
    -- A null last_error_code makes the LIKE comparison UNKNOWN, which is
    -- not true, so it falls through and the marker stays null.
    new.fulfilment_gap_first_seen_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

drop trigger if exists pok_book_checkout_orders_enforce_transition_rules
  on public.pok_book_checkout_orders;

create trigger pok_book_checkout_orders_enforce_transition_rules
  before insert or update on public.pok_book_checkout_orders
  for each row
  execute function public.enforce_pok_book_checkout_orders_transition_rules();

-- Re-issued verbatim so that this file and supabase/schema.sql leave the
-- function with a textually identical ACL. `create or replace function`
-- preserves the existing one, so against an already-migrated database
-- this is a no-op; it exists so the two build paths cannot diverge.
revoke all on function public.enforce_pok_book_checkout_orders_transition_rules()
  from public, anon, authenticated;
