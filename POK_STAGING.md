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

POK major-unit amounts are converted to/from internal hundredths exactly. ALL is
the ledger's frozen currency; no USD-to-ALL exchange is performed. Fixture prices
must be explicitly understood as ALL minor units before testing. The single-book
detail/checkout displays ALL. Author pricing forms and other catalog/report
currency labels still require a separate consistency pass before production use.

## Safety model

A unique mapping claim precedes any provider order request. Duplicate clicks
reuse an already-ready mapping or fail pending; ambiguous creation failures retain
the claim and require reconciliation, never blindly create another payable order.
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
