# Librum Roadmap

**Canonical planning snapshot: 9 September 2026.** This file is kept in sync
with the master planning document reviewed on that date, and supersedes any
older Stripe-first assumptions elsewhere in this repository's history.

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
4. Do not restart provider-specific buyer-payment work (Phases 8–12) until
   the legal/business-registration gate (Phase 6) is reached, unless a human
   explicitly reopens it early.
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

- Stripe Checkout/Connect Express code is implemented and deployed, and
  remains the currently implemented paid-commerce path (direct/destination
  charges are coded to split each sale automatically). **This is not the
  same as a confirmed live real-money rail** — whether the Vercel
  Production environment currently holds Stripe test-mode or live-mode
  credentials, and whether a real transaction has actually been verified
  end-to-end in that configuration, has not been independently confirmed
  from this repository. It is intended to be replaced, not extended.
- Paid-book publishing still gates on the legacy `stripe_payouts_enabled`
  profile flag.
- Librum has not yet selected or activated its intended final buyer
  payment provider or its intended final author payout mechanism — that
  selection/activation is Phases 8 and 14, not something already decided.
- A dormant Stripe **ledger_v1 bridge** exists (`librum_ledger_v1` checkout
  regime, `src/lib/checkout-regime.ts`) that lets a Stripe-funded checkout
  finalize through the new provider-neutral ledger instead of the legacy
  path. It defaults to **off** (`NEW_CHECKOUT_REGIME` unset resolves to
  `legacy_stripe_connect_v1`) and **is not the intended long-term payment
  architecture** — it exists to prove the ledger against a real payment flow
  ahead of the real provider cutover (Phases 8–13), not to become the
  permanent design.
- Some Stripe-specific historical refund/reconciliation code will need to
  remain for as long as historic Stripe transactions exist, even after
  cutover.

### Deferred/blocked business items — DEFERRED/BLOCKED

Legal entity registration (Person Fizik vs. Sh.p.k. undecided), NIPT/NUIS,
a business bank account, the final buyer payment provider, provider-specific
refunds/disputes, the real author payout rail, final legal documents,
Albanian localization, the `librum.al` production domain and production
email identity, initial real author/catalog onboarding, and final launch QA.
**Provider selection (Phases 8–12) stays paused until the business-
registration gate (Phase 6) unless a human explicitly reopens it.**

### NOT BUILT (code/features)

The winning buyer-payment provider's integration (Phase 9), its checkout
completion (Phase 10), and its refund/dispute handling (Phases 11–12) —
genuine code that doesn't exist yet, plus the Stripe-cutout work (Phase
13) and everything under "Deferred until after launch stability" at the
bottom of this file.

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

Do not rebuild the ledger. The future buyer-payment provider must be
implemented as an adapter feeding the existing provider-neutral accounting
system (see above).

Candidates researched so far (informational only — no selection has been
made, and none of this is a build task yet):
- **FasterPay** — Albania accepted in onboarding; marketplace/card/self-
  service onboarding looked promising; final KYB and commercial terms still
  require company registration.
- **POK** — Albanian provider, marketplace support, API/SDK, staging, test
  cards, 3DS, card acquiring; still need to verify ALL-currency semantics,
  refund API, disputes, merchant fees, and settlement terms once Librum has
  a NIPT.
- Other providers may be reconsidered after company registration.

Provider search stays paused until the business-registration gate (Phase 6)
unless explicitly reopened.

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

**Provider/bank-dependent decisions (draft now, confirm only after Phases
6–8):** settlement delay, minimum payout threshold, payout schedule,
supported currencies, payout-failure behavior. These depend on the actual
bank account (Phase 7) and buyer-payment provider (Phase 8) chosen, and a
"decision" made before those exist is a draft, not a lock.

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

## Phase 8 — Resume buyer-payment provider selection

**Status:** BLOCKED (paused until Phase 6; do not resume early without
explicit authorization).
Re-evaluate POK, FasterPay, and other serious candidates using real Librum
company data, against: Albania merchant acceptance, marketplace acceptance,
cards/international buyers, ALL/EUR support, API, staging/sandbox,
webhooks, 3DS, refunds, disputes, settlement, fees/reserves, Albanian bank
settlement, operational self-service. Choose one provider only.

**Completion criteria:** one provider selected, with the evaluation against
every criterion above written down.
**Required evidence:** the comparison record and the final selection
rationale.

## Phase 9 — Integrate the winner into the existing ledger

**Status:** NOT STARTED.
Architecture: Buyer → payment provider → provider adapter → verified
provider facts → `payment_events` → transactional finalizer →
payments/purchases → `author_ledger_entries`.

Rules: no browser success page counts as proof of payment; verification is
server-side only; actual amount and currency must match expected; every
step is idempotent; no partial entitlement/accounting states are ever
observable.

**Completion criteria:** the adapter existing and passing the same
idempotency/verification tests as the existing ledger finalizers.
**Required evidence:** automated tests proving each rule above, plus a
successful staging transaction through the full chain.

## Phase 10 — Complete payment checkout

**Status:** NOT STARTED.
Single-book provider order/checkout/finalization; bundle provider order/
checkout/finalization; receipts/notifications; retry/idempotency testing.

**Completion criteria:** both checkout paths work end-to-end on staging with
the new provider, receipts send, and retries don't double-charge or
double-grant entitlement.
**Required evidence:** staging test transactions for both paths, including
at least one deliberate retry/duplicate-webhook test.

## Phase 11 — Provider-specific refunds

**Status:** NOT STARTED.
Admin approval → provider refund API → provider confirmation → Librum
refund accounting → entitlement update. Keep legacy Stripe refund support
only for historical Stripe transactions as long as required.

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

## Phase 13 — Cut Stripe Connect out of new commerce

**Status:** NOT STARTED. **May be prepared and tested ahead of time, but
production activation waits for the gates below.**
Only after the new provider works (Phases 9–12): remove the
`stripe_payouts_enabled` paid-publishing gate, stop requiring Stripe Connect
author onboarding, retire `/dashboard/payouts` legacy onboarding, activate
the intended bank/payout setup, make the new gateway the only new-sale
path, update dashboard/help/legal copy. Keep required legacy Stripe code
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
