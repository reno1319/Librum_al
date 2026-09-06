-- LIBRUM 2.0 LEDGER-1B: provider-neutral financial ledger foundation --
-- SCHEMA AND INVARIANTS ONLY. This migration creates five new tables
-- (payments, payment_events, author_payouts, author_payout_settings,
-- author_ledger_entries) and changes NOTHING about existing checkout,
-- webhook, refund, dispute, or payout behavior. No existing table is
-- altered. No existing RLS policy, grant, or function is touched. Every
-- new table starts completely unwritten -- nothing in this migration
-- (or anywhere else yet) INSERTs a single row into any of them. See the
-- LEDGER-1A audit (read-only, prior pass) for the full current-state
-- analysis this design is based on.
--
-- LEDGER-1B's OWN EXPLICIT BUSINESS CLARIFICATION (binding for this
-- migration): every existing purchases/refund_requests/payment_disputes
-- row in this database is a SYNTHETIC PRE-LAUNCH TEST TRANSACTION. There
-- are no real buyers, no real author liabilities, and nothing to
-- reconstruct from Stripe's own historical transfers. This migration
-- therefore creates ZERO historical author_ledger_entries, ZERO
-- payments, and ZERO author_payouts from existing data -- there is no
-- backfill migration statement anywhere in this file, deliberately. The
-- new ledger starts at financial zero; real commerce (and the first
-- real ledger row) begins only once LEDGER-1C wires actual sale/refund
-- recording into the checkout/webhook flow. A separate, later,
-- independently-reviewed PRE-LAUNCH TEST-DATA CLEANUP task will remove
-- the synthetic transactions themselves -- not this one.
--
-- ORDERING INVARIANT (same discipline every prior migration in this
-- series already establishes): every function/table this file
-- references must already be defined earlier in this same file, or in
-- an earlier, already-applied migration. profiles, purchases, and
-- staff_has_permission('finance.view') (migration 043) all already
-- exist. Migrations 002 through 047 are immutable (already
-- production-applied) and are not modified by this file in any way.

-- ============================================================
-- Part 1: payments -- provider-neutral record of "did Librum actually
-- receive the buyer's money." Deliberately does NOT replace
-- purchases.stripe_payment_intent_id/stripe_checkout_session_id in this
-- migration -- see this file's own Part 6 comment for why linking
-- purchases to this table is explicitly DEFERRED to LEDGER-1C, not
-- built here.
--
-- provider/provider_payment_id are plain open text, not an enum or a
-- fixed CHECK allow-list of known providers -- LEDGER-1A's own
-- provider-neutrality finding (Section 30/31) is that a future buyer
-- rail (Paysera, Pago, a bank acquirer, PayPal) must never require a
-- schema migration merely to be named here. unique(provider,
-- provider_payment_id) is the core cross-provider idempotency
-- invariant: the same provider can never be told about the same
-- payment twice under two different local rows.
--
-- amount_minor: integer minor units (named "_minor", not "_cents" --
-- LEDGER-1A's own W/25 finding: a future currency whose minor unit
-- isn't called "cents" must never force a rename). bigint, not
-- integer -- purchases.amount_cents is `integer` (max ~21.4M units),
-- which is fine for a single per-book price but this table may one day
-- aggregate a large multi-item payment; bigint costs nothing and avoids
-- ever needing to widen it later.
--
-- currency: bounded uppercase ISO-4217-shaped text, not a full
-- currency-code lookup table -- V1 has exactly one real currency (USD,
-- hardcoded today in src/lib/pricing.ts and every Stripe Checkout call)
-- and no FX conversion is being built; the CHECK below only rejects
-- obviously malformed values, it does not validate against a real
-- ISO-4217 list (deliberately -- see this table's own currency
-- reasoning in the LEDGER-1A report, Section W: "do not implement FX
-- conversion" / "avoid premature FX architecture").
--
-- status: six provider-neutral states, matching LEDGER-1B's own brief
-- verbatim. partially_refunded is kept even though Librum's current
-- Stripe refund policy is deliberately full-charge-only (see
-- issue-refund.ts's own "no partial-refund product concept anywhere"
-- comment) -- this table describes what a PROVIDER can report, not what
-- Librum's product currently allows; a future provider or a future
-- product change could report a partial refund without ever needing a
-- schema change here. This is a bounded, closed CHECK allow-list (not a
-- Postgres ENUM type) so adding a future status is a plain, in-
-- transaction ALTER TABLE, matching payment_disputes.status's own
-- deliberate no-enum precedent elsewhere in this schema.
--
-- buyer_id references profiles, not auth.users directly -- every other
-- financial/audit table in this schema (purchases.reader_id,
-- refund_requests.reader_id, bundle_checkout_snapshots.reader_id) does
-- the same. ON DELETE SET NULL, not RESTRICT: a payment is a buyer-side
-- audit record, not the author's own payable ledger -- LEDGER-1A's own
-- R/25 finding is that deleting the BUYER's account must not be blocked
-- by, or destroy, the historical fact that a payment was once made,
-- exactly the same posture purchases.reader_id already takes (migration
-- 038's own "financial/audit record: deleting the owning profile must
-- not silently delete the record... only detach it").
-- ============================================================

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_payment_id text not null,
  buyer_id uuid references public.profiles(id) on delete set null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'partially_refunded', 'refunded')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_payment_id)
);

