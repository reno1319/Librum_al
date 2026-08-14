# Dante

A self-publishing platform for digital ebooks — authors upload and sell,
readers browse and buy.

Built with Next.js, TypeScript, Tailwind CSS, Supabase (database, auth,
file storage), and Stripe (checkout + author payouts).

## What's built so far

- Sign up as an **author** or a **reader**; log in / log out
- Authors upload a book (title, description, price, cover, EPUB file) as
  a draft, then publish it from their dashboard
- Public storefront homepage and a book detail page for each published
  book
- Readers buy a book via **Stripe Checkout**; ownership is recorded once
  payment completes

Not built yet: actually downloading/reading a purchased book (Phase 4),
and author payouts (Phase 5).

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

   > Already ran an older version of `schema.sql` before it had a
   > `purchases` table? Just run
   > [`supabase/migrations/002_add_purchases.sql`](./supabase/migrations/002_add_purchases.sql)
   > instead of the whole file again.

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

### 4. Configure environment variables

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
   ```

### 5. Install dependencies and run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign up as an
author, publish a book, then sign up as a reader (or log out) to buy it.
On Stripe's checkout page, use test card `4242 4242 4242 4242`, any
future expiry date, and any CVC/ZIP.

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
    login/, signup/              auth pages
    auth/actions.ts               server actions for signup/login/logout
    dashboard/                     author-only area (protected)
      books/                        add/publish/unpublish/delete a book
    api/webhooks/stripe/            records a purchase once payment completes
  components/
    site-header.tsx               nav bar, aware of logged-in state
  lib/
    supabase/                      browser/server/middleware/admin clients
    stripe.ts                      Stripe SDK client
    types.ts                       shared TypeScript types
supabase/
  schema.sql                       full database schema
  migrations/                       incremental changes for existing projects
```
