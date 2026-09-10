// PHASE-1C mandatory correction, item 1: the REAL CLI wiring.
//
// This module constructs an actual @supabase/supabase-js service-role
// admin client and implements every SeedDeps/Deps function against it.
// It is imported ONLY from seed.mts's and reset.mts's own
// `if (import.meta.url === ...)` CLI-entry-point blocks -- never from
// any test file, and never executed in this session (no
// `npm run staging:fixtures:*` command was run; see REVIEW-REPORT.txt).
//
// Every exported function/query here was written against method
// signatures traced directly from installed source
// (@supabase/auth-js's GoTrueAdminApi/errors, @supabase/storage-js's
// StorageFileApi) during the PHASE-1C design review -- cited inline
// wherever a shape came from a specific file, not memory.
//
// PHASE-1C review round 4, item 3: this module imports ONLY from
// "@supabase/supabase-js" -- the repo's one real, declared, direct
// Supabase dependency (package.json) -- and never from
// "@supabase/storage-js" directly, even though that package is
// PHYSICALLY present in node_modules today (as @supabase/supabase-js's
// own transitive dependency, pinned to the exact same version). A
// direct import from an undeclared package is fragile: npm gives no
// guarantee that a future @supabase/supabase-js version keeps resolving
// the same storage-js version, or vendors/inlines it, or drops the
// dependency entirely -- none of that would be caught by this repo's
// own dependency graph, since nothing here declares the need. Where a
// storage-js-shaped error needs inspecting (getStorageObjectSizeImpl
// below), a narrow STRUCTURAL check against the one documented,
// version-stable field (`status`, the raw HTTP status code) is used
// instead of importing the library's own `StorageApiError`/
// `isStorageError` helpers.
import { createClient, isAuthApiError, type SupabaseClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { assertStagingTargetFromEnv } from "./guard.mts";
import type { SeedDeps } from "./seed.mts";
import type { Deps as ResetDeps, FixtureContext, ProfileExternalState } from "./reset.mts";
import type { FixtureAuthUser, ListUsersFn } from "./auth-ownership.mts";
import type { FixtureStorageBucket } from "./storage-keys.mts";
import { rpcOnlyProtectedTables, type FixturePurchaseRow } from "./dispositions.mts";
import type { FixtureBundleMembership } from "./manifest.mts";

// ============================================================
// Required env vars -- validated present AND non-empty here, distinct
// from (and in addition to) the staging-ref guard, which only validates
// the URL's shape/ref.
// ============================================================
const REQUIRED_ENV_VARS = [
  "STAGING_FIXTURE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STAGING_FIXTURE_AUTHOR_PASSWORD",
  "STAGING_FIXTURE_READER_PASSWORD",
] as const;

export class MissingRequiredEnvVarError extends Error {}

function requireEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    // Never includes any OTHER variable's value -- only the name of the
    // one that's missing.
    throw new MissingRequiredEnvVarError(`Required environment variable ${name} is missing or empty.`);
  }
  return value;
}

function validateRequiredEnv(): void {
  for (const name of REQUIRED_ENV_VARS) requireEnv(name);
}