create index payments_buyer_id_created_at_idx on public.payments (buyer_id, created_at desc);

alter table public.payments enable row level security;

-- LEDGER-1A/1B Section 27: no current reader-facing "my payments" UI
-- exists anywhere in the product (the reader-facing purchase/receipt
-- history at /account/purchases reads purchases/bundle_checkout_
-- snapshots, never a payments table). Exposing authenticated SELECT
-- here now, before any real UI needs it, would be broadening access
-- pre-emptively -- explicitly what LEDGER-1B's own brief warns against
-- ("Do not broaden access prematurely"). Deliberately: no buyer-facing
-- SELECT policy at all in this migration. Only staff with finance.view
-- (the exact permission migration 043 already introduced for
-- reconciliation reads, granted to owner/admin only) may read this
-- table, and only through the standard doubly-enforced pattern this
-- schema already uses everywhere else -- revoke the ambient table-level
-- grant outright, then hand SELECT back narrowly, with RLS as the
-- second, independent layer.
revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

create policy "Staff with finance.view can view all payments"
  on public.payments for select
  using (public.staff_has_permission('finance.view'));

-- No INSERT/UPDATE/DELETE policy for authenticated/anon anywhere in
-- this file, for any of the five new tables -- combined with the
-- revoke-all above (which removes the ambient privilege those commands
-- would otherwise need in the first place), this is the same "doubly
-- enforced: no grant AND no policy" posture refund_requests/purchases
-- already establish. Every write to every table in this migration is
-- reserved for the service-role webhook/RPC layer LEDGER-1C will add --
-- nothing here creates a write path yet, deliberately (see this file's
-- own Part 6/8 comments).

