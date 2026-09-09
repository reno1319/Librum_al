# Librum

A self-publishing platform for digital ebooks — authors upload and sell,
readers browse and buy. Built with Next.js, TypeScript, Tailwind CSS, and
Supabase (database, auth, file storage), deployed on Vercel.

**Production deployment (pre-launch):** https://librumal.vercel.app — a
hosted build, not a completed controlled launch (see `ROADMAP.md` Phase 20).

> See [`ROADMAP.md`](./ROADMAP.md) for full status, sequencing, and what's
> still open — this file only covers what exists and how to run it.

## What's built

The core platform is substantially built, not an early MVP:

- **Public storefront** — search, genre/sort/price filters, book detail
  pages, author public profiles, series, bundles, a blog.
- **Author tools** — a step-by-step Publishing Studio (EPUB upload, DOCX
  upload with DOCX→EPUB conversion, EPUB validation, cover uploads, sample
  excerpts, metadata, contributors, series, discount codes, bundles),
  draft/edit/publish/unpublish, a sales dashboard, and a payout balance
  page.
- **Reader tools** — accounts, wishlist, following authors, reviews,
  a library of owned books with watermarked downloads, order history,
  refund requests.
- **Admin/back-office** — staff accounts with role-based access, a report
  moderation queue, a refund queue, finance/reconciliation views, an audit
  log, and a blog CMS.
- **A provider-neutral financial ledger** — `payment_events`, immutable
  `payments`, `author_ledger_entries`, sale/refund accounting primitives,
  transactional book/bundle payment finalizers, and author financial
  reporting, independent of any specific payment provider.
- **An author payout foundation** — bank-destination storage, payout
  eligibility/reservation/batch/reversal logic, and a monthly scheduler —
  built (BUILT/DORMANT), and kept disabled by approved project policy
  until its own roadmap gates are reached (see "Payments" below). Actual
  Vercel Production flag values have not been directly inspected.

For what's still open, see [`ROADMAP.md`](./ROADMAP.md).

## Architecture

- **Next.js** (App Router, Turbopack) — pages and Server Actions under
  `src/app/`, split into a public route group and an `admin` route group.
- **Supabase** — Postgres database, auth, and file storage (covers,
  manuscripts). Row-level security enforces access control; schema lives in
  `supabase/schema.sql` with incremental changes under
  `supabase/migrations/`.
- **Vercel** — hosting and CI/CD. Pushing this branch deploys straight to
  Vercel's Production environment.
- **Stripe** — the legacy, currently-implemented payment/payout
  integration (see "Payments" below for what's implemented, dormant, and
  unverified).
- Cron-driven internal routes (`src/app/api/internal/`), registered in
  `vercel.json`: a daily reconciliation run, and a monthly payout run.
  Vercel invokes the payout endpoint on schedule, but the endpoint itself
  must stay a no-op unless `PAYOUT_SCHEDULER_ENABLED` is explicitly set —
  the cron existing does not by itself mean payout execution is active.

## Payments: implemented, dormant, and legacy paths

Librum has three payment-related code paths, and none of them should be
read as "real-money-ready" without qualification:

- **Legacy Stripe Checkout/Connect — implemented and deployed:** this is
  the currently implemented paid-commerce path. Stripe Checkout handles
  buyer purchases (single book and bundle); Stripe Connect Express is the
  author payout rail, splitting each sale between the author and Librum's
  platform fee (`src/lib/pricing.ts`) via Stripe's own transfer mechanism.
  Paid-book publishing is gated on each author having Stripe Connect
  payouts enabled. This code is deployed and is the application's default
  legacy path unless configuration selects another regime (see the
  ledger_v1 bridge below). **Stripe credential mode (test vs. live) and
  real-money readiness remain unverified from this repository** — don't
  assume confirmed real transactions, real author payouts, or launch
  readiness on that basis. Stripe Connect is also transitional: it is
  **not** Librum's intended final payment architecture (see `ROADMAP.md`'s
  Phases 6–14) — don't build new features assuming it's permanent.
- **Built, but dormant (inactive in production):** a ledger_v1 checkout
  bridge (`src/lib/checkout-regime.ts`) that can route a Stripe-funded
  checkout through the provider-neutral ledger instead of the legacy path;
  the author bank-destination payout system; and the monthly payout
  scheduler. Each sits behind its own fail-closed environment flag
  (`NEW_CHECKOUT_REGIME`, `BANK_PAYOUT_SETUP_ENABLED`,
  `PAYOUT_SCHEDULER_ENABLED`) that defaults to off/legacy when unset in
  code — whether any of them is actually set in Vercel Production has not
  been directly inspected either. Enabling any of this is a deliberate,
  gated decision described in `ROADMAP.md`.

## Authentication

