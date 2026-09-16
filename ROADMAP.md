# Librum Roadmap

**Canonical planning snapshot: 9 September 2026.** This file is kept in sync
with the master planning document reviewed on that date, and supersedes any
older Stripe-first assumptions elsewhere in this repository's history.

## Confirmed product decisions — ALL/POK cutover (16 September 2026, corrected)

**This section is a decision record, not a phase-completion claim.** It
supersedes every earlier USD/Stripe-first pricing assumption in this file
and every proposal anywhere in this repository's history that treated
`books.price_cents` as an ALL price. It does **not** by itself move any
phase to DONE/COMPLETE. **This is not merely a top-level notice — every
active/current section elsewhere in this file that used to contradict it
has been corrected in place** (Legacy/transitional, Payment-provider
policy, and Phases 8/9/11/13 below); nothing contradictory is left
presented as a current fact.

**Correction notice:** an earlier draft of this exact section proposed a
future `USD/ALL` dual catalog model, implied existing USD-shaped test
books could remain sellable under a retained legacy path, rejected all
leading zeros in author input, and had no maximum catalog price. All of
that is superseded in full by the record below.

- **ALL-only, no exceptions.** Librum's future catalog and customer
  checkout currency is ALL only. Authors enter prices only in ALL;
  readers see and pay prices only in ALL. POK is the only provider for
  new paid transactions. There is no author-facing USD entry, editing,
  display, or checkout path, now or later. No runtime USD-to-ALL
  conversion will ever be built. No existing `price_cents` value is ever
  relabeled, scaled, converted, or reinterpreted as an ALL amount.
- **Existing USD-shaped data, in both Staging and Production, is
  disposable pre-launch test data, not a legacy mode.** Every existing
  book, purchase, payment attempt, checkout intent, provider mapping,
  and ledger record in either environment is pre-launch test data. It
  may eventually be removed, but **nothing is deleted by any patch in
  this family** — cleanup must be separately planned, reviewed, backed
  up/exported as appropriate, and explicitly authorized before it
  happens. It is never treated as a supported legacy catalog, never kept
  sellable through Stripe as a fallback, and never a case an application
  code branch needs to keep serving long-term.
- **Whole-ALL catalog prices, floor and ceiling.** Authors set whole-lek
  prices only. A catalog value of `99` means exactly 99 ALL — never 0.99
  ALL, never 9,900 ALL. The valid catalog domain is exactly: `0` for an
  explicitly free book, or an integer from **99 through 100,000
  inclusive** for a paid book. Any nonzero fractional catalog price is
  rejected, never rounded or clamped; any value above 100,000 ALL is
  invalid. The misleading `_cents` naming is not reused for this
  whole-ALL semantics — a future explicit name such as `price_all` is
  used instead, introduced only by a later, separately reviewed
  migration (never in the same patch that merely establishes this
  record, and never as a rename or reinterpretation of the existing
  column).
- **Leading zeros are accepted and normalized, not rejected.** `"099"`
  and `"00099"` both parse to 99 ALL, the same value `"99"` alone means;
  `"00"`/`"000,00"` parse to the free price 0. Grouping separators are a
  completely different thing and remain invalid as author input — `.`
  is only ever the reader-facing thousands separator, never inferred
  from typed input; `"1.000"` is a decimal-shaped value with three
  fractional digits, not "one thousand", and is rejected outright.
- **Accepted author input forms, restated explicitly.** Authors enter
  whole-lek catalog prices. Accepted equivalent forms for the same
  value include `99`, `99,00`, and `99.00` (and their leading-zero
  equivalents, per the point above). Any nonzero decimal catalog amount
  is rejected. Grouping separators are never accepted as author input.
  Reader-facing formatting is a deliberately separate grammar —
  `1.000,00 ALL` is display-only output, never something an author types
  and never something the parser infers from a typed grouping separator.
- **Confirmed Albanian display format.** `99,00 ALL`, `1.000,00 ALL`,
  `100.000,00 ALL` — comma is the decimal separator, dot is the
  thousands separator, exactly two display decimals are always shown.
  This is a confirmed decision, not an implementation choice left to a
  later patch.
- **Exact decimal ALL financial accounting.** Catalog prices are
  whole-ALL integers, but financial calculations (discounts, author
  earnings, commission, refunds, reversals) must preserve qindarka
  exactly — e.g. a calculated 69.30 ALL stays exactly 69.30, never a
  binary-floating-point approximation. Future financial values use exact
  PostgreSQL `numeric`/`decimal` storage for this, never a float. This is
  a distinct representation from the catalog's whole-ALL integers, not
  the same field reused twice.
- **ALL-only financial currency.** Every payment, purchase, refund,
  ledger entry, reversal, and payout must explicitly record
  `currency = ALL` going forward.
- **Free acquisition.** An author may deliberately publish a free book
  (catalog price exactly zero). Free acquisition bypasses POK entirely:
  it creates reader ownership/entitlement and a zero-value purchase
  record, and creates no POK order, payment, author earning, commission,
  payout obligation, or other monetary ledger entry. A paid book can
  never become free through an ordinary discount — only an explicit
  catalog price of zero is free.