// ============================================================
// Client construction: guard first, then (and only then) every env var
// validated, then (and only then) the client is constructed. Matches
// PHASE-1C item 1 exactly: "Run the staging guard before constructing a
// Supabase client. Construct a service-role client only after the guard
// succeeds."
// ============================================================
function buildAdminClient(): SupabaseClient {
  assertStagingTargetFromEnv();
  validateRequiredEnv();
  const url = requireEnv("STAGING_FIXTURE_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function toFixtureAuthUser(u: { id: string; email?: string | null; app_metadata?: Record<string, unknown> | null; last_sign_in_at?: string | null }): FixtureAuthUser {
  return { id: u.id, email: u.email, app_metadata: u.app_metadata, last_sign_in_at: u.last_sign_in_at };
}

// ============================================================
// Shared helpers used by both SeedDeps and ResetDeps.
// ============================================================
function makeListUsers(client: SupabaseClient): ListUsersFn {
  return async ({ page, perPage }) => {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    return { users: data.users.map(toFixtureAuthUser) };
  };
}

async function getProfileByIdImpl(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("profiles")
    .select("role, display_name, public_author_name, bio")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertProfileImpl(
  client: SupabaseClient,
  id: string,
  fields: { role: string; display_name: string; public_author_name: string | null; bio: string | null },
) {
  const { data, error } = await client
    .from("profiles")
    .update(fields)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return { affectedRows: data?.length ?? 0 };
}

// PHASE-1C review round 3, item 6.
async function getProfileExternalStateImpl(client: SupabaseClient, id: string): Promise<ProfileExternalState> {
  const { data, error } = await client
    .from("profiles")
    .select("avatar_path, stripe_account_id, stripe_payouts_enabled")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { avatarPath: null, stripeAccountId: null, stripePayoutsEnabled: false };
  }
  return {
    avatarPath: (data.avatar_path as string | null) ?? null,
    stripeAccountId: (data.stripe_account_id as string | null) ?? null,
    stripePayoutsEnabled: data.stripe_payouts_enabled === true,
  };
}

// PHASE-1C review round 3, item 6.
async function convergeProfileAvatarBaselineImpl(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("profiles").update({ avatar_path: null }).eq("id", id);
  if (error) throw error;
}

// ---- Small, error-propagating query helpers -- PHASE-1C review round
// 3, item 3: several prerequisite sub-queries in an earlier draft
// silently discarded `error` and defaulted to `[]` on failure, which
// would make a real query failure look identical to "no rows found" --
// exactly backwards for a safety-critical read. Every helper below
// throws on any error instead. ----
async function selectIdsWhereEq(client: SupabaseClient, table: string, column: string, value: string): Promise<string[]> {
  const { data, error } = await client.from(table).select("id").eq(column, value);
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => r.id);
}

async function selectIdsWhereIn(client: SupabaseClient, table: string, column: string, values: readonly string[]): Promise<string[]> {
  if (values.length === 0) return [];
  const { data, error } = await client.from(table).select("id").in(column, values as string[]);
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => r.id);
}

async function selectIdsWhereOr(client: SupabaseClient, table: string, orClause: string): Promise<string[]> {
  const { data, error } = await client.from(table).select("id").or(orClause);
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => r.id);
}

async function authorBookIdsOrThrow(client: SupabaseClient, authorId: string): Promise<string[]> {
  return selectIdsWhereEq(client, "books", "author_id", authorId);
}

async function authorBundleIdsOrThrow(client: SupabaseClient, authorId: string): Promise<string[]> {
  return selectIdsWhereEq(client, "bundles", "author_id", authorId);
}

function readerOrAuthorBooksClause(readerId: string, readerColumn: string, bookIds: readonly string[]): string {
  return bookIds.length > 0
    ? `${readerColumn}.eq.${readerId},book_id.in.(${bookIds.join(",")})`
    : `${readerColumn}.eq.${readerId}`;
}

// ============================================================
// PHASE-1C review round 3, item 4: a single generic, genuinely read-only
// "SELECT id FROM <table> WHERE <traversal>" per table, matching
// dispositions.mts's documented traversal exactly (including the item 1
// fix: bundle_checkout_reservations has NO reader_id column -- confirmed
// directly against schema.sql, columns are only id, snapshot_id,
// book_id, created_at -- so it must never be grouped with
// book_checkout_intents' reader_id-inclusive query). Used both to freeze
// ApprovedPlan.deletionTargets during preflight AND to re-discover
// current state during postcondition verification -- it never mutates
// anything.
// ============================================================
async function discoverFixtureLinkedRowIdsImpl(client: SupabaseClient, table: string, ctx: FixtureContext): Promise<string[]> {
  switch (table) {
    case "series":
    case "books":
    case "bundles":
    case "discount_codes":
      return selectIdsWhereEq(client, table, "author_id", ctx.authorId);

    case "bundle_checkout_reader_holds":
    case "refund_requests":
      return selectIdsWhereEq(client, table, "reader_id", ctx.readerId);

    // PHASE-1C review round 3, item 1: bundle_checkout_reservations has
    // ONLY id, snapshot_id, book_id, created_at -- book_id-only, exactly
    // like refund_request_items, never grouped with a reader_id filter.
    case "bundle_checkout_reservations":
    case "refund_request_items": {
      const bookIds = await authorBookIdsOrThrow(client, ctx.authorId);
      return selectIdsWhereIn(client, table, "book_id", bookIds);
    }

    case "book_checkout_intents":
    case "reviews":
    case "wishlist_items": {
      const bookIds = await authorBookIdsOrThrow(client, ctx.authorId);
      return selectIdsWhereOr(client, table, readerOrAuthorBooksClause(ctx.readerId, "reader_id", bookIds));
    }

    case "book_reports": {
      const bookIds = await authorBookIdsOrThrow(client, ctx.authorId);
      return selectIdsWhereOr(client, table, readerOrAuthorBooksClause(ctx.readerId, "reporter_id", bookIds));
    }

    case "author_follows":
      return selectIdsWhereOr(client, table, `follower_id.eq.${ctx.readerId},author_id.eq.${ctx.authorId}`);

    case "purchases": {
      const bookIds = await authorBookIdsOrThrow(client, ctx.authorId);
      return selectIdsWhereOr(client, table, readerOrAuthorBooksClause(ctx.readerId, "reader_id", bookIds));
    }

    // Not "delete"-disposition tables (they cascade), but still
    // BASELINE_RESEEDED_TABLES that reset.mts's postcondition must be
    // able to re-discover.
    case "book_contributors": {
      const bookIds = await authorBookIdsOrThrow(client, ctx.authorId);
      return selectIdsWhereIn(client, table, "book_id", bookIds);
    }
    case "bundle_books": {
      const bundleIds = await authorBundleIdsOrThrow(client, ctx.authorId);
      return selectIdsWhereIn(client, table, "bundle_id", bundleIds);
    }

    default:
      throw new Error(`discoverFixtureLinkedRowIdsImpl: no live query mapping implemented for table "${table}".`);
  }
}

