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
- **POK** — the only payment provider in the code, sandbox-only for now
  (`src/lib/pok.ts`; see `POK_STAGING.md`). Buying stays off unless the
  server-side checkout flags allow it.
- A cron-driven internal route (`src/app/api/internal/payouts/run/`),
  registered in `vercel.json`: a monthly payout run. Vercel invokes it on
  schedule, but the endpoint itself must stay a no-op unless
  `PAYOUT_SCHEDULER_ENABLED` is explicitly set — the cron existing does
  not by itself mean payout execution is active.

## Payments

- **POK — sandbox only:** new paid checkouts go through POK, and only when
  `NEW_CHECKOUT_REGIME=librum_ledger_v1` and `LEDGER_PAYMENT_PROVIDER=pok`
  are both set (`src/lib/checkout-regime.ts`) and the paid-checkout
  capability allows it (`src/lib/paid-readiness.ts`). Any other
  configuration fails closed: buying is unavailable.
- **Stripe — removed:** the old Stripe Checkout/Connect code, its webhook
  and its nightly reconciliation job are gone. The database still has
  Stripe-era columns and old Stripe test purchases; those are dropped in a
  later database step, and some screens (purchases, refund requests,
  admin Finance) still read them until then.
- **Built, but dormant:** the author bank-destination payout system and
  the monthly payout scheduler, each behind its own fail-closed
  environment flag (`BANK_PAYOUT_SETUP_ENABLED`,
  `PAYOUT_SCHEDULER_ENABLED`). Enabling either is a deliberate, gated
  decision described in `ROADMAP.md`.

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

> **Before you start:** a repository-level guard
> (`src/lib/supabase/env-guard.ts`, PHASE-1A) fails closed against the
> *application itself* (local dev, local builds, tests, and any non-
> Production Vercel deployment) ever connecting to the production
> Supabase project. It does **not** cover ad hoc CLI/admin scripts
> outside the app's own client constructors — those need their own,
> independent target check (see `scripts/staging-fixtures/guard.mts` for
> the one PHASE-1C's staging fixture scripts use). Still verify manually
> that any script or tool you point at Supabase resolves to an isolated
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

### 3. (Optional) Create a Resend account for emails

Skip this if you don't need purchase-receipt / sale-notification emails
locally. Sign up at [resend.com](https://resend.com) and create an API key
under **API Keys**.

### 4. Configure environment variables

```bash
cp .env.local.example .env.local
```

Then fill in `.env.local`. The variable names, verified against
`.env.local.example`, are:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
RESEND_API_KEY=                     # optional — emails are skipped if unset
EMAIL_FROM=                         # optional, defaults to a shared Resend test address
CRON_SECRET=                        # shared secret for the internal cron route
```

### 5. Install dependencies and run

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
      books/[id]/download/, books/[id]/sample/
      internal/payouts/run/
  components/                     shared UI (site header, icons, etc.)
  lib/
    supabase/                       browser/server/middleware/admin clients
    pok.ts, pok-checkout.ts          POK sandbox client + checkout
    checkout-regime.ts               checkout provider selector (POK or disabled)
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