-- ============================================================
-- Part 2: payment_events -- the durable EVENT-INGESTION idempotency
-- boundary the LEDGER-1A audit found completely missing today (every
-- Stripe event.id reference in the current webhook is inside a
-- console.error/log call, never a database column -- see LEDGER-1A
-- Section J). unique(provider, provider_event_id) is that missing
-- guarantee: the same provider can never be told the same event id was
-- ingested twice as two separate local rows, independent of whether the
-- OPERATION that event triggers also happens to be independently
-- idempotent (which today's webhook is, but only by construction, not
-- by a durable ingestion-level guarantee).
--
-- Deliberately holds NO raw provider payload -- see LEDGER-1A Section O
-- and this migration's own brief, Section 7: a full Stripe event body
-- can carry buyer PII (email, sometimes address) with no operational
-- upside, since every field fulfillment actually needs is already
-- normalized into purchases/payments/author_ledger_entries elsewhere.
-- event_type/status/last_error_code are enough to answer "what did the
-- provider tell Librum, and what happened when Librum tried to process
-- it" without ever becoming a PII dumping ground.
-- ============================================================

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  status text not null default 'received'
    check (status in ('received', 'processed', 'failed', 'ignored')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

alter table public.payment_events enable row level security;

-- LEDGER-1B Section 28: no anon, no ordinary authenticated, no author
-- access at all -- only staff finance.view. This table can carry
-- integration-level detail (event types, provider error codes) that has
-- no reason to ever reach a buyer, reader, or author client.
revoke all on public.payment_events from anon, authenticated;
grant select on public.payment_events to authenticated;

create policy "Staff with finance.view can view all payment events"
  on public.payment_events for select
  using (public.staff_has_permission('finance.view'));

-- ============================================================
-- Part 3: author_payouts -- "what money is Librum paying/has paid the
-- author," independent of any buyer-side payment provider (LEDGER-1A
-- Section Q/31: payout rail may differ entirely from the buyer's own
-- payment provider -- Paysera, bank transfer, PayPal, anything -- and
-- must never be assumed equal to it). Defined BEFORE author_ledger_
-- entries in this file purely so author_ledger_entries.payout_id can
-- reference it without a forward declaration.
--
-- author_id references profiles ON DELETE RESTRICT, not SET NULL/
-- CASCADE -- see this migration's own extended Part 5 comment
-- (author_ledger_entries) for the full account-deletion-durability
-- reasoning, which applies identically here: a payout record is
-- permanent proof Librum sent an author real money, and must never be
-- capable of silently disappearing merely because that author's account
-- is later deleted.
--
-- Deliberately NO cross-column CHECK tying paid_at/failed_at to the
-- current `status` value (e.g. "paid_at is null unless status =
-- 'paid'") -- LEDGER-1B's own Section 20 explicitly warns against a
-- CHECK constraint rigid enough to make legitimate operational recovery
-- (e.g. a payout marked 'paid' that a bank later reports as bounced,
-- needing to become 'failed' while paid_at still correctly records when
-- it was first marked paid) impossible. State-transition correctness is
-- deferred to the RPC layer LEDGER-1E will add, not enforced here by a
-- brittle schema constraint.
-- ============================================================

create table public.author_payouts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  provider text,
  provider_reference text,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now(),
  processing_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  failure_code text,

  check (period_start is null or period_end is null or period_end >= period_start)
);

create index author_payouts_author_currency_created_idx
  on public.author_payouts (author_id, currency, created_at desc);
create index author_payouts_status_created_idx
  on public.author_payouts (status, created_at);

alter table public.author_payouts enable row level security;

revoke all on public.author_payouts from anon, authenticated;
grant select on public.author_payouts to authenticated;

create policy "Authors can view their own payouts"
  on public.author_payouts for select
  using (auth.uid() = author_id);

create policy "Staff with finance.view can view all payouts"
  on public.author_payouts for select
  using (public.staff_has_permission('finance.view'));

-- ============================================================
-- Part 4: author_payout_settings -- author payout PREFERENCES only
-- (threshold + currency). Deliberately its own table, never columns on
-- profiles -- profiles is already a public-facing, explicitly locked-
-- down table (migration 046, "profiles privacy lockdown") with a
-- completely different trust boundary than payout preferences.
--
-- Explicitly holds NO bank account numbers, no PayPal email, no
-- provider secrets, no KYC data, per this migration's own Section 22 --
-- this is a preferences row, not a credentials vault; if a future rail
-- ever needs a real secret, it belongs in a service-role-only table or
-- the provider's own vault, referenced by an opaque id, never here.
--
-- threshold_minor > 0 only -- no fixed minimum (not "50 euros" or any
-- other literal) is encoded in this schema, per this migration's own
-- Section 22/49B: the product/business layer decides minimum allowed
-- thresholds later; the database only rejects a nonsensical non-
-- positive value.
--
-- author_id ON DELETE CASCADE (the one new table in this migration that
-- does NOT use RESTRICT) -- this row holds no financial HISTORY at all,
-- only a preference that stops meaning anything once its owning account
-- is gone. Contrast with author_ledger_entries/author_payouts below,
-- both of which hold real financial history and both of which use
-- RESTRICT for exactly that reason.
-- ============================================================