// Deletes EXACTLY the given ids -- never re-derives "current matches"
// from ctx (PHASE-1C review round 3, item 4).
async function deleteByIdsImpl(client: SupabaseClient, table: string, ids: readonly string[]): Promise<{ deletedCount: number }> {
  if (ids.length === 0) return { deletedCount: 0 };
  const { data, error } = await client.from(table).delete().in("id", ids as string[]).select("id");
  if (error) throw error;
  return { deletedCount: data?.length ?? 0 };
}

function countOf(promise: Promise<{ count: number | null; error: unknown }>): Promise<number> {
  return promise.then(({ count, error }) => {
    if (error) throw error;
    return count ?? 0;
  });
}

// PHASE-1C review round 4, item 4: author_payout_destinations,
// payout_destination_snapshots, and payout_reversal have zero
// service-role grant on the table itself (schema.sql) -- a direct REST
// count is structurally impossible. This calls the narrowly scoped,
// count-only, SECURITY DEFINER RPC `public.staging_fixture_protected_
// table_counts(p_author_id)` instead (migration 057): it runs with its
// OWNING role's privilege (never the caller's), discloses nothing but a
// row count per table, and is EXECUTE-granted ONLY to service_role
// (revoked from public/anon/authenticated -- see the migration itself).
// This is the real replacement for round 3's rejected "human
// attestation boolean" workaround -- it actually obtains the count.
// PHASE-1C review round 4, item 4's own regression finding: the earlier
// implementation trusted the RPC's response shape completely (a
// permissive `Number(row.row_count)` on whatever rows came back). A
// buggy/compromised/mismigrated function body could return a row for
// the wrong table, silently drop one of the 3 required rows, return a
// row twice, or return a non-numeric/negative/fractional/NaN count --
// every one of those must be a hard failure, never coerced into a
// plausible-looking number. `EXPECTED_RPC_PROTECTED_TABLE_NAMES` is
// derived from dispositions.mts's own rpcOnlyProtectedTables(), never a
// second, independently-maintained literal list.
const EXPECTED_RPC_PROTECTED_TABLE_NAMES = new Set(rpcOnlyProtectedTables("resetToBaseline"));

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

