# POK single-book checkout: staging-only draft

Status: code review and sandbox verification required. Do not merge, deploy,
enable production payments, or interpret unit tests as a successful POK payment.

Fresh local verification (2026-09-15): 140 test files / 2,579 tests passed;
ESLint, TypeScript and `next build` passed. Builds used placeholder credentials
and the isolated staging project URL. No POK API credentials were read or used.

## Scope and isolation

Single paid books use POK hosted SDK orders when both server-side switches select
the ledger regime and POK. Free acquisition is unchanged. Bundles fail closed
rather than silently using Stripe. Legacy Stripe code remains untouched for
existing production behavior; this is not a complete production-provider removal.

The adapter has only `https://api-staging.pokpay.io`. It requires Vercel Preview,
the `staging` Git branch, and Supabase `erhzpapqwyfjotliqdjo`. Production project
`pwkukotgpsegieshulpj` is rejected. Feature-branch previews cannot use this adapter.
These environment checks catch misconfiguration; they are not authentication.

## Configuration after review approval

All variables below belong to **Preview, Git branch staging only**. No credentials
should be sent in chat, committed, made NEXT_PUBLIC, or copied to Production.

| Variable | Value |
| --- | --- |
| POK_MERCHANT_ID | Merchant UUID from the POK staging account; Secret |
| POK_KEY_ID | SDK key identifier from POK staging; Secret |
| POK_KEY_SECRET | SDK secret from POK staging; Secret |
| POK_ENVIRONMENT | staging |
| NEW_CHECKOUT_REGIME | librum_ledger_v1 |
| LEDGER_PAYMENT_PROVIDER | pok |
| NEXT_PUBLIC_SITE_URL | https://librumal-git-staging-reno13dante-2171s-projects.vercel.app |

Credentials are already reported configured; values have not been read here.
New environment values require a new staging deployment, but deployment is a
separate approval step after this PR is reviewed.

## Verified contract and open questions

Official documentation: <https://payments.doc.pokpay.io/>. The documented Postman
collection specifies SDK login, merchant SDK-order creation/retrieval, and hosted
sandbox URLs. Merchant retrieval uses `loadTransaction=true` and bearer auth.
Successful guest-confirm examples contain `capturedAmount`, `autoCapture`,
`isCompleted`, `isCanceled`, `isRefunded`, and `transactionId`.

**Sandbox must confirm those capture/status fields also appear on authenticated
merchant retrieval after a successful hosted payment.** The detailed retrieval
example is unpaid and does not demonstrate them. Missing proof leaves fulfillment
pending; never weaken it to trust the redirect, webhook body, or requested amount.
Only the two documented sandbox checkout hosts are accepted.

**Same open item, for a still-open (never paid) order specifically:** the
checkout-reuse safety check (`classifyProviderAttempt` in `pok-checkout.ts`)
requires an EXPLICIT, literal `capturedAmount: 0` before it will hand an
existing checkout link back out again -- an absent `capturedAmount` blocks,
exactly like a positive one, because the docs never state what omitting the
field means on an order POK still calls open.

**Optional fields, and the exact rule that governs them.** Three response
fields are `optional()` in the schema -- `capturedAmount`, `autoCapture` and
`isCanceled` -- so an absent value is a real wire shape, not a type-system
artifact. The classifier treats absence and contradiction as two different
things, and the ORDER in which it does so is load-bearing:

| evidence | may block a resume | may block a retirement |
| --- | --- | --- |
| explicit contradiction (`transactionId` set, positive `capturedAmount`, `autoCapture === false`) | yes | yes |
| mere absence (`capturedAmount`, `autoCapture` or `isCanceled` missing) | yes | **no** |

An absent optional field means "we cannot prove this order is alive and
untouched", which is reason enough to refuse to hand a payable URL back. It
is NOT a reason to refuse to retire an attempt POK itself reports as
expired. An earlier revision of this classifier tested `autoCapture !== true`
ahead of the expiry rule and so failed that second column: an attempt expired
twelve hours ago became permanently un-retireable because one optional field
was missing -- the exact lockout this repair exists to remove, reintroduced
through a different field. That ordering is now pinned by dedicated tests in
`src/lib/pok-checkout.test.ts`, each of which fails if the old order returns.

