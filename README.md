# Librum

A self-publishing platform for digital ebooks — authors upload and sell,
readers browse and buy.

Built with Next.js, TypeScript, Tailwind CSS, Supabase (database, auth,
file storage), and Stripe (checkout + author payouts).

> See [`ROADMAP.md`](./ROADMAP.md) for everything left to build.

## What's built so far

- Sign up as an **author** or a **reader**; log in / log out
- Authors upload a book (title, description, price, cover, EPUB file) as
  a draft, then publish it from their dashboard
- The homepage has two tracks: an author-facing pitch at the top (how
  self-publishing works, in four steps, plus a trust strip and a "Start
  publishing" call to action) for logged-out visitors and readers, then
  the reader marketplace below it — a hero section spotlighting the
  newest published book, plus horizontally-scrolling "Bestsellers" (by
  units sold) and "New releases" shelves. The author pitch is skipped
  for anyone already logged in as an author, and for anyone searching
  or filtering by genre (which switches the marketplace to a flat
  results grid), and ends with a "Everything you need to sell your
  book" showcase of the dashboard tools below. Each published book also
  has a detail page, which itself ends with "More by this author" and
  "You might also like" (same genre) shelves
- Drafts show a non-blocking checklist of what's worth adding before
  publishing (description, keywords, a preview excerpt, a price above
  $0) — on the dashboard book list and on the edit page. It's a nudge,
  not a gate: nothing stops you from publishing with any of these left
  incomplete
- The homepage uses real cover art as imagery rather than stock photos —
  a staggered, rotated collage of actual published covers in the author
  pitch hero, and a soft "stacked shelf" of other recent covers behind
  the marketplace's featured book. Small inline icons (no icon library,
  hand-drawn SVGs in `src/components/icons.tsx`) mark the how-it-works
  steps, trust strip, tools showcase, and reader value props. The
  footer is a proper multi-column layout (Platform / Legal) instead of
  a single row of links
- Authors can credit contributors on a book — illustrator, translator,
  narrator, co-author, editor, foreword, or cover designer — from the
  edit page. Just a name and a role, no Librum account required; shown
  on the book page as e.g. "Illustrated by Jane Doe." Purely a credit,
  no payout or account access is tied to it — all money still goes to
  the primary author
- Readers buy a book via **Stripe Checkout**; ownership is recorded once
  payment completes
- Owners (the buyer, or the author) can download the EPUB from the book
  page or from **My Library** — the file lives in private storage, and
  every download request re-checks ownership before streaming it, so
  there's no permanent, guessable URL to the file
- Authors connect a payout account (**Stripe Connect**) from
  **Dashboard > Payouts** before they're allowed to publish. Stripe
  handles identity verification and tax forms. Every sale is split
  automatically — the author's cut goes straight to their bank account,
  Librum keeps a platform fee (20% by default, see `src/lib/pricing.ts`)
- Authors pick a genre when uploading a book; the storefront homepage has
  a search box (matches title/description/keywords) and a genre filter,
  combinable
- Authors can add optional comma-separated keywords when uploading or
  editing a book — searchable like title/description, and shown as tags
  on the book page, for terms readers might search that a single genre
  doesn't capture
- Authors create discount codes per book from **Dashboard > Discounts**
  (percentage or fixed amount off, with an optional expiry date);
  readers enter one at checkout, and it's applied before Stripe splits
  the sale, so the platform fee and author payout are both based on the
  discounted price
- Authors group their books into a **series** with a reading order, from
  **Dashboard > Series** (create the series) and each book's edit page
  (assign it and set its position). A book's page shows the full series
  in order, linking to the other published entries
- Authors have a public profile page (photo, bio, their published books),
  editable from **Dashboard > Profile**; book pages and cards link to it
- Authors can edit a book after publishing (title, description, genre,
  price, cover, manuscript) — replacing the cover or manuscript is
  optional, leave those fields blank to keep the current file
- **Dashboard > Sales** shows net revenue, units sold, a 14-day revenue
  chart, and a per-book breakdown
- Readers who bought a book can leave a star rating and review; the book
  page shows the average rating and every review. Resubmitting updates
  your existing review rather than creating a second one
- **My Library** doubles as order history: purchase date, price paid,
  and a running total spent, alongside each book's download link
- Downloads are watermarked: each EPUB is stamped with the downloader's
  email in its own metadata before being sent, so a leaked copy can be
  traced back to whoever downloaded it. Not DRM — the file still opens
  normally everywhere, nothing is encrypted or locked down
- Purchases trigger two emails (optional — the app works fine without
  this configured): a receipt to the reader, and a sale notification to
  the author
