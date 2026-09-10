# Staging fixtures (PHASE-1C)

**STAGING ONLY. Never run any of this against production.** Every script
here independently rejects the production Supabase ref
(`pwkukotgpsegieshulpj`) before constructing any client, and only accepts
the one approved staging ref (`erhzpapqwyfjotliqdjo`) — see `guard.mts`.
This is a *separate* guard from the application's own
`src/lib/supabase/env-guard.ts`, which protects the app itself but does
**not** protect ad hoc CLI scripts like these (it trusts Vercel platform
markers a locally-run script never has) — see the PHASE-1C design report
for the full reasoning.

## Status

As of this commit, the real `@supabase/supabase-js` client wiring
(`live-deps.mts`) is implemented — `seed.mts`'s and `reset.mts`'s CLI
entry points will actually construct a real admin client and attempt a
real run if invoked with `npm run staging:fixtures:*`. **This wiring has
not been executed or tested against any real project in this
repository's history** — no staging credentials were available or used
during its implementation, and it has never been run to completion
against real staging data. What HAS now been verified with a real,
unmodified Node process (not just type-checking/code review, and not
just vitest's compiled-TypeScript environment — see the "Runtime"
section below for why that distinction matters): the entire runtime
import graph parses and loads cleanly end-to-end under Node's own
native `--experimental-strip-types`, with no CLI entry point ever
firing, no client ever constructed, and no credential ever read. That
is a necessary precondition for `npm run staging:fixtures:*` to even
start, not a substitute for actually running it. Treat the actual
seed/reset/teardown behavior as unproven until a human runs it
deliberately, with real staging credentials, outside of an automated
pass. The orchestration logic itself (`runSeed`,
`runPreflight`, `runReset`, and every safety check they call) is, by
contrast, fully implemented and unit-tested against injected fakes with
zero network access — see `*.test.ts` next to each module — and that
part's correctness does not depend on `live-deps.mts` at all.

## What this creates

A small, fixed, idempotent set of synthetic staging data: one author,
one reader, a series, a bundle, and five books (see `manifest.mts` for
the exact set and why each one is shaped the way it is — in particular,
why the draft-publish and unpublish/republish target books are free, and
why the discount code lives on a book the reader does not already own).
Every book gets a real, `validateEpubStructure()`-passing manuscript and
a real cover image uploaded to Storage — never a bare database row with
a fake path.

## Commands