Whether a genuinely never-touched sandbox order actually reports
`capturedAmount: 0` or omits the field entirely is UNCONFIRMED; this is a
documented assumption, not a verified contract. If sandbox testing shows real
staging orders omit these fields while still open, resume will keep failing
closed (safe, but readers will be told to wait more often than necessary),
and the check will need a matching, sandbox-confirmed update.

**Sandbox evidence required before controlled staging checkout is enabled.**
Each item is a specific observation, not a general "it worked":

1. An authenticated merchant retrieval of a still-open, never-paid order.
   Record verbatim whether `capturedAmount`, `autoCapture` and `isCanceled`
   are present, and their values.
2. The same retrieval for an order that has EXPIRED unpaid. Record whether
   `expiresAt` is present and parseable, and what the status fields read.
3. The same retrieval for a CANCELLED order.
4. The same retrieval after a successful hosted payment, confirming the
   capture/status fields the fulfilment path depends on.
5. An attempt to pay an order after its reported `expiresAt` plus the
   two-minute margin. This is the one that gates activation: if POK accepts
   it, `POK_EXPIRY_SAFETY_MARGIN_MS` is wrong and retirement is unsafe at
   that value.

Items 1-4 tell us whether the optional-field assumptions above hold. Item 5
bounds the only new risk this repair introduces. Until all five are recorded,
`PAID_CHECKOUT_MODE` stays unset.

**New open item, and the one that gates activation: provider expiry.**
STALE-CHECKOUT-1 retires a dead attempt on the strength of POK's own
`expiresAt` plus a safety margin (`POK_EXPIRY_SAFETY_MARGIN_MS`, currently
two minutes). Two things about that are assumptions, not contract:

- That `expiresAt` comes back parseable on open, cancelled and expired
  orders alike. An unparseable value is treated as ambiguity at any age and
  the attempt can then never be retired, so a persistent response defect
  would reinstate the original lockout for that reader -- confined to that
  one defect, and in the safe direction.
- That POK does not accept a payment after the reported `expiresAt` plus
  that margin. POK publishes no clock-skew, grace or
  "expiry is enforced at capture" statement anywhere in this repository's
  evidence, so two minutes is a chosen value, not a documented one.

The second is the one genuinely new risk this repair introduces: a reader
could hold a replacement quote while a retired attempt is still somehow
payable, and there is no remedy for that without POK refunds. **Controlled
staging checkout stays closed until a sandbox run confirms it.** The margin
is a single named constant precisely so a sandbox-confirmed value can
replace it in one place.

## Stale checkout attempts (STALE-CHECKOUT-1)

Before this repair, a reader whose POK attempt died -- expired, cancelled,
or abandoned mid-creation -- was locked out of buying that book for the full
23-hour life of the intent, because nothing in the system could conclude
"that attempt is dead". Now:

- An intent can be SUPERSEDED (`superseded_at`, `superseded_reason` of
  `quote_stale`, `provider_attempt_retired` or `intent_expired`), and a
  mapping can be RETIRED (`retired_at`, `retired_reason` of
  `provider_attempt_expired`, `provider_attempt_canceled` or
  `provider_window_elapsed_no_order_id`). The two vocabularies share no
  value, so an audit trail never confuses the two lifecycles.
- An attempt WITH a recorded provider order id is retired only after an
  authenticated POK retrieval says it is dead. Librum's own requested
  window (`provider_window_ends_at`) may retire exactly one thing: an
  ID-LESS attempt, whose checkout URL was therefore never disclosed to
  anyone.
- Retirement and supersession happen in ONE transaction, under the
  `(reader, book)` advisory lock, so a dead attempt can never sit attached
  to a live quote.
- A verified payment that arrives on a superseded or retired attempt still
  reaches fulfilment or reconciliation. It is never discarded. Fulfilment
  on a retired mapping emits a `pok_critical` diagnostic, because reaching
  that line means the retirement classifier was wrong.