- Forgot-password flow (**/forgot-password**) via Supabase's own reset
  email. Any logged-in user (reader or author) can delete their account
  from **Account** in the nav — this removes their storage files first
  (avatar, and covers/manuscripts for an author's books), then the
  account itself, which cascades through the database
- Readers can save a book to their **Wishlist** instead of buying it
  right away, from the book page or from **Wishlist** in the nav
- Logged-in readers can report a book from a small link on its page.
  Reports are stored in `book_reports` — there's no in-app moderation
  UI yet, so review them directly in Supabase's Table Editor
- Authors can add an optional preview excerpt when uploading or editing
  a book; readers can expand "Look inside" on the book page to read it
  before buying
- Refunding a purchase in Stripe (Dashboard > Payments > find the charge
  > Refund) automatically revokes the reader's access via the webhook —
  the download link and review form disappear, and re-buying the same
  book afterward works normally. Issuing the refund itself is still
  manual; only the "what happens after" part is automated

## One-time setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com), sign up, and click **New
   project**. Pick any name/region and a database password (save it
   somewhere safe).
2. Once the project is ready, go to **Project Settings > API**. You'll
   need three values from this page: the **Project URL**, the **anon
   public** key, and the **service_role** key (keep this last one secret —
   it bypasses all security rules).

### 2. Run the database schema

1. In the Supabase dashboard, open **SQL Editor > New query**.
2. Copy the entire contents of [`supabase/schema.sql`](./supabase/schema.sql)
   from this repo, paste it in, and click **Run**.
3. This creates the `profiles`, `books`, and `purchases` tables, the
   security rules that keep users' data private, and two storage buckets
   (`covers` and `manuscripts`).

   > Already ran an older version of `schema.sql`? Only run the
   > migration files under [`supabase/migrations/`](./supabase/migrations)
   > that came after the version you last ran, in order — each one's
   > comment says what it adds and whether you need it.

### 3. Create a Stripe account (test mode)

1. Go to [stripe.com](https://stripe.com) and sign up — no business
   details needed to use test mode.
2. Go to **Developers > API keys** and copy the **Secret key** (starts
   with `sk_test_...`).
3. Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and run:
   ```bash
   stripe login
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```
   This prints a **webhook signing secret** (starts with `whsec_...`) —
   keep this terminal running whenever you're testing purchases locally,
   it's what delivers the "payment completed" event to your app.
4. Go to **Connect** in the Stripe dashboard sidebar and click through
   the "get started" prompt if you see one. This activates Connect on
   your test account — required before authors can onboard for payouts.
   No real business details are needed in test mode.

### 4. (Optional) Create a Resend account for emails

Skip this if you don't care about purchase receipt / sale notification
emails right now — everything else works fine without it.

1. Go to [resend.com](https://resend.com), sign up, and go to **API
   Keys** to create one.
2. Without verifying your own domain, Resend can only deliver to the
   email address you signed up with — fine for trying this out, but
   means test purchases as a *different* reader account won't actually
   receive a receipt unless that reader's email matches your Resend
   account's email too. Verifying a domain removes this limit.

### 5. Configure environment variables

1. Copy the example env file:
   ```bash
   cp .env.local.example .env.local
   ```
2. Fill in every value in `.env.local` from steps 1–3 above:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   NEXT_PUBLIC_SITE_URL=http://localhost:3000
   RESEND_API_KEY=re_...
   ```
   (leave `RESEND_API_KEY` blank if you skipped step 4)

### 6. Install dependencies and run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign up as an
author, then go to **Dashboard > Payouts** and click **Connect with
Stripe** — Stripe's test-mode onboarding accepts fake data (e.g. phone
verification code `000000`, routing number `110000000`, account number
`000123456789`). Once that's done, publish a book, then sign up as a
reader (or log out) to buy it. On Stripe's checkout page, use test card
`4242 4242 4242 4242`, any future expiry date, and any CVC/ZIP.

> By default, Supabase requires email confirmation before you can log in.
> For local testing, you can turn this off under **Authentication >
> Providers > Email > Confirm email** in the Supabase dashboard, or check
> the inbox of the address you signed up with.

## Project structure

```
src/
  app/
    page.tsx                  storefront homepage
    books/[id]/                 book detail page + buy action
    library/                     a reader's purchased books
    login/, signup/              auth pages
    forgot-password/, reset-password/  password recovery flow
    account/                     delete account (any logged-in user)
    auth/actions.ts               server actions for signup/login/logout/reset
    dashboard/                     author-only area (protected)
      books/                        add/publish/unpublish/delete a book
      payouts/                      Stripe Connect onboarding
    api/webhooks/stripe/            records a purchase once payment completes
    api/books/[id]/download/        issues a short-lived signed download URL
  components/
    site-header.tsx               nav bar, aware of logged-in state
  lib/
    supabase/                      browser/server/middleware/admin clients
    stripe.ts                      Stripe SDK client
    email.ts                       purchase receipt / sale notification emails
    pricing.ts                     platform fee constant/helper
    types.ts                       shared TypeScript types
supabase/
  schema.sql                       full database schema
  migrations/                       incremental changes for existing projects
```
