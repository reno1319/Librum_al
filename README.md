# Dante

A self-publishing platform for digital ebooks — authors upload and sell,
readers browse and buy.

Built with Next.js, TypeScript, Tailwind CSS, Supabase (database, auth,
file storage), and Stripe (checkout + author payouts, added in a later
phase).

## Phase 1 (this version)

- Sign up as an **author** or a **reader**
- Log in / log out (email + password)
- Author dashboard (empty until Phase 2 adds book uploads)
- Public storefront homepage (empty until books are published)

Uploading books, checkout, and payouts are not built yet — that's Phases
2–4.

## One-time setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com), sign up, and click **New
   project**. Pick any name/region and a database password (save it
   somewhere safe).
2. Once the project is ready, go to **Project Settings > API**. You'll
   need two values from this page in a moment: the **Project URL** and
   the **anon public** key.

### 2. Run the database schema

1. In the Supabase dashboard, open **SQL Editor > New query**.
2. Copy the entire contents of [`supabase/schema.sql`](./supabase/schema.sql)
   from this repo, paste it in, and click **Run**.
3. This creates the `profiles` and `books` tables, the security rules
   that keep users' data private, and two storage buckets (`covers` and
   `manuscripts`) for later phases.

### 3. Configure environment variables

1. Copy the example env file:
   ```bash
   cp .env.local.example .env.local
   ```
2. Open `.env.local` and paste in the **Project URL** and **anon public**
   key from step 1:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   ```

### 4. Install dependencies and run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Try signing up as
both a reader and an author to see the different experiences.

> By default, Supabase requires email confirmation before you can log in.
> For local testing, you can turn this off under **Authentication >
> Providers > Email > Confirm email** in the Supabase dashboard, or check
> the inbox of the address you signed up with.

## Project structure

```
src/
  app/
    page.tsx              storefront homepage
    login/, signup/        auth pages
    auth/actions.ts         server actions for signup/login/logout
    dashboard/               author-only area (protected)
  components/
    site-header.tsx         nav bar, aware of logged-in state
  lib/
    supabase/                browser/server/middleware Supabase clients
    types.ts                 shared TypeScript types
supabase/
  schema.sql                 database schema — run this in Supabase
```