create table public.author_payout_settings (
  author_id uuid primary key references public.profiles(id) on delete cascade,
  threshold_minor bigint not null check (threshold_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.author_payout_settings enable row level security;

revoke all on public.author_payout_settings from anon, authenticated;
grant select on public.author_payout_settings to authenticated;

create policy "Authors can view their own payout settings"
  on public.author_payout_settings for select
  using (auth.uid() = author_id);

-- LEDGER-1B Section 30: "prefer no direct write unless an existing safe
-- pattern justifies it" -- none does yet (there is no UI to set a
-- threshold, and no default-row-per-author insert path either). No
-- INSERT/UPDATE policy is added for authenticated here; a future
-- author-facing "set my payout threshold" feature gets a narrow,
-- validated Server Action/RPC in that same later phase, not a raw
-- client-side UPDATE grant added speculatively now.

-- ============================================================
-- Part 5: author_ledger_entries -- THE append-only royalty/payable
-- ledger. Answers exactly one question per row: "what single economic
-- event changed what Librum owes this author, by how much, and why."
--
-- ACCOUNT-DELETION DURABILITY (LEDGER-1B Section 24/43, analyzed in
-- full): public.profiles.id references auth.users(id) ON DELETE
-- CASCADE (see this schema's own profiles table definition) -- deleting
-- the auth.users row already cascades to delete the profiles row today.
-- author_id here is NOT NULL (a ledger entry with no owner is
-- meaningless) and references profiles(id) ON DELETE RESTRICT, not SET
-- NULL or CASCADE:
--   - CASCADE would let deleting an account silently destroy financial
--     history -- explicitly forbidden by LEDGER-1A's own accounting
--     boundary finding and this migration's own Section 24.
--   - SET NULL is not usable at all: author_id is NOT NULL, and an
--     orphaned (ownerless) row would be a WORSE outcome for a payable
--     ledger than blocking the delete -- Librum must always be able to
--     say precisely who a ledger row's money belongs/belonged to.
--   - RESTRICT is therefore the only safe choice, and it is not a new
--     restriction in practice: purchases.book_id already uses exactly
--     this ON DELETE RESTRICT reasoning ("a book with any acquisition
--     history must never be deletable," migration 023), and deleteAccount()
--     (src/app/account/actions.ts) already independently blocks account
--     deletion at the APPLICATION layer for any author with acquisition
--     history via a purchases-count check, before it ever calls
--     admin.auth.admin.deleteUser(). Since every ledger entry LEDGER-1C
--     will ever create is itself derived from a real purchase (or a
--     staff-issued adjustment), an author with ledger history already
--     has -- in every case the current application code produces --
--     acquisition history too, so this RESTRICT is a database-level
--     backstop for an invariant the application already enforces, not a
--     new conflict with it.
--   - KNOWN, DOCUMENTED, NON-BLOCKING GAP for a later phase: an author
--     who somehow holds a ledger entry with NO corresponding purchase
--     (e.g. a hypothetical goodwill 'adjustment' credit) would, under
--     this RESTRICT, have their account-deletion attempt fail at the
--     database layer with a foreign-key-violation, distinct from
--     deleteAccount()'s own existing purchases-based pre-check --
--     deleteAccount() would still fail SAFELY (no partial deletion, a
--     generic "something went wrong" message, exactly its existing
--     behavior for any other unexpected deleteUser() error), just
--     without the SPECIFIC, friendlier message the purchases pre-check
--     already gives for the acquisition-history case. This migration
--     creates zero rows (see this file's own top-of-file comment), so
--     the gap cannot be reached today; teaching deleteAccount() to also
--     recognize and name this specific case is deferred to LEDGER-1C or
--     later, per this migration's own Section 51 scope boundary (do not
--     touch account/dashboard behavior in LEDGER-1B).
--
-- purchase_id/payment_id/payout_id are all nullable, ON DELETE SET NULL
-- -- a ledger row is an audit record in its own right and must survive
-- even if the row it points at is later removed by some future,
-- currently-nonexistent process; amount_minor/currency/entry_type/
-- created_at alone already make each row self-describing.
--
-- SIGNED-AMOUNT INVARIANTS (Section 11): sale is always positive,
-- refund and payout always negative, adjustment always nonzero (either
-- sign) -- and amount_minor <> 0 unconditionally, since a zero-amount
-- ledger entry is never a real economic event. These CHECKs are scoped
-- per entry_type so a FUTURE entry_type (chargeback, tax_withholding,
-- ...) added later by a simple ALTER TABLE ... DROP/ADD CONSTRAINT on
-- the entry_type allow-list is never blocked by an unrelated sign rule
-- written for today's four types only.
--
-- SALE MUST REFERENCE A PURCHASE: a 'sale' entry with no purchase_id
-- would be a royalty credit for nothing Librum's own records show was
-- ever bought -- checked explicitly, not left to convention.
--
-- SALE SNAPSHOT COMPLETENESS (Section 10, tightened by LEDGER-1B.1's own
-- pre-commit correction): a 'sale' entry whose economic snapshot is
-- entirely NULL was found to be too weak -- it would let a future,
-- incorrectly-written sale-recording RPC insert a royalty credit with no
-- reconstructable history at all. For entry_type = 'sale', every
-- snapshot field is now REQUIRED, not merely reconciled when present:
-- purchase_id, gross_amount_minor (> 0), librum_amount_minor (>= 0), and
-- royalty_rate_bps must all be NOT NULL, and gross_amount_minor must
-- equal amount_minor + librum_amount_minor exactly (no escape hatch for
-- "not populated yet" -- since LEDGER-1B creates zero rows, this cannot
-- break anything today, and it means LEDGER-1C's sale-recording RPC
-- structurally cannot insert an incomplete sale). The columns themselves
-- remain nullable at the column level (refund/payout/adjustment entries
-- never populate them) -- only the entry_type = 'sale' CHECKs require
-- them. available_at is also required NOT NULL for a 'sale' entry (see
-- its own semantics note below) -- LEDGER-1B.1 was explicit that this
-- must NOT be paired with a hardcoded settlement delay; the RPC that
-- computes it decides the delay, this migration only requires that it be
-- SET.
--
-- Deliberately NOT required: exact royalty-percentage arithmetic
-- tying gross_amount_minor/librum_amount_minor back to royalty_rate_bps
-- itself (e.g. librum_amount_minor = round(gross_amount_minor *
-- royalty_rate_bps / 10000)) -- LEDGER-1B.1 explicitly rejected this as
-- too brittle against minor-unit rounding; royalty_rate_bps is recorded
-- as the historical rate that was in effect, not re-derived arithmetic
-- that must reconcile to the cent/minor-unit.
--
-- Non-sale entry types are NOT required to populate any of these fields
-- -- refund/payout/adjustment entries have no snapshot economics of
-- their own to record here.
--
-- royalty_rate_bps uses basis points (0-10000, i.e. 80% = 8000) --
-- LEDGER-1A/1B's own explicit fix for the single biggest defect the
-- audit found: PLATFORM_FEE_PERCENT (src/lib/pricing.ts) is a live,
-- global constant today, so every historical sale's displayed earnings
-- silently changes if that constant ever changes. Once LEDGER-1C
-- starts snapshotting this column at sale time, that is no longer true
-- for any NEW sale -- this migration does not and cannot retroactively
-- fix it for the ledger's own zero rows, since there are none yet.
--
-- IDEMPOTENCY (Sections 12-14): three partial unique indexes, one per
-- entry type that must never be double-recorded from the same external
-- event:
--   - at most one 'sale' entry per purchase_id
--   - at most one 'payout' entry per payout_id
--   - at most one entry per (author_id, entry_type, reference_type,
--     reference_id) whenever both reference columns are populated --
--     the general mechanism LEDGER-1C's refund recording is expected to
--     use, keyed on the external provider's own refund/dispute id
--     (e.g. reference_type = 'stripe_refund', reference_id =
--     refund.id), so the same external event can never produce two
--     local debits.
-- None of this relies on application-level checking alone, per this
-- migration's own explicit instruction.
--
-- AVAILABLE_AT SEMANTICS (Section 16): this migration requires only that
-- a 'sale' entry's available_at be SET (see the sale snapshot
-- completeness CHECKs above) -- it does not and cannot enforce the
-- actual VALUE, since that depends on a settlement delay this migration
-- deliberately does not hardcode. For a 'sale' entry, LEDGER-1C is
-- expected to snapshot available_at = created_at + <the settlement delay
-- in effect at sale time> -- no delay length is hardcoded anywhere in this
-- migration or this schema, deliberately (Section 16/18/49D/49E). For
-- 'refund', 'payout', and 'adjustment' entries, available_at is
-- expected to be set equal to created_at (i.e. immediately available) --
-- these are debits that must reduce an author's available balance the
-- instant they are recorded, never held pending, regardless of whether
-- the sale(s) they offset had already individually become available.
-- ============================================================

create table public.author_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  payout_id uuid references public.author_payouts(id) on delete set null,

  entry_type text not null check (entry_type in ('sale', 'refund', 'adjustment', 'payout')),

  amount_minor bigint not null check (amount_minor <> 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),

  -- Sale-time snapshot fields -- see this table's own top-of-file
  -- comment. All nullable; LEDGER-1C is expected to always populate all
  -- three together for a 'sale' entry.
  royalty_rate_bps integer check (royalty_rate_bps is null or (royalty_rate_bps >= 0 and royalty_rate_bps <= 10000)),
  gross_amount_minor bigint check (gross_amount_minor is null or gross_amount_minor > 0),
  librum_amount_minor bigint check (librum_amount_minor is null or librum_amount_minor >= 0),

  available_at timestamptz,

  -- External/idempotency correlation -- see the reference-based unique
  -- index below. Deliberately plain text, not a foreign key: the
  -- referenced object (e.g. a Stripe refund) has no local table of its
  -- own in this schema.
  reference_type text,
  reference_id text,

  -- Author-facing free text. LEDGER-1B Section 46: must be safe,
  -- human-readable copy if ever rendered directly to an author (e.g.
  -- "Refund: <book title>") -- NEVER a raw provider error string, a
  -- provider id, or any buyer-identifying detail. This migration writes
  -- no rows and therefore enforces nothing about its content beyond
  -- this documented contract for whichever future RPC populates it.
  description text,

  created_at timestamptz not null default now(),

  check (entry_type <> 'sale' or amount_minor > 0),
  check (entry_type <> 'refund' or amount_minor < 0),
  check (entry_type <> 'payout' or amount_minor < 0),
  -- adjustment may be either sign -- already covered by the
  -- unconditional amount_minor <> 0 column check above; no extra
  -- adjustment-specific CHECK is needed beyond that.

  check (entry_type <> 'sale' or purchase_id is not null),
  check (entry_type <> 'payout' or payout_id is not null),

  -- Sale snapshot completeness (LEDGER-1B.1): a 'sale' entry must carry
  -- its full economic snapshot -- not merely reconcile it when present.
  -- See this table's own top-of-file comment for the full rationale.
  check (entry_type <> 'sale' or gross_amount_minor is not null),
  check (entry_type <> 'sale' or gross_amount_minor > 0),
  check (entry_type <> 'sale' or librum_amount_minor is not null),
  check (entry_type <> 'sale' or librum_amount_minor >= 0),
  check (entry_type <> 'sale' or royalty_rate_bps is not null),
  check (entry_type <> 'sale' or available_at is not null),

  check (
    entry_type <> 'sale'
    or gross_amount_minor = amount_minor + librum_amount_minor
  )
);

-- Sale idempotency (Section 12): a purchase can have exactly one
-- canonical sale credit, ever.
create unique index author_ledger_entries_one_sale_per_purchase_idx
  on public.author_ledger_entries (purchase_id)
  where entry_type = 'sale';

-- Payout idempotency (Section 14): a committed payout can have exactly
-- one corresponding ledger debit, ever.
create unique index author_ledger_entries_one_entry_per_payout_idx
  on public.author_ledger_entries (payout_id)
  where entry_type = 'payout';

-- General external-reference idempotency (Section 13) -- the mechanism
-- LEDGER-1C's refund recording (and any other externally-triggered
-- entry type added later) is expected to rely on. Scoped to (author_id,
-- entry_type, reference_type, reference_id) exactly as this migration's
-- own brief specifies, only when both reference columns are populated --
-- an ordinary staff adjustment with no external reference at all is
-- never constrained by this index.
create unique index author_ledger_entries_reference_idempotency_idx
  on public.author_ledger_entries (author_id, entry_type, reference_type, reference_id)
  where reference_type is not null and reference_id is not null;