- A quote whose economics changed while an attempt may still be live is
  never silently re-priced. The reader is shown the FROZEN amount, told the
  new price or code is not applied, and offered resuming as a separate
  deliberate action bound to that exact intent id.

What this closes from the checklist below: the "double-click checkout"
and "canceled/failed/unpaid" cases now have defined, tested outcomes rather
than a permanent block. What it does NOT close: refunds, disputes and
operator reconciliation tooling remain unimplemented, and the expiry
assumption above must be confirmed in sandbox before paid checkout is
enabled at all.

POK major-unit amounts are converted to/from internal hundredths exactly. ALL is
the ledger's frozen currency; no USD-to-ALL exchange is performed. Fixture prices
must be explicitly understood as ALL minor units before testing. The single-book
detail/checkout displays ALL. Author pricing forms and other catalog/report
currency labels still require a separate consistency pass before production use.

## Safety model

A unique mapping claim precedes any provider order request, and the window
POK is asked for is computed and returned by SQL, so one clock governs both
the stored window and the duration requested. The provider order id is
persisted immediately after creation, with a bounded retry, and no checkout
URL is ever returned before that write succeeds -- an order Librum cannot
name is an orphan it cannot retire. Duplicate clicks reuse an already-ready
mapping or report in-progress; ambiguous creation failures retain the claim
and require reconciliation, never blindly create another payable order.
Existing intents linked to Stripe are refused on POK creation. Drain old Stripe
attempts before enabling this switch; there is no cross-provider atomic migration
or completed operator reconciliation tool in this first phase.

Callbacks are wake-up signals only. A per-order UUID token is checked, then the
server retrieves POK's merchant order and matches order, merchant, reference,
currency, and actual captured amount to the frozen intent. Browser returns also
require the original reader's authenticated session and recovery-session guard.
No card information enters Librum.

Only verified payments invoke `finalize_ledger_book_payment`, which atomically
checks frozen economics and commits entitlement/payment/ledger state. Retries
share a deterministic event identity. Because POK's example does not document a
payment-success timestamp, accounting uses the durable first verified event
observation time, not order creation time. Confirm whether POK can provide an
authoritative payment time before finalizing production accounting semantics.

Migration `20260914225408_pok_book_checkout_orders.sql` is restored from the
existing isolated staging migration history, not newly applied. The schema mirror
contains the same statements. No database writes were performed for this rebuild.

Migration `20260920081304_stale_checkout_attempt_repair.sql` adds the
supersession and retirement lifecycle described above, and moves the
`(reader, book)` advisory lock ahead of the intent row lock in both
`finalize_book_checkout_intent_entitlement_core` and its
`finalize_ledger_book_payment` wrapper. That second move is not cosmetic:
with the row lock taken first, retiring an attempt and finalizing a payment
for it reach for the same two locks in opposite orders and deadlock.
`supabase/tests/059_retire_vs_finalize_contention.sh` constructs that cycle
deterministically rather than racing for it.

## Sandbox checklist after explicit deployment approval

1. Review this draft, particularly the API proof fields, ALL prices, and scope.
2. Confirm POK keys belong to staging, webhook access is not blocked by deployment
   protection, and old Stripe attempts are drained. Do not remove existing secrets.
3. Enable the staging-only switches, deploy staging, then verify fixed guards.
4. Create a small ALL-priced fixture order and verify hosted sandbox URL, price,
   merchant reference and callback destinations. Never use a real card.
5. Complete a POK-documented sandbox payment; confirm authenticated retrieval proof,
   owned-book state, library download, one purchase/payment, and ledger economics.
6. Replay webhook/return callbacks and double-click checkout: no duplicate orders,
   purchases or financial entries. Test canceled/failed/unpaid and mismatched cases.
7. Document ambiguous-order reconciliation and refund/dispute handling separately.
   Refunds, disputes, payouts, bundles, purchase-receipt emails, production POK
   and FX are not implemented. Provider webhook retries are not assumed to be
   guaranteed; confirm delivery/retry behavior with POK during sandbox testing.

Stop before any production changes. Passing this checklist does not by itself
authorize production migration.