- **`npm run staging:fixtures:seed`** — create or converge the baseline.
  **Run this only for initial fixture setup or a deliberate, intentional
  reset of the baseline's own fields.** It overwrites the fixture
  accounts' passwords, confirmation/ban state, metadata, every baseline
  book's fields, and every baseline storage object's bytes —
  unconditionally, every run. **Do not run it during an active QA
  journey** (it will clobber whatever you're mid-way through testing),
  and never run it (or any command below) **while another person is
  signed into the fixture accounts in a browser** — see "Session safety"
  below.
- **`npm run staging:fixtures:reset`** (reset-to-baseline) — between
  repeatable QA passes. Deletes every fixture-linked baseline AND
  transient row (anything QA created that's owned by the fixture
  accounts) and every fixture-linked storage object, then re-seeds the
  baseline. **Preserves the two Auth users** (their IDs, so anything
  that referenced them by ID stays valid) — see the design report for
  why this must never delete/recreate them on every reset.
- **`npm run staging:fixtures:teardown`** — full removal, including the
  two Auth users themselves. Rare. Requires a **stronger** typed
  confirmation than reset-to-baseline (see below). Never re-seeds
  anything.

Both `reset` and `teardown` require typed, exact confirmation read from
stdin before touching anything:
- reset-to-baseline: type the staging ref exactly (`erhzpapqwyfjotliqdjo`).
- teardown: type the staging ref plus the literal word `TEARDOWN`
  (`erhzpapqwyfjotliqdjo TEARDOWN`).

## Session safety (Auth deletion does not mean instant logout)

Deleting a fixture Auth user (`teardown` only) immediately blocks that
account from refreshing its session, but does **not** immediately
invalidate an already-issued access token — Supabase access tokens are
stateless JWTs, valid on signature + expiry alone, independent of
whether the underlying user still exists. A token issued minutes before
a `teardown` run can remain formally valid for the rest of its own
lifetime. This is low-risk here (everything that token could act on is
gone the moment the delete completes) but is **not** an instant global
logout — never run `reset`/`teardown` while a human is actively using
the fixture accounts.

## Credentials

Required environment variables (never committed, never logged — see
`.env.local.example`'s existing `.env*` gitignore coverage, which
already covers a local `.env.staging.local` file):

- `STAGING_FIXTURE_SUPABASE_URL` — must resolve to the staging ref.
- `SUPABASE_SERVICE_ROLE_KEY` (staging project's own service-role key —
  never the production one).
- `STAGING_FIXTURE_AUTHOR_PASSWORD`, `STAGING_FIXTURE_READER_PASSWORD`.

Loaded via Node's native `--env-file=.env.staging.local` (see
`package.json`'s `staging:fixtures:*` scripts) — no `dotenv` dependency.
**Deliberately `--env-file`, not `--env-file-if-exists`:** every fixture
command fails immediately (`node: .env.staging.local: not found`, exit
code 9 — confirmed directly against the installed Node version) if that
exact file is missing, rather than silently falling back to whatever
happens to already be set in the ambient shell environment (which could
be `.env.local`, another project's variables, or nothing at all). The
staging-ref allowlist and unconditional production-ref rejection in
`guard.mts` still run as their own, independent check — the required env
file is an *additional* protection layered on top of that, never a
substitute for it.

## Runtime

Plain `node --experimental-strip-types` against `.mts` files — no `tsx`,
no `ts-node`, no new dependency. Requires Node ≥ 22.6 — verified
directly against Node v22.6.0 (the documented minimum), v22.22.2, and
v26.7.0; the minimum stands as originally documented and did not
need revising.

**Correction:** an earlier version of this section claimed a "probe"
had confirmed this runtime path worked. That claim was false in a way
that mattered: the first actual local invocation
(`npm run staging:fixtures:seed`) failed immediately with
`SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter
property is not supported in strip-only mode`, in `auth-ownership.mts`'s
`FixtureProfileMissingError` constructor (a second instance existed in
`reset.mts`'s `PreflightHardStopError`). Node's `--experimental-strip-types`
only ever supports *erasable* TypeScript syntax — a parameter property
(`constructor(public readonly x: string, ...)`) both declares a field
and assigns it, so it requires real code generation and is rejected
outright. Whatever "probe" produced the original claim never actually
ran this exact command against this exact code with a real,
unmodified Node process — vitest's own test suite always passed, but
vitest transforms `.mts`/`.ts` files with vite/esbuild first, which
fully compiles parameter properties and therefore could never have
caught this.

Both classes have been rewritten as an ordinary field declaration plus
constructor assignment (identical public, readonly, externally-visible
shape — `err.authUserId` / `err.table` behave exactly as before). The
whole runtime import graph (every `.mts` file in this directory, plus
the one external dependency, `../../src/lib/supabase/env-guard.ts`) was
re-audited for every other non-erasable construct — enums, namespaces,
`import ... = require(...)`, decorators, and any other parameter
property — and none were found. This is now enforced permanently, not
just re-checked once: `runtime-smoke.test.ts` spawns a real,
unmodified Node process (whatever Node is running the suite) with
`--experimental-strip-types` and imports `seed.mts`, `reset.mts`, and
`live-deps.mts` (which together pull in every other file in this
directory), so any future reintroduction of non-erasable syntax fails
`npm run test` immediately — it does not depend on a human remembering
to probe this path by hand again.

## Why no `@/`-aliased imports here

`tsconfig.json`'s `"paths": {"@/*": ["./src/*"]}` is a TypeScript-
compiler/bundler-only construct — plain Node has no knowledge of it.
Every module in this directory either has zero imports of its own
(`manifest.mts`'s byte-builders duplicate, rather than import, the
app's existing test-fixture patterns) or imports the one dependency-free
app module (`env-guard.ts`) via a relative path with an explicit `.ts`
extension. The real EPUB validator is exercised in `manifest.test.ts`,
which runs under vitest (where the `@/` alias resolves correctly) —
never at runtime by `seed.mts` itself.

## Protected data

`reset`/`teardown` never touch payment, payout, ledger, staff, blog, or
immutable-snapshot tables — any non-zero row found there for the fixture
accounts is a **preflight hard-stop**, checked before any mutation at
all, not a late failure. See `dispositions.mts` for the exact,
per-table ID traversal used for every check (never a title/email
substring/path-prefix match), and the design report's recovery/
escalation procedure for what to do if one fires.

3 of these tables (`author_payout_destinations`,
`payout_destination_snapshots`, `payout_reversal`) have `revoke all ...
from anon, authenticated, service_role` — the fixture scripts' own
service-role client has zero grant on them, so they cannot be counted
via a direct REST query. They are checked via
`public.staging_fixture_protected_table_counts(uuid)`, a narrowly
scoped, count-only, `SECURITY DEFINER` RPC added by **migration 057**
(`supabase/migrations/057_staging_fixture_protected_table_counts.sql`).
It discloses nothing but a row count per table, is `EXECUTE`-granted
**only** to `service_role`, and does not weaken any of the 3 tables'
own grants. **Migration 057 must be applied to the staging project
before `reset`/`teardown` will pass preflight** — until it is, calling
the RPC fails outright (a real error, not a silent zero), which
`countRowsMatchingTraversal` propagates as a genuine preflight failure
rather than a false "no rows" pass. See that migration's own comment
for the full design rationale, and
`supabase/tests/057_staging_fixture_protected_table_counts.test.sql`
for its custom SQL assertion-based regression suite (matching this
repository's own migrations 037/048-056 test convention — a plain
`pg_temp.assert()` helper plus `set local role`/`do $$ ... $$` blocks,
**not** the pgTAP extension). Run and passed, along with a set of
direct standalone privilege queries, against a disposable local
PostgreSQL 16 instance — see PHASE-1C's round-5 REVIEW-REPORT.txt for
the exact commands and output.

## External identity state (avatar, Stripe Connect)

- `avatar_path` has a defined safe baseline: **absent** (`null`).
  `seed` converges it back to `null` for both fixture accounts on every
  run, and `reset`/`teardown` remove any actual avatar Storage object
  found under **either** account's own namespace (not just the
  author's) as part of the normal Storage cleanup plan — including the
  **reader's own `manuscripts/<readerId>/tmp/avatar/...` temp-staging
  path**, not just the finalized `avatars/<id>/avatar.<ext>` object.
  `avatar-field.tsx` stages every avatar upload (author or reader) in
  the private `manuscripts` bucket first, confirmed directly against
  source — the public `avatars` bucket only ever receives the
  already-validated, finalized object.
- `stripe_account_id` / `stripe_payouts_enabled` have **no** defined
  safe reset policy — a non-null `stripe_account_id` or
  `stripe_payouts_enabled = true` is real external Stripe Connect state
  this design has no reviewed procedure for touching. `seed` checks
  this during its initial, read-only discovery phase, for any account
  found to already exist — before any mutation of any kind, including
  repairing an orphaned OTHER account. `reset`/`teardown`'s entire
  preflight is read-only already, so the same check there is simply
  part of that. Either hard-stops immediately if violated, rather than
  silently overwriting or ignoring it.