async function fetchRpcProtectedTableCounts(client: SupabaseClient, authorId: string): Promise<Record<string, number>> {
  const { data, error } = await client.rpc("staging_fixture_protected_table_counts", { p_author_id: authorId });
  if (error) throw error;

  const rows = data ?? [];
  if (!Array.isArray(rows)) {
    throw new Error(
      "staging_fixture_protected_table_counts: expected an array of rows, got " +
        `${typeof rows} -- refusing to trust this response.`,
    );
  }

  const counts: Record<string, number> = {};
  const seenTableNames = new Set<string>();
  for (const rawRow of rows) {
    if (rawRow === null || typeof rawRow !== "object") {
      throw new Error(
        `staging_fixture_protected_table_counts: malformed row (expected an object, got ${typeof rawRow}).`,
      );
    }
    const tableName = (rawRow as { table_name?: unknown }).table_name;
    if (typeof tableName !== "string" || !EXPECTED_RPC_PROTECTED_TABLE_NAMES.has(tableName)) {
      throw new Error(
        `staging_fixture_protected_table_counts: unexpected table_name ${JSON.stringify(tableName)} returned -- ` +
          `expected exactly one of: ${[...EXPECTED_RPC_PROTECTED_TABLE_NAMES].join(", ")}.`,
      );
    }
    if (seenTableNames.has(tableName)) {
      throw new Error(`staging_fixture_protected_table_counts: duplicate row for table_name "${tableName}".`);
    }
    seenTableNames.add(tableName);

    // Postgres bigint columns are commonly returned as strings by JS
    // clients to avoid silent precision loss above 2^53 -- accepted
    // here ONLY as a well-formed integer string, never coerced from an
    // arbitrary type via a bare Number(...) call.
    const rawCount = (rawRow as { row_count?: unknown }).row_count;
    const numericCount = typeof rawCount === "string" && /^\d+$/.test(rawCount) ? Number(rawCount) : rawCount;
    if (!isFiniteNonNegativeInteger(numericCount)) {
      throw new Error(
        `staging_fixture_protected_table_counts: row_count for "${tableName}" is not a finite, nonnegative ` +
          `integer (got ${JSON.stringify(rawCount)}).`,
      );
    }
    counts[tableName] = numericCount;
  }

  const missingTableNames = [...EXPECTED_RPC_PROTECTED_TABLE_NAMES].filter((t) => !seenTableNames.has(t));
  if (missingTableNames.length > 0) {
    throw new Error(
      `staging_fixture_protected_table_counts: missing expected row(s) for: ${missingTableNames.join(", ")}.`,
    );
  }

  return counts;
}