- **Discount rule.** A paid book's final discounted checkout price must
  remain a whole number of ALL, and at least 99 ALL. A discount that
  would produce a fractional ALL result, or a value from 0.01 through
  98.99 ALL, is rejected for that checkout — never clamped, rounded, or
  otherwise silently altered upward or downward. Zero is valid only when
  the book itself is explicitly published as free (see "Free
  acquisition" above); a discount can never be the mechanism that makes
  an otherwise-paid book free.
- **Commission and POK-fee rule.** Librum's existing configured
  commission rules are kept as-is for now, and only after their exact
  behavior is audited in a later, separately reviewed patch — this
  record does not invent, change, or assume any specific commission
  percentage. The author's contractual share is calculated from the
  book's sale price. Librum absorbs POK's processing fees; those fees
  never reduce the author's contractual share. Exact commission/
  author-share results preserve qindarka using exact decimal accounting
  (see "Exact decimal ALL financial accounting" above) — never a
  binary-floating-point approximation.
- **POK is selected; its create-order integration is implemented and
  staging-verified; the remaining work is completion, not selection.**
  POK's checkout-page creation was verified working in staging at 499
  ALL — this proves the create-order integration path, not full
  payment/fulfillment/refund handling, which is genuinely not yet built
  (see Phases 9–12 below). Do not read this record as claiming full POK
  payment/fulfillment/refund is already verified, that 99 ALL has been
  independently probed, that production is ready, that test data has
  already been deleted, or that Stripe code has already been disabled or
  removed — none of that is true yet.
- **Stripe disablement is not the same milestone as Stripe removal, and
  disablement comes early, not last.** Blocking new paid checkout
  temporarily is safer than silently defaulting to Stripe while
  Librum is pre-launch. Every path that can create a **new** Stripe
  checkout session is disabled in the first separately reviewed
  runtime-behavior patch after the pure foundation patch — well before
  the POK integration is complete, not after it. `resolveCheckoutRegime`
  must never default a **new** transaction to Stripe once that patch
  lands; book/bundle server actions must be unable to create a new
  Stripe session; no UI path may offer Stripe checkout. Stripe's
  webhook, reconciliation, and historical-reading code may remain
  temporarily for safe auditing of whatever pre-existing test
  transactions exist — that code is not deleted in the disablement
  patch. Stripe code is removed only later, after the complete POK
  staging lifecycle is verified and historical dependencies are audited.
- **Price changes and frozen history, stated explicitly.** An author may
  change a published book's price. The new price affects **future**
  checkout intents only — it never changes any previously frozen intent,
  mapping, payment, purchase, refund, ledger entry, commission,
  reversal, or payout. All of those, once created, remain immutable
  regardless of any later price change to the book they reference. A
  stale intent is never reused if its frozen price, currency, discount,
  payable amount, regime, state, or expiry differs from the current
  checkout. See "Intent-reuse defect" immediately below — this rule is
  **not yet fully enforced by the current `create_book_checkout_intent`
  RPC** and is corrected only by a later, separately reviewed patch, not
  by this foundation patch.

### Intent-reuse defect (read-only finding, unchanged this round)

No new live query was run this round — the finding below was already
established with live, read-only evidence and nothing about the schema,
the RPC, or the three known incidents has changed since. Repeating it
here rather than re-querying avoids an unnecessary live read against
production/staging data for a fact that hasn't changed.

- `state` and `last_error_code` live on **`pok_book_checkout_orders`**
  (the one-to-one POK mapping row, `supabase/schema.sql:9885-9906`,
  keyed by `intent_id`), not on the intent table. `state`'s only values
  are `'creating' | 'ready' | 'needs_reconciliation'`.
- `completed_at`, `fulfilled_at`, and `reconciliation_reason` live on
  **`book_checkout_intents`** (`schema.sql:2652-2685`).
  `reconciliation_reason` is a **different, unrelated** enum
  (`'active_other_session' | 'book_or_reader_deleted' | 'disputed_lost'`)
  gated by `check ((reconciliation_reason is not null) = (completed_at
  is not null and fulfilled_at is null))` — this check constraint governs
  `reconciliation_reason`, not the mapping's `needs_reconciliation`
  state. The two "reconciliation" vocabularies are unrelated; conflating
  them was the original error this correction fixed.
- `create_book_checkout_intent()`'s reuse query
  (`schema.sql:2767-2782`) selects from `book_checkout_intents` **only**
  — `where fulfilled_at is null and completed_at is null and expires_at
  > now()`. It never joins or references `pok_book_checkout_orders` at
  all, so it has **no knowledge of mapping state**. An eligible
  uncompleted intent whose mapping is stuck at `needs_reconciliation` can
  therefore be reused by this query.
- Live confirmation against the three known incidents (`3dcfd6cc…`,
  `0dcfd93e…`, `93992238…`, project `erhzpapqwyfjotliqdjo`, safe fields
  only, established in an earlier round of this same review): all three
  have `completed_at = null`, `fulfilled_at = null`,
  `reconciliation_reason = null` on the intent, and
  `state = 'needs_reconciliation'`, `last_error_code =
  'creation_unconfirmed'` on the mapping — exactly the combination the
  schema permits the reuse query to match.
- **Why no second/incorrect POK order has actually been created in
  practice:** `startPokCheckout()` (`src/lib/pok-checkout.ts:160-180`)
  calls `repo.claim(row)`, a raw INSERT into `pok_book_checkout_orders`
  keyed by `intent_id` (`src/lib/pok-repository.ts:18-23`). Since a
  mapping row already exists for that `intent_id`, the insert hits
  Postgres unique-violation `23505`, `claim()` returns `false`, and
  `startPokCheckout` then reads back the existing mapping, sees
  `state !== 'ready'`, and throws `POK_CHECKOUT_REQUIRES_RECONCILIATION`
  rather than creating a new order. **This is an accidental safety net
  from the mapping table's own primary key, not a deliberate reuse-safety
  check performed by the authoritative RPC.** It happens to prevent the
  worst outcome today, but does not satisfy the "an old intent must not
  be reused" rule at the layer meant to enforce it, and a future change
  to either table's logic could silently remove this protection without
  anyone touching the actual defect.
- **This is a "must change before schema expansion" finding**, tracked
  in the later-patch sequence below (Phase 4 — "authoritative ALL
  pricing and intent logic"): the RPC must later reject reuse whenever an
  existing mapping is not safely reusable, rather than relying on the
  incidental PK-conflict downstream. **Not fixed by this foundation
  patch** — no RPC or production behavior change is authorized here.
- **Missing test scenario, added to the future test plan:** an
  uncompleted intent with an existing mapping in `needs_reconciliation`
  (`last_error_code = 'creation_unconfirmed'`, no provider order id) must
  never be returned by a repeated checkout attempt as a reusable
  intent — the reuse query itself must exclude it, not merely rely on
  the mapping table's own insert failing downstream.

### Corrected later-patch sequence (expand/contract, ALL-only)

No proposal below implies a supported USD catalog mode, USD author
editing/display/checkout, a future USD/ALL choice, existing test books
remaining sellable as legacy books, Stripe as an allowed default or
fallback once disabled, or a symmetric legacy-Stripe currency constraint
as a future requirement — none of that is proposed here. A future
nullable `currency_code`-style column, if retained for audit clarity,
permits only `ALL` when non-null; no exact migration DDL is specified
here, that is reviewed separately.

1. **Pure foundation contract and utilities** — this patch: the decision
   record above, and the unwired `src/lib/catalog-price.ts` primitives.
   No migration, no wiring, no behavior change.
2. **Explicit Stripe new-checkout disablement** — a separately reviewed
   runtime-behavior patch, before any ALL schema work: `resolveCheckoutRegime`
   stops defaulting new transactions to Stripe; book/bundle server
   actions can no longer create a new Stripe session; no UI path offers
   Stripe checkout. Stripe's webhook/reconciliation/historical-reading
   code is untouched. Paid checkout may be temporarily unavailable
   end-to-end between this phase and Phase 7 — accepted, since Librum is
   pre-launch.
3. **Schema expansion for ALL** — add new, nullable, ALL-only fields
   (e.g. a future `price_all`, and an audit-clarity `currency_code`
   permitting only `ALL` when non-null) alongside the untouched legacy
   `price_cents` field. Old test rows keep null new fields; nothing is
   backfilled by inference.
4. **Authoritative ALL pricing and intent logic** — deploy code that
   understands the new fields; `create_book_checkout_intent` (or its
   replacement) is corrected to check the book's own ALL fields
   authoritatively, and to check `pok_book_checkout_orders` mapping
   state directly (closing the intent-reuse defect above) rather than
   relying on an incidental PK-conflict safety net. Rows lacking valid
   ALL pricing are unsellable through the new checkout path.
5. **Author/storefront/free-book wiring** — create/edit new books only
   with explicit ALL pricing (using this patch's parser/formatter);
   storefront display reads the book's own ALL fields; free acquisition
   wiring confirmed unaffected (already provider/ledger-free today).
6. **Ledger, refund, payout, and admin work** — exact-decimal ALL
   financial snapshots; admin finance reporting becomes ALL-aware.
   Historical rows/records are never mutated by this phase.
7. **Complete POK staging lifecycle** — create-order, return, webhook,
   fulfillment, idempotency, refund, reversal, and access-revocation
   tests, end to end on staging.
8. **Stripe code removal** — only after Phase 7's staging acceptance and
   an audit of any remaining historical-transaction dependency.
9. **Separately reviewed test-data cleanup** — remove disposable
   pre-launch books/purchases/payment attempts, in either Staging or
   Production, only through a separately planned, reviewed,
   backed-up/exported, and explicitly authorized cleanup — never as a
   side effect of any code-behavior patch.
10. **Final schema contraction/constraints** — enforce the new ALL
    fields `NOT NULL` and retire the obsolete `_cents` catalog field
    only after Phase 9 confirms no remaining code or data depends on it.

## How to use this file

1. Check the current branch/HEAD and recent commits before making a major
   implementation decision — this file describes state as of the snapshot
   date, not necessarily this exact minute.
2. This file uses **two separate, non-interchangeable tagging systems** —
   don't conflate them:
   - **Feature/code classification** (used for concrete features and
     systems): **DONE** — built, and the intended/current way that area
     works, though "built" is not the same as "verified end-to-end" (see
     Phase 2). **BUILT/DORMANT** — the code exists and is wired up, but a
     feature flag, missing configuration, or a business/legal gate keeps
     it inactive in production. **LEGACY** — currently implemented/
     deployed, but intended to be replaced; keep it working, don't invest
     further in its long-term future. **DEFERRED/BLOCKED** — not active,
     blocked on a decision or dependency outside engineering. **NOT
     BUILT** — no code exists for this yet.
   - **Phase execution status** (used for the chronological phases below —
     QA passes, audits, legal/business decisions, and launch gates are
     *work to execute*, not code, so they never take a code classification
     like "NOT BUILT"): **COMPLETE**, **IN PROGRESS**, **NOT STARTED**,
     **BLOCKED** (blocked on something outside engineering, same meaning as
     the feature-level DEFERRED/BLOCKED).
3. Do not rebuild systems already marked DONE or BUILT/DORMANT.
4. **Corrected:** POK's own commercial/legal activation (Phase 8) and the
   author payout rail decision (part of Phase 14) stay paused until the
   legal/business-registration gate (Phase 6), unless a human explicitly
   reopens either early. This does **not** block Phases 9–12's staging
   integration/completion/refund/dispute work, which the owner has
   explicitly authorized to proceed ahead of Phase 6 — provider
   *selection* itself (POK) is already decided, see the decision record
   below.
5. **Blocking rule, all phases:** a critical authentication, authorization,
   financial-integrity, or data-loss defect discovered at any phase blocks
   progression to later phases until it is fixed and the fix is verified.
   Don't route around a defect like this to keep a phase moving.

## Current state

Librum is no longer an early MVP. The core public platform, author
publishing flow, reader features, admin/back-office, and a provider-neutral
financial ledger are already built. What remains is largely QA, business/legal
groundwork, and a deliberate, gated cutover of the payment provider —  not
building missing product surface area.

### Core product — implementation substantially built

Public storefront/bookstore, search/genre/sort/price filters, book detail
pages, author public profiles, series, bundles, blog (public + admin CMS),
SEO foundations (sitemap/robots/404/error UX), author registration/profile/
dashboard, the Publishing Studio (EPUB upload, DOCX upload + DOCX→EPUB
conversion, EPUB validation, sample extraction, cover uploads, metadata,
contributors, series, discounts, bundles, draft/edit/publish/unpublish),
reader accounts (wishlist, follows, reviews, library/downloads,
refund-request UX), admin staff/RBAC, report moderation queue, refund queue,
finance/reconciliation views, audit log, and authentication/recovery/
account-deletion hardening (including AUTH-1E, below).

Individual features in this list may be **DONE** at the implementation
level — but "built" is not the same as "verified end-to-end." Full staging
walkthroughs of the author/reader/admin journeys remain pending Phase 2.
**Do not infer end-to-end correctness from repository presence alone.**

### Provider-neutral financial foundation — DONE (built)

`payment_events`, immutable `payments`, `author_ledger_entries`, sale and
refund accounting primitives, settlement timing, author financial reporting,
transactional book/bundle payment finalizers, idempotency/concurrency
protections, amount/currency reconciliation, and a frozen payment
regime/currency/economics model (migrations 048–050, 056). **This ledger is
built. Do not propose rebuilding it** — future payment-provider work is an
adapter feeding this existing system, not a replacement for it.

### Author payout foundation — BUILT/DORMANT

Payout settings, eligibility, minimum-policy model, balance checks,
reservation system, payout runs, payout reporting/history, bank-destination
schema, immutable destination snapshots, payout reversals, and a monthly
scheduler foundation (migrations 051–055; `src/lib/payout-scheduler.ts`;
`/api/internal/payouts/run` registered in `vercel.json`'s cron at
`0 6 5 * *`). All of it sits behind two independent, fail-closed flags:
`BANK_PAYOUT_SETUP_ENABLED` (bank-destination UI) and
`PAYOUT_SCHEDULER_ENABLED` (actual reservation execution) — **the code
defaults both to disabled when the variable is unset**, but whether either
has actually been set in the real Vercel Production environment has not
been independently verified; don't assert either way about the live value
without checking it directly. Cron registration alone does not arm
anything — the endpoint Vercel invokes on schedule must stay a no-op unless
`PAYOUT_SCHEDULER_ENABLED` is explicitly and verifiably set.

### Legacy/transitional — LEGACY

**Superseded in part by the "Confirmed product decisions" record above —
see that section for what's current.** The paragraphs below now describe
historical/transitional code status only, corrected where they used to
assert a still-open provider decision:

- Stripe Checkout/Connect Express code is implemented and deployed, and
  remains the currently implemented paid-commerce path for existing
  pre-launch test data (direct/destination charges are coded to split
  each sale automatically). **This is not the same as a confirmed live
  real-money rail** — whether the Vercel Production environment
  currently holds Stripe test-mode or live-mode credentials, and whether
  a real transaction has actually been verified end-to-end in that
  configuration, has not been independently confirmed from this
  repository. It is being disabled for new checkouts (see the decision
  record above), then replaced.
- Paid-book publishing still gates on the legacy `stripe_payouts_enabled`
  profile flag, pending the disablement/cutover work above.
- **Corrected:** the final buyer-payment *provider* for new paid checkout
  is no longer undecided — POK is selected, and its create-order/
  checkout-page integration is implemented and staging-verified
  (a real POK hosted checkout page was created at 499 ALL). What
  remains open is completion/fulfillment verification, refund,
  reversal, and access-revocation lifecycle hardening (Phases 9–12
  below), and the separate, still-genuinely-undecided **author payout
  mechanism/rail** (Phase 14) — a different decision from which
  provider processes a buyer's checkout.
- A dormant Stripe **ledger_v1 bridge** exists (`librum_ledger_v1` checkout
  regime, `src/lib/checkout-regime.ts`) that lets a Stripe-funded checkout
  finalize through the new provider-neutral ledger instead of the legacy
  path. It defaults to **off** (`NEW_CHECKOUT_REGIME` unset resolves to
  `legacy_stripe_connect_v1`) and **is not the intended long-term payment
  architecture** — it existed to prove the ledger against a real payment
  flow ahead of the real provider cutover; POK, not this Stripe bridge, is
  the path that cutover now takes (see the decision record above).
- Some Stripe-specific historical refund/reconciliation code will need to
  remain for as long as historic Stripe transactions exist, even after
  cutover — Stripe's webhook/reconciliation/historical-reading code is
  explicitly kept for this, not deleted, when new-checkout disablement
  lands.

### Deferred/blocked business items — DEFERRED/BLOCKED

Legal entity registration (Person Fizik vs. Sh.p.k. undecided), NIPT/NUIS,
a business bank account, POK's full commercial/legal activation (real KYB,
merchant agreement, going live with real money — **not** which provider;
that part is decided, see above), the real author payout rail, final legal
documents, Albanian localization, the `librum.al` production domain and
production email identity, initial real author/catalog onboarding, and
final launch QA. **Full commercial/legal activation of POK, and the
author payout rail decision, stay paused until the business-registration
gate (Phase 6) unless a human explicitly reopens either — this does not
block the already-decided technical provider selection or the staging
integration work in Phases 9–12, which proceed ahead of registration by
explicit owner decision.**

### NOT BUILT (code/features)

**Corrected:** POK's create-order/checkout-page creation is built and
staging-verified (Phase 9's initial integration is done, not "genuine
code that doesn't exist yet"). What is genuinely NOT BUILT: POK payment
*completion* verification (webhook → fulfillment → entitlement, Phase 10),
refund/reversal/access-revocation handling (Phases 11–12), the Stripe
new-checkout disablement patch, the eventual Stripe code removal (Phase
13, after Phases 9–12 and the disablement patch), and everything under
"Deferred until after launch stability" at the bottom of this file. **Do
not read this as a claim that full POK payment, fulfillment, or refund
handling is already verified — only checkout-page creation is.**

Everything else still remaining (Phases 14–20) is either activating code
that already exists (Phase 14 — see "Author payout foundation" above) or
non-code work — legal, localization, production identity, catalog
onboarding, audits, launch. Those are tracked by **phase execution
status** (NOT STARTED/BLOCKED) in the chronological roadmap below, not by
the NOT BUILT feature tag — see "How to use this file" above for why the
two systems are kept separate.

## Current authentication/email state

- Signup `emailRedirectTo` (drives the confirmation-link destination) —
  **DONE**, active in production.
- PKCE `?code=` auth callback — **DONE**, active (pre-existing).
- Direct `?token_hash=...&type=signup|recovery` auth callback — **BUILT/
  DORMANT** (AUTH-1E). The route accepts only the closed `signup`/`recovery`
  set; nothing in the current email configuration emits this link shape yet.
- Supabase Auth is currently on its **default email templates**, with **no
  custom SMTP configured**.
- Cross-browser/device email confirmation (the scenario the `token_hash`
  path exists for) — **DEFERRED/BLOCKED** until custom SMTP, coordinated
  email templates, and a real staging end-to-end send/click test all exist
  together. Do not claim this is fixed by AUTH-1E alone.
- Current Supabase Auth **Site URL**: `https://librumal.vercel.app`
- Current Supabase Auth **redirect allow-list**: `https://librumal.vercel.app/**`
- Both of the above must be replaced or extended (not just left stale)
  once `librum.al` becomes the production domain (Phase 17) — a domain
  migration that forgets this will break every email link in flight.

## Payment-provider policy

**Corrected — provider selection is decided, not open.** Do not rebuild
the ledger. POK is implemented as an adapter feeding the existing
provider-neutral accounting system (see above); its create-order/
checkout-page creation is built and staging-verified (499 ALL). Provider
*search* is over for new paid checkout — what stays paused until the
business-registration gate (Phase 6) is POK's full commercial/legal
activation with real company data (KYB, merchant agreement, going live),
not which provider to integrate.

Historical record, preserved for context (superseded on the "which
provider" question by the decision above; FasterPay was never selected
and is not part of any current or future path):
- **FasterPay** — Albania accepted in onboarding; marketplace/card/self-
  service onboarding looked promising; final KYB and commercial terms still
  require company registration. Not pursued further once POK was selected.
- **POK** — Albanian provider, marketplace support, API/SDK, staging, test
  cards, 3DS, card acquiring. ALL-currency create-order semantics are now
  confirmed working in staging (499 ALL); refund API, disputes, merchant
  fees, and settlement terms still need verification once Librum has a
  NIPT and can complete real KYB.
- Other providers are not being reconsidered — POK is selected.

## Facts to verify (no credentials recorded here)

These are open verification tasks, not confirmed states — do not treat any
of them as settled until the evidence described exists:

- **Environment mapping:** which Supabase project the Vercel *Production*
  environment's env vars actually point to has not been directly
  inspected. What exists is supporting evidence, not proof of the complete
  mapping: the public deployment at `https://librumal.vercel.app` serves
  content from Supabase ref `pwkukotgpsegieshulpj`; the local
  `.env.local` in this environment also points at that same ref; and
  Supabase dashboard screenshots reviewed during AUTH-1E confirmed Auth
  configuration (Site URL, redirect allow-list) for that project. None of
  that is the same as directly inspecting the Vercel Production
  environment-variable values themselves — treat the mapping as strongly
  supported, not confirmed, until that direct check happens.
- **Migration state:** this repository's `supabase/migrations/` currently
  goes up to `056_ledger_v1_transactional_payment_foundation.sql`. Whether
  every one of those migrations is actually applied to the production
  database has not been independently confirmed in this pass — verify via a
  live migration-state check before assuming production schema matches
  `supabase/schema.sql`.
- **Feature-flag state in production:** `BANK_PAYOUT_SETUP_ENABLED`,
  `PAYOUT_SCHEDULER_ENABLED`, and `NEW_CHECKOUT_REGIME` all fail closed to
  "off"/"legacy" in code when unset — but whether any of them has been set
  in the actual Vercel Production environment has not been independently
  confirmed. Verify their live values directly; don't infer from code
  defaults alone.
- **`purchases_reader_id_idx` production drift:** `supabase/schema.sql` and
  `supabase/migrations/002_add_purchases.sql` declare this index. Whether it
  actually exists on the **production** database has not been re-confirmed
  with live evidence since it was first flagged as drifted. **Treat this as
  an open verification task — do not state it is fixed without a live
  database check (e.g. a direct catalog/index-existence query against
  production) proving it.**

# CHRONOLOGICAL ROADMAP

## Phase 0 — Repository/state hygiene

**Status:** COMPLETE.
- [x] AUTH-1E complete: inspected, revised, tested, committed
      (`9c47da62bdd9e97cfebec4b6ea6d1377c10fb09c`), pushed, and verified live
      (`/login`, `/signup`, and a parameterless `/auth/callback` all checked
      against the resulting Vercel production deployment).
- [x] `ROADMAP.md`/`README.md` refresh — completed in this documentation
      commit (`PHASE-0: align roadmap and README with current Librum
      state`).
- [x] `purchases_reader_id_idx` production drift — recorded as a tracked,
      nonblocking production verification follow-up (see "Facts to
      verify" above). Per the canonical roadmap's own instruction to
      "record/fix later," this item does **not** block Phase 0 and carries
      forward as an open follow-up into later phases.

**Completion criteria:** met — AUTH-1E complete, and this documentation
commit lands both the `ROADMAP.md`/`README.md` refresh and the tracked,
nonblocking `purchases_reader_id_idx` follow-up.
**Required evidence:** the AUTH-1E commit SHA and post-deploy route check
(already captured); this documentation commit's SHA.

## Phase 1 — Safe staging workflow

**Status:** NOT STARTED.
1. Create a local staging configuration, pointed at an isolated staging
   Supabase project — never the production ref.
2. Add a hard guard that refuses to run local/staging against the
   production Supabase project ref.
3. Keep credentials/environments fully separate.
4. Create synthetic staging users/data (author, reader, books/drafts,
   series, bundle, supporting test data).
   - PHASE-1C (local implementation only, not yet run against staging):
     `scripts/staging-fixtures/` implements this — an independent
     staging-only guard, a versioned Auth ownership marker, a fixed
     idempotent fixture dataset, and a full preflight/reset/teardown
     disposition matrix, all covered by unit tests against injected
     fakes (no live credentials used). **Not yet exercised against the
     real staging project** — do not treat this item as done until a
     live `seed`/`reset-to-baseline` run against
     `erhzpapqwyfjotliqdjo` has actually been demonstrated.
5. Establish a repeatable local → staging QA workflow.

**Completion criteria:** the guard exists in code (not just convention),
and staging data is reproducible from a documented/scripted setup.
**Required evidence:** a demonstrated, failed connection attempt — running
local/staging configuration against the production Supabase ref must be
provably rejected (e.g., a logged refusal or hard error), not merely
"believed unlikely to happen." This proof is a hard prerequisite for calling
Phase 1 done; a staging setup that merely doesn't happen to point at
production yet is not the same as one that can't.

## Phase 2 — Full end-to-end product QA

**Status:** NOT STARTED. The product exists; the structured staging QA
pass itself has not been run.
- **Author journey:** signup → author profile → EPUB/DOCX upload →
  conversion → cover → metadata → contributors → series → pricing →
  discount → draft → edit → sample → free publish → published editing →
  unpublish/republish → bundle → dashboard/sales/balance/history.
- **Reader journey:** register → bookstore → search/filter/sort →
  author/book pages → sample → wishlist → follow → free acquisition →
  library → download → review → account/recovery/deletion.
- **Admin journey:** admin login → staff/RBAC → reports → refund queue →
  finance → audit → blog CMS → moderation.

**Completion criteria:** every journey above walked end-to-end on staging
with real findings recorded, not assumed passing from code review alone.
**Required evidence:** a defect register populated from actual QA runs. Do
not invent unrelated features during this phase — fix what QA finds.
**Blocking rule applies:** any critical auth/authorization/financial-
integrity/data-loss defect found here blocks progress to Phase 3 until
fixed and re-verified.

## Phase 3 — Product-quality / technical hardening

**Status:** NOT STARTED. Some hardening work already exists from earlier,
narrower ad hoc audits, but the dedicated, comprehensive review across all
the areas below has not been completed.
Mobile/tablet/desktop consistency, accessibility, forms/loading/empty/error
states, performance, RLS/authorization review, download/file security,
upload validation, rate limiting/abuse protection, sensitive-logging/PII
review, backups/recovery, monitoring/logging, staging→production deployment
discipline, SEO/copy polish.

**Completion criteria:** each area above has been reviewed against the live
(or staging) app, with findings either fixed or explicitly deferred with a
reason.
**Required evidence:** a written finding per area, even if the finding is
"no issue found."

## Phase 4 — Provider-neutral finance UX (only where useful)

**Status:** NOT STARTED, for the dedicated evaluation/additional work this
phase covers. The existing finance UX baseline — pending-vs-available
balance presentation, recent financial activity, payout history, author
financial reporting, and admin finance/reconciliation/exception-queue
visibility (`dashboard/balance`, `dashboard/sales`, `admin/finance`) — is
already built at the implementation level. Additional work beyond that
baseline (richer sales/royalty breakdowns, statements, further
reconciliation-visibility gaps) remains conditional on Phase 2/3 findings.

**Completion criteria:** the existing baseline keeps working; any
*additional* work beyond the baseline only starts once Phase 2/3 QA or real
production operation has surfaced a concrete finding that justifies it. Do
not redesign the accounting model, and do not build further finance UX
speculatively without such a finding.
**Required evidence:** the specific QA/operational finding that justified
each piece of additional work, cited alongside the change.

## Phase 5 — Lock business rules

**Status:** NOT STARTED. This is decision work, not missing code.

Split into two groups — do not treat them as equally ready to decide:

**Baseline decisions (can be locked now, independent of any provider):**
author royalty percentage/rules, refund policy, chargeback-responsibility
policy intent, publishing/content/copyright/takedown rules, marketplace/
customer rules.

**Bank/commercial-terms-dependent decisions (draft now, confirm only
after Phases 6–8):** settlement delay, minimum payout threshold, payout
schedule, supported currencies, payout-failure behavior. These depend on
the actual bank account (Phase 7) and POK's real, KYB'd commercial
settlement terms (Phase 8) — POK itself is already chosen (see the
decision record above); what's still missing is its commercial terms
with Librum's real company data. A "decision" made before those terms
exist is a draft, not a lock.

**Completion criteria:** baseline decisions are written down and locked;
provider/bank-dependent decisions are drafted but explicitly marked
provisional until Phases 6–8 complete.
**Required evidence:** a dated record of each locked baseline decision,
separate from the still-provisional list.

## Phase 6 — Decide legal form and register Librum

**Status:** BLOCKED — by the required chronological completion of Phases
1–5.
Evaluate Person Fizik vs. Sh.p.k. on tax/social contributions, liability,
accounting burden, marketplace risk, banking, payment-provider KYB, and
future growth/conversion. Then register and obtain legal name, NIPT/NUIS,
registration date, registered activity/address, required company/owner
documents.

**Completion criteria:** legal registration complete with documents in
hand.
**Required evidence:** the registration documents themselves (kept outside
this repository — never commit legal/company documents or identifiers
here).

## Phase 7 — Open business bank account

**Status:** BLOCKED (depends on Phase 6 completing first).
Choose bank; ALL account, likely also EUR account; IBAN; settlement/
transfer fees; SEPA/bank-transfer possibilities.

**Completion criteria:** account open, IBAN in hand, fee schedule
understood.
**Required evidence:** bank account confirmation (kept outside this
repository).

## Phase 8 — POK commercial/legal activation (corrected: not provider selection)

**Status:** BLOCKED (paused until Phase 6; do not resume early without
explicit authorization). **Corrected:** this phase is no longer "choose
a provider" — POK is already selected (see the decision record and
"Payment-provider policy" above). What's actually blocked here is POK's
full commercial/legal activation with real Librum company data: KYB,
merchant agreement, going live with real settlement, Albanian bank
settlement, operational self-service. The technical staging integration
(Phase 9) is intentionally proceeding ahead of this phase, by explicit
owner decision, because it needs no real company/legal identity to
verify against POK's sandbox.

**Completion criteria:** KYB and a merchant agreement completed against
POK with Librum's real company data, with the evaluation against every
criterion above written down.
**Required evidence:** the KYB/merchant-agreement record and confirmation
of real settlement terms.

## Phase 9 — Integrate POK into the existing ledger

**Status:** IN PROGRESS. **Corrected:** create-order/checkout-page
creation is DONE and staging-verified (a real POK hosted checkout page
was created at 499 ALL, confirming the integration path works for that
step) — this is no longer "genuine code that doesn't exist yet." What
remains NOT STARTED in this phase is completion verification: the
webhook → fulfillment → entitlement chain, end to end, proven safe under
retry/duplicate delivery.
Architecture: Buyer → POK → provider adapter → verified
provider facts → `payment_events` → transactional finalizer →
payments/purchases → `author_ledger_entries`.

Rules: no browser success page counts as proof of payment; verification is
server-side only; actual amount and currency must match expected; every
step is idempotent; no partial entitlement/accounting states are ever
observable.

**Completion criteria:** the adapter existing and passing the same
idempotency/verification tests as the existing ledger finalizers.
**Required evidence:** automated tests proving each rule above, plus a
successful staging transaction through the full chain (creation is
verified; completion is not yet).

## Phase 10 — Complete payment checkout

**Status:** NOT STARTED (this phase is about payment *completion*/
fulfillment following the already-verified checkout-page *creation* step
above — not the same claim). **Do not read Phase 9's creation-step
verification as covering this phase.**
Single-book provider order/checkout/finalization; bundle provider order/
checkout/finalization; receipts/notifications; retry/idempotency testing.

**Completion criteria:** both checkout paths work end-to-end on staging with
the new provider, receipts send, and retries don't double-charge or
double-grant entitlement.
**Required evidence:** staging test transactions for both paths, including
at least one deliberate retry/duplicate-webhook test.

## Phase 11 — POK refunds

**Status:** NOT STARTED.
Admin approval → POK refund API → POK confirmation → Librum refund
accounting → entitlement update. Keep legacy Stripe refund support only
for historical Stripe transactions as long as required. Per the decision
record above: initial production support is full refunds only (partial
refunds deferred); library access is revoked only after POK confirms the
full refund; a confirmed refund reverses the original author earning and
Librum commission exactly, with both the refund and its reversal
recorded separately.

**Completion criteria:** a refund through the new provider correctly
reverses entitlement and ledger entries; legacy Stripe refunds still work
for pre-cutover transactions.
**Required evidence:** a staging refund test through the new provider, and
confirmation the legacy path is untouched.

## Phase 12 — Provider-specific disputes/chargebacks

**Status:** NOT STARTED.
Dispute ingestion, payment identification, ledger/accounting treatment,
author liability/reserve policy, dispute won/lost handling, reconciliation,
admin workflow.

**Completion criteria:** a simulated dispute (won and lost) resolves
correctly through the ledger and the admin workflow.
**Required evidence:** staging test results for both outcomes.

## Phase 13 — Remove Stripe code (distinct from, and later than, disabling new Stripe checkouts)

**Status:** NOT STARTED. **May be prepared and tested ahead of time, but
production activation waits for the gates below.** **Corrected: this
phase is Stripe CODE REMOVAL, which stays gated on Phases 9–12 exactly as
written below. It is NOT the same milestone as disabling new Stripe
checkout creation** — per the decision record above, every path that can
create a *new* Stripe checkout session is disabled in the very next
separately reviewed runtime patch after the pure foundation patch,
independent of this phase and well before Phases 9–12 complete. That
disablement patch keeps Stripe's webhook/reconciliation/historical-
reading code in place; only this phase, once reached, removes code.
Only after the new provider works (Phases 9–12): remove the
`stripe_payouts_enabled` paid-publishing gate, stop requiring Stripe Connect
author onboarding, retire `/dashboard/payouts` legacy onboarding, activate
the intended bank/payout setup, make POK the only new-sale
path (already true for new checkouts from the disablement patch onward),
update dashboard/help/legal copy. Keep required legacy Stripe code
only for historic transactions until safely retired.

**Completion criteria:** cutover code exists and is proven on staging, but
**production activation additionally requires the legal (Phase 6-7),
operational, and Phase 19 pre-launch gates** — do not flip this in
production ahead of those.
**Required evidence:** a staging cutover run, plus explicit sign-off
referencing the gates above before any production flag flip.

## Phase 14 — Activate author payout operations

**Status:** NOT STARTED (activation). The underlying code foundation this
phase activates is **BUILT/DORMANT** — see "Author payout foundation"
above — but activation itself has not begun and is not authorized ahead
of the gate below.
1. Choose real payout mechanism.
2. Finalize threshold/settlement/payout policy.
3. Test author bank destination.
4. Test reservation/batch/failure/reversal flows.
5. Enable `BANK_PAYOUT_SETUP_ENABLED`.
6. Only after end-to-end verification, enable `PAYOUT_SCHEDULER_ENABLED`.

**Completion criteria / hard gate:** steps 1–4 begin only once the
preceding roadmap prerequisites are complete, and are prepared and tested
on staging first — never directly in production. **`PAYOUT_SCHEDULER_ENABLED`
must not be enabled in production before Phase 19 (final pre-launch audit)
is approved and Phase 20's controlled-launch gate is reached** — this is a
hard rule, not a suggestion, given it moves real money.
**Required evidence:** a staging end-to-end payout run (reservation →
batch → success/failure/reversal) before either flag is considered for
production, plus the Phase 19/20 sign-off before `PAYOUT_SCHEDULER_ENABLED`
specifically is touched in production.

## Phase 15 — Final legal documents

**Status:** BLOCKED (finalization depends on Phase 6's legal-entity
details and later phases' provider/payout choices; drafting can begin
earlier).
Finalize Terms, Privacy, Refund Policy, Author Agreement, royalty/payout
terms, copyright/takedown, content/marketplace rules, tax/invoice language.
Remove obsolete Stripe-specific claims from all of them.

**Completion criteria:** documents finalized and published, with no
references to Stripe as a permanent mechanism.
**Required evidence:** the published documents.

## Phase 16 — Albanian localization

**Status:** NOT STARTED (explicit, deliberate deferral — English first).
Translate/finalize the public site, bookstore, author dashboard, reader
dashboard, relevant admin UX, forms/errors, emails, help/FAQ, legal content.

**Completion criteria:** full localization coverage of the areas above.
**Required evidence:** a translation-completeness pass per area.

## Phase 17 — Production identity/communications

**Status:** NOT STARTED.
Connect `librum.al`, SSL, production email domain, SPF/DKIM/DMARC,
transactional sender, support email, legal company identity/footer. **Must
also update Supabase Auth's Site URL and redirect allow-list** (currently
`https://librumal.vercel.app` / `https://librumal.vercel.app/**`) to the new
domain — do not leave the old Vercel domain as the only allowed redirect
target once `librum.al` is live.

**Completion criteria:** domain, SSL, and email identity all live; Supabase
Auth URL configuration updated and verified against the new domain.
**Required evidence:** a successful auth email round-trip on the new
domain.

## Phase 18 — Real catalog onboarding

**Status:** BLOCKED (depends on the platform, legal, and provider work in
earlier phases).
First authors, author agreements, initial books, cover/metadata/EPUB QA,
pricing, merchandising.

**Completion criteria:** a real, small catalog live and correctly
merchandised.
**Required evidence:** the published catalog itself.

## Phase 19 — Final pre-launch audit

**Status:** NOT STARTED.
**Technical:** auth, uploads, publishing, downloads, payments, refunds,
disputes, ledger, payouts, emails, mobile, security/RLS, performance.
**Financial edge cases:** duplicate payment event/webhook, amount/currency
mismatch, failed checkout, refund, repurchase, refund after repurchase,
bundle, chargeback, payout reservation/failure/reversal.
**Operations:** reader support, author support, moderation, refund
handling, finance reconciliation, incident response.

**Completion criteria:** every item above explicitly checked, with sign-off.
This audit's approval is the gate referenced by Phase 14's
`PAYOUT_SCHEDULER_ENABLED` rule and Phase 13's production cutover.
**Required evidence:** a completed audit checklist with findings and
resolutions.

## Phase 20 — Controlled live launch

**Status:** NOT STARTED.
Internal testing → closed author group → small real catalog → limited real
payments → monitor accounting/refunds/payouts → expand.

**Completion criteria:** each stage above completed with monitoring showing
correct accounting/refund/payout behavior before expanding to the next
stage. This is the second half of the gate `PAYOUT_SCHEDULER_ENABLED`
depends on (alongside Phase 19).
**Required evidence:** monitoring records for each stage.

## Deferred until after launch stability

Print-on-demand/physical-book expansion, PDF/MOBI/AZW3 outputs, affiliates/
referrals, broad community features, advanced marketing/author services,
international expansion beyond the initial model.

## Immediate next actions

1. ~~Resolve AUTH-1E.~~ Done (`9c47da62bdd9e97cfebec4b6ea6d1377c10fb09c`).
2. ~~Rewrite `ROADMAP.md`/`README.md`.~~ Done (this documentation commit)
   — Phase 0 is complete.
3. **Next active task:** finish safe staging wiring (Phase 1).
4. Run full non-payment product QA (Phase 2).
5. Fix defects found.