create index author_ledger_entries_author_currency_created_idx
  on public.author_ledger_entries (author_id, currency, created_at desc);
create index author_ledger_entries_author_currency_available_idx
  on public.author_ledger_entries (author_id, currency, available_at);

alter table public.author_ledger_entries enable row level security;

-- LEDGER-1B Section 15/44 -- APPEND-ONLY ENFORCEMENT. Two independent
-- layers, the same "doubly enforced" pattern purchases/refund_requests
-- already establish in this schema, deliberately WITHOUT a trigger:
--   1. PRIVILEGE: revoke every ambient grant from anon/authenticated,
--      then hand back ONLY select. INSERT/UPDATE/DELETE are never
--      granted to either role anywhere in this file -- there is no
--      privilege for a policy to even need to narrow.
--   2. RLS: two SELECT policies are added below (author-own,
--      staff finance.view); zero INSERT/UPDATE/DELETE policies exist
--      for ANY role -- with row level security enabled and zero
--      policies for a command, that command is denied outright for
--      every role, regardless of any grant.
-- This exact two-layer, trigger-free approach is the established
-- precedent for every other append-only-style table in this schema
-- (admin_audit_log, payment_disputes, book_checkout_intents all use it,
-- none uses a trigger). A trigger would add a third mechanism with no
-- additional real protection over what revoke+RLS already guarantee for
-- every role that matters, and this migration's own Section 15
-- explicitly asks to evaluate rather than default to one.
--
-- WHO CAN STILL MUTATE A ROW, AND WHY THAT IS CORRECT: the table owner
-- (the migrations role) and a Postgres superuser/service_role connection
-- are UNAFFECTED by RLS and by a revoke that only names anon/
-- authenticated -- this is inherent Postgres behavior (RLS does not
-- apply to a table's owner by default, and this migration neither
-- changes that nor attempts to, per its own Section 15 instruction:
-- "Do not make maintenance impossible for database owner/postgres").
-- This is identical to every other append-only-style table in this
-- schema today and is the deliberate, practical boundary: ordinary
-- application roles (anon, authenticated -- which is what every reader/
-- author/staff session actually authenticates as) can never mutate a
-- ledger row under any circumstance; genuine emergency maintenance
-- remains possible only via direct, privileged database access, never
-- through the application.
revoke all on public.author_ledger_entries from anon, authenticated;
grant select on public.author_ledger_entries to authenticated;