// ============================================================
// Every hard_stop (protected) table is reachable here -- the 3 zero-
// grant payout tables route through fetchRpcProtectedTableCounts()
// above instead of a direct REST count, but the caller (reset.mts)
// makes no distinction: every protectedTables() entry is checked in one
// uniform loop. payment_disputes and payment_refunds join through the
// fixture-linked purchases' OWN real values (never a hardcoded
// placeholder), and every prerequisite sub-query throws on error
// instead of silently defaulting to `[]`.
// ============================================================
async function countRowsMatchingTraversalImpl(client: SupabaseClient, table: string, ctx: FixtureContext): Promise<number> {
  switch (table) {
    case "author_payout_destinations":
    case "payout_destination_snapshots":
    case "payout_reversal": {
      const counts = await fetchRpcProtectedTableCounts(client, ctx.authorId);
      if (!(table in counts)) {
        throw new Error(
          `countRowsMatchingTraversalImpl: staging_fixture_protected_table_counts() returned no row ` +
            `for table "${table}" -- refusing to treat a missing row as a trustworthy zero.`,
        );
      }
      return counts[table];
    }
    case "payments":
      return countOf(
        client.from("payments").select("id", { count: "exact", head: true }).eq("buyer_id", ctx.readerId) as unknown as Promise<{ count: number | null; error: unknown }>,
      );
    case "author_payouts":
    case "author_ledger_entries":
    case "author_payout_settings":
      return countOf(
        client.from(table).select("*", { count: "exact", head: true }).eq("author_id", ctx.authorId) as unknown as Promise<{ count: number | null; error: unknown }>,
      );
    case "staff_members":
      return countOf(
        client.from(table).select("*", { count: "exact", head: true }).or(`user_id.eq.${ctx.authorId},user_id.eq.${ctx.readerId}`) as unknown as Promise<{ count: number | null; error: unknown }>,
      );
    case "blog_posts":
      return countOf(
        client.from(table).select("*", { count: "exact", head: true }).eq("created_by", ctx.authorId) as unknown as Promise<{ count: number | null; error: unknown }>,
      );
    case "bundle_checkout_snapshots": {
      const bundleIds = await authorBundleIdsOrThrow(client, ctx.authorId);
      const clauses = [`author_id.eq.${ctx.authorId}`, `reader_id.eq.${ctx.readerId}`, ...bundleIds.map((id) => `bundle_id.eq.${id}`)];
      return countOf(
        client.from(table).select("*", { count: "exact", head: true }).or(clauses.join(",")) as unknown as Promise<{ count: number | null; error: unknown }>,
      );
    }
    case "refund_issuance_attempts": {
      const refundRequestIds = await selectIdsWhereEq(client, "refund_requests", "reader_id", ctx.readerId);
      if (refundRequestIds.length === 0) return 0;
      return countOf(
        client.from(table).select("*", { count: "exact", head: true }).in("refund_request_id", refundRequestIds) as unknown as Promise<{ count: number | null; error: unknown }>,
      );
    }
    // PHASE-1C review round 3, item 3: both halves of the OR are
    // required -- a purchase of a fixture-author's book by an unrelated
    // reader would otherwise be missed by a reader_id-only check.
    case "payment_refunds": {
      const bookIds = await authorBookIdsOrThrow(client, ctx.authorId);
      const purchaseIds = await selectIdsWhereOr(client, "purchases", readerOrAuthorBooksClause(ctx.readerId, "reader_id", bookIds));
      if (purchaseIds.length === 0) return 0;
      return countOf(
        client.from(table).select("*", { count: "exact", head: true }).in("purchase_id", purchaseIds) as unknown as Promise<{ count: number | null; error: unknown }>,
      );
    }
    // PHASE-1C review round 3, item 3: no real FK exists (keyed only by
    // text stripe_payment_intent_id) -- joined through the fixture-
    // linked purchases' OWN real stripe_payment_intent_id values, never
    // hardcoded to the synthetic fixture constant (a hardcoded-zero
    // check cannot detect a real dispute against a real purchase).
    case "payment_disputes": {
      const bookIds = await authorBookIdsOrThrow(client, ctx.authorId);
      const clause = readerOrAuthorBooksClause(ctx.readerId, "reader_id", bookIds);
      const { data, error } = await client
        .from("purchases")
        .select("stripe_payment_intent_id")
        .or(clause)
        .not("stripe_payment_intent_id", "is", null);
      if (error) throw error;
      const intentIds = (data ?? [])
        .map((r: { stripe_payment_intent_id: string | null }) => r.stripe_payment_intent_id)
        .filter((v: string | null): v is string => v !== null);
      if (intentIds.length === 0) return 0;
      return countOf(
        client.from(table).select("*", { count: "exact", head: true }).in("stripe_payment_intent_id", intentIds) as unknown as Promise<{ count: number | null; error: unknown }>,
      );
    }
    default:
      throw new Error(`countRowsMatchingTraversalImpl: no automated live query mapping implemented for protected table "${table}".`);
  }
}