Signup and password-recovery confirmation links work via Supabase Auth's
PKCE `?code=` flow, and the app also supports the direct
`?token_hash=...&type=signup|recovery` verification path — but that second
path is currently **dormant**: Supabase Auth is still on its default email
templates with no custom SMTP configured, so nothing emits a link in that
shape yet. Cross-browser/cross-device email confirmation (the scenario that
path exists for) is not active until custom SMTP and coordinated templates
are configured and tested. See `ROADMAP.md`'s "Current authentication/email
state" for details.

## Local development

> **Before you start:** the hard guard that would refuse to let local
> development or tests run against the *production* Supabase project does
> not exist yet (`ROADMAP.md` Phase 1). Until it does, verify manually,
> every time, that the Supabase project you're pointing at is an isolated
> project of your own — **never the production Supabase ref.**

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com) and create a project. From
**Project Settings > API** you'll need the **Project URL**, the **anon
public** key, and the **service_role** key (server-only — never expose this
to the browser).

### 2. Run the database schema

In the Supabase SQL Editor, run the entire contents of
[`supabase/schema.sql`](./supabase/schema.sql). If you're updating an
existing project instead, only run the migration files under
[`supabase/migrations/`](./supabase/migrations) newer than what you last
applied, in order.

### 3. Create a Stripe account (test mode)

Sign up at [stripe.com](https://stripe.com); no business details are needed
for test mode. From **Developers > API keys**, copy the **Secret key**
(`sk_test_...`). Install the [Stripe CLI](https://docs.stripe.com/stripe-cli)
and run:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

This prints a webhook signing secret (`whsec_...`) — keep this running while
testing purchases locally. Also open **Connect** in the Stripe dashboard
sidebar once to activate it on your test account (required before authors
can onboard for payouts).

### 4. (Optional) Create a Resend account for emails

Skip this if you don't need purchase-receipt / sale-notification emails
locally. Sign up at [resend.com](https://resend.com) and create an API key
under **API Keys**.

### 5. Configure environment variables

```bash
cp .env.local.example .env.local
```

Then fill in `.env.local`. The variable names, verified against
`.env.local.example`, are:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_CONNECT_WEBHOOK_SECRET=      # optional — see .env.local.example
NEXT_PUBLIC_SITE_URL=http://localhost:3000
RESEND_API_KEY=                     # optional — emails are skipped if unset
EMAIL_FROM=                         # optional, defaults to a shared Resend test address
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY= # optional, used from a later phase onward
CRON_SECRET=                        # shared secret for the internal cron routes
```

### 6. Install dependencies and run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Other scripts:

```bash
npm run build   # production build
npm run start   # run a production build locally
npm run lint     # ESLint
npm run test     # vitest run
```

Sign up as an author, go to **Dashboard > Payouts**, and connect a Stripe
test account (test-mode onboarding accepts fake data — e.g. phone code
`000000`, routing number `110000000`, account number `000123456789`).
Publish a book, then buy it as a reader (or logged out) using Stripe's test
card `4242 4242 4242 4242` with any future expiry and any CVC/ZIP.

> Supabase requires email confirmation before login by default. For local
> testing, either disable **Authentication > Providers > Email > Confirm
> email** in the Supabase dashboard, or check the inbox you signed up with.

## Project structure

```
src/
  app/
    (public)/                    public site + author/reader dashboards
      page.tsx                     author-pitch homepage
      bookstore/                   reader storefront
      books/[id]/, bundles/[id]/, series/[id]/, authors/[id]/
      blog/                        public blog
      dashboard/                   author-only area (protected)
        books/, bundles/, discounts/, series/, sales/, balance/, payouts/, profile/
      account/, library/, wishlist/, following/
      auth/, login/, signup/, forgot-password/, reset-password/
    admin/(protected)/            staff-only back office
      staff/, reports/, refunds/, finance/, audit/, blog/
    api/
      webhooks/stripe/              records purchases, drives refund/dispute handling
      books/[id]/download/, books/[id]/sample/
      internal/payouts/run/, internal/reconcile-transfer-reversals/
  components/                     shared UI (site header, icons, etc.)
  lib/
    supabase/                       browser/server/middleware/admin clients
    stripe.ts, connect-account.ts    Stripe SDK client + Connect helpers
    checkout-regime.ts               dormant ledger_v1 checkout-regime selector
    payout-scheduler.ts              dormant payout scheduler logic
    docx-converter.ts                DOCX -> EPUB conversion
    email.ts, pricing.ts, safe-redirect.ts, recovery-session.ts, types.ts
supabase/
  schema.sql                       full database schema
  migrations/                       incremental changes, in order
```

## Notes

This README intentionally doesn't restate the full roadmap — see
[`ROADMAP.md`](./ROADMAP.md) for phase-by-phase status, completion
criteria, and what's explicitly deferred or blocked. No secrets, real
credentials, or private user data are included in this repository's
documentation.