-- LEDGER-1B Section 45/47 (author privacy), resolved explicitly rather
-- than left implicit: every column on this table was reviewed against
-- what an author can already see today. purchase_id/payment_id/
-- payout_id are opaque internal ids only -- they name a ROW, not a
-- buyer; reference_id (e.g. a Stripe refund id, once LEDGER-1C starts
-- populating it) is no more sensitive than purchases.
-- stripe_payment_intent_id, which "Authors can view purchases of their
-- own books" (this schema, purchases policy) ALREADY exposes to an
-- author in full today, unfiltered by column. No buyer identity
-- (buyer_id, reader identity) appears on this table at all -- it lives
-- only on payments/purchases, neither of which this table's own RLS
-- exposes to an author beyond what those tables' own policies already
-- allow. A separate author-facing VIEW was considered and rejected: it
-- would add real indirection for a privacy boundary this table does not
-- actually cross, given the precedent above -- see LEDGER-1A's own
-- Section 45 for the fuller reasoning. If a future entry_type or column
-- ever DOES need to carry something more sensitive, revisit this
-- decision then, against the actual new column, not speculatively now.
create policy "Authors can view their own ledger entries"
  on public.author_ledger_entries for select
  using (auth.uid() = author_id);

create policy "Staff with finance.view can view all ledger entries"
  on public.author_ledger_entries for select
  using (public.staff_has_permission('finance.view'));