function makeListStorageEntries(client: SupabaseClient) {
  return async (bucket: FixtureStorageBucket, path: string, options: { limit: number; offset: number }) => {
    const { data, error } = await client.storage.from(bucket).list(path, {
      limit: options.limit,
      offset: options.offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    return (data ?? []).map((entry) => ({
      name: entry.name,
      id: entry.id,
      metadata: entry.metadata ? { size: (entry.metadata as { size: number }).size } : null,
    }));
  };
}

// PHASE-1C review round 4, item 3: a genuine Storage not-found always
// surfaces as an Error whose `status` field is exactly the raw HTTP
// status code the server returned (confirmed against the installed
// @supabase/storage-js source, node_modules/@supabase/storage-js/src/
// lib/common/fetch.ts's handleError -- `status` is always the numeric
// HTTP status; `statusCode`/`code` can instead be a service-specific
// string like "NoSuchKey", so those are deliberately NOT checked here).
// This is a STRUCTURAL check against that one stable, documented field
// -- it does not import @supabase/storage-js's own `StorageApiError`/
// `isStorageError` helpers (see this file's own top-of-file comment for
// why: that package is not a declared direct dependency of this repo).
// `error instanceof Error` is required too, narrowing away any
// unrelated object that merely happens to carry a `.status` field.
function isStorageNotFoundError(error: unknown): boolean {
  return error instanceof Error && "status" in error && (error as { status: unknown }).status === 404;
}

// PHASE-1C item 8: uses `.info(exactPath)` (not fuzzy `.list(...,
// {search})`), traced directly from installed storage-js source
// (StorageFileApi.ts:950-965); `.info()` returns `Camelize<FileObjectV2>`,
// whose `size?: number` field (storage-js src/lib/types.ts:130-131) is
// used as-is.
//
// A prior draft treated EVERY `.info()` error as "object absent"
// (`return null`) -- which would make a real auth/network/5xx failure
// during postcondition verification look identical to "successfully
// deleted", letting a failed check silently report success. Every
// error that isn't a genuine, structurally-confirmed not-found is
// rethrown, never swallowed.
async function getStorageObjectSizeImpl(client: SupabaseClient, bucket: FixtureStorageBucket, key: string): Promise<number | null> {
  const { data, error } = await client.storage.from(bucket).info(key);
  if (error) {
    if (isStorageNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  return data?.size ?? null;
}

// PHASE-1C review round 3, item 5: distinguishes a genuine "user not
// found" signal from every other kind of failure (network, permission,
// 500) -- confirmed directly from the installed @supabase/auth-js
// source (lib/errors.js's isAuthApiError, lib/error-codes.d.ts's
// documented 'user_not_found' ErrorCode). Any other error propagates --
// it is never silently converted into "absent".
async function getUserByIdImpl(client: SupabaseClient, id: string): Promise<FixtureAuthUser | null> {
  const { data, error } = await client.auth.admin.getUserById(id);
  if (error) {
    if (isAuthApiError(error) && (error as { code?: string }).code === "user_not_found") {
      return null;
    }
    throw error;
  }
  return data.user ? toFixtureAuthUser(data.user) : null;
}

// ============================================================
// SeedDeps
// ============================================================
export function buildLiveSeedDeps(): SeedDeps {
  const client = buildAdminClient();

  return {
    listUsers: makeListUsers(client),
    createUser: async (attrs) => {
      const { data, error } = await client.auth.admin.createUser(attrs);
      if (error) throw error;
      return { id: data.user!.id };
    },
    deleteUserById: async (id) => {
      const { error } = await client.auth.admin.deleteUser(id);
      if (error) throw error;
    },
    updateUserById: async (id, attrs) => {
      const { error } = await client.auth.admin.updateUserById(id, attrs);
      if (error) throw error;
    },
    getProfileById: (id) => getProfileByIdImpl(client, id),
    upsertProfile: (id, fields) => upsertProfileImpl(client, id, fields),
    requiredPassword: (which) => requireEnv(which === "author" ? "STAGING_FIXTURE_AUTHOR_PASSWORD" : "STAGING_FIXTURE_READER_PASSWORD"),
    uploadObject: async (bucket, key, bytes, contentType) => {
      const { error } = await client.storage.from(bucket).upload(key, bytes, { contentType, upsert: true });
      if (error) throw error;
    },
    verifyObjectSize: async (bucket, key) => ({ sizeBytes: await getStorageObjectSizeImpl(client, bucket, key) }),
    upsertSeries: async (id, authorId) => {
      const { error } = await client.from("series").upsert({ id, author_id: authorId, title: "Fixture Series" });
      if (error) throw error;
    },
    upsertBook: async (book, authorId, coverPath, manuscriptPath) => {
      const { error } = await client.from("books").upsert({
        id: book.id,
        author_id: authorId,
        title: book.title,
        description: "",
        genre: book.genre,
        series_id: book.seriesId,
        series_position: book.seriesPosition,
        price_cents: book.priceCents,
        cover_path: coverPath,
        file_path: manuscriptPath,
        status: book.status,
      });
      if (error) throw error;
    },
    upsertContributor: async (id, bookId) => {
      const { error } = await client.from("book_contributors").upsert({ id, book_id: bookId, name: "Fixture Illustrator", role: "Illustrator" });
      if (error) throw error;
    },
    upsertBundle: async (id, authorId) => {
      const { error } = await client.from("bundles").upsert({ id, author_id: authorId, title: "Fixture Bundle", status: "published" });
      if (error) throw error;
    },
    // PHASE-1C review round 4, item 1: includes the manifest's OWN fixed
    // `id` in every upserted row -- bundle_books.id has no unique
    // constraint of its own (only (bundle_id, book_id) does), so
    // omitting it here would let Postgres assign gen_random_uuid() on
    // first insert, defeating baselineTableRowIds()'s exact-id
    // postcondition check on every subsequent reseed.
    upsertBundleBooks: async (bundleId, memberships) => {
      const rows: { id: string; bundle_id: string; book_id: string }[] = memberships.map(
        (m: FixtureBundleMembership) => ({ id: m.id, bundle_id: bundleId, book_id: m.bookId }),
      );
      const { error } = await client.from("bundle_books").upsert(rows, { onConflict: "bundle_id,book_id" });
      if (error) throw error;
    },
    upsertDiscountCode: async (id, authorId, bookId) => {
      const { error } = await client
        .from("discount_codes")
        .upsert({ id, author_id: authorId, book_id: bookId, code: "FIXTURE10", percent_off: 10, active: true });
      if (error) throw error;
    },
    upsertPurchase: async (id, readerId, bookId, amountCents) => {
      const { FIXTURE_STRIPE_CHECKOUT_SESSION_ID, FIXTURE_STRIPE_PAYMENT_INTENT_ID, FIXTURE_PURCHASE_REGIME } = await import(
        "./manifest.mts"
      );
      const { error } = await client.from("purchases").upsert({
        id,
        reader_id: readerId,
        book_id: bookId,
        amount_cents: amountCents,
        stripe_checkout_session_id: FIXTURE_STRIPE_CHECKOUT_SESSION_ID,
        stripe_payment_intent_id: FIXTURE_STRIPE_PAYMENT_INTENT_ID,
        regime: FIXTURE_PURCHASE_REGIME,
      });
      if (error) throw error;
    },
    getProfileExternalState: (id) => getProfileExternalStateImpl(client, id),
    convergeProfileAvatarBaseline: (id) => convergeProfileAvatarBaselineImpl(client, id),
    getUserById: (id) => getUserByIdImpl(client, id),
    getBookById: async (id) => {
      const { data, error } = await client.from("books").select("id, title, status").eq("id", id).maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}

// ============================================================
// Reset/teardown Deps
// ============================================================
export function buildLiveResetDeps(): ResetDeps {
  const client = buildAdminClient();
  const listStorageEntries = makeListStorageEntries(client);

  return {
    listUsers: makeListUsers(client),
    getProfileById: (id) => getProfileByIdImpl(client, id),
    getProfileRole: async (id) => {
      const profile = await getProfileByIdImpl(client, id);
      return profile?.role ?? null;
    },
    getUserById: (id) => getUserByIdImpl(client, id),
    countRowsMatchingTraversal: (table, ctx) => countRowsMatchingTraversalImpl(client, table, ctx),
    getProfileExternalState: (id) => getProfileExternalStateImpl(client, id),
    discoverAuthorBookIds: (authorId) => authorBookIdsOrThrow(client, authorId),
    fetchFixturePurchases: async (ctx): Promise<FixturePurchaseRow[]> => {
      const bookIds = await authorBookIdsOrThrow(client, ctx.authorId);
      const orClause = readerOrAuthorBooksClause(ctx.readerId, "reader_id", bookIds);
      const { data, error } = await client
        .from("purchases")
        .select("id, reader_id, book_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id, regime, payment_id")
        .or(orClause);
      if (error) throw error;
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: row.id as string,
        readerId: row.reader_id as string,
        bookId: row.book_id as string,
        amountCents: row.amount_cents as number,
        stripeCheckoutSessionId: (row.stripe_checkout_session_id as string) ?? null,
        stripePaymentIntentId: (row.stripe_payment_intent_id as string) ?? null,
        regime: row.regime as string,
        hasLinkedPaymentId: row.payment_id !== null && row.payment_id !== undefined,
      }));
    },
    discoverFixtureLinkedRowIds: (table, ctx) => discoverFixtureLinkedRowIdsImpl(client, table, ctx),
    deleteByIds: (table, ids) => deleteByIdsImpl(client, table, ids),
    listStorageEntries,
    removeStorageObjects: async (bucket, keys) => {
      if (keys.length === 0) return;
      const { error } = await client.storage.from(bucket).remove(keys);
      if (error) throw error;
    },
    convergeProfileAvatarBaseline: (id) => convergeProfileAvatarBaselineImpl(client, id),
    readConfirmationPhrase: async () => {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        return await rl.question("Type the exact confirmation phrase to proceed: ");
      } finally {
        rl.close();
      }
    },
    reseedBaseline: async () => {
      const { runSeed } = await import("./seed.mts");
      return runSeed(buildLiveSeedDeps());
    },
    deleteUserById: async (id) => {
      const { error } = await client.auth.admin.deleteUser(id);
      if (error) throw error;
    },
    now: () => new Date().toISOString(),
  };
}