-- ============================================================
-- LEDGER-1B Section 26 (admin adjustments) -- EXPLICITLY DEFERRED.
-- This migration adds NO adjustment-recording RPC. An RPC that inserts
-- a staff-authored 'adjustment' entry (requiring finance permission,
-- a non-empty reason, the real staff actor, and an admin_audit_log
-- event) is real, business-specific, and easy to get subtly wrong under
-- schema/behavior changes still in flux this early -- LEDGER-1B's own
-- brief explicitly permits deferring it ("preferred LEDGER-1B scope is
-- schema foundation only... defer to LEDGER-1E or finance-admin phase")
-- and Section 31 separately forbids any generic, broadly-callable
-- insert_ledger_entry(...)-style primitive at this stage. The CHECK
-- constraints and RLS above make the table itself safe to expose (an
-- authenticated caller cannot write to it under any circumstance)
-- whether or not a write RPC exists yet -- deferring the RPC costs
-- nothing in safety and avoids committing to an admin-adjustment UX
-- shape before one exists.
--
-- LEDGER-1B Section 31 -- NO SALE/REFUND RECORDING RPC EITHER, for the
-- same reason: record_successful_sale()/record_refund() belong to
-- LEDGER-1C, once they can be wired directly into the exact transaction
-- boundary finalize_book_checkout_intent()/the refund webhook already
-- establish, with real idempotency testing against real call sites --
-- not speculatively defined here against call sites that do not yet
-- call them.
-- ============================================================
