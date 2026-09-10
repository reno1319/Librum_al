// PHASE-1C: shared internal phases for reset-to-baseline and teardown.
// Preflight is now GENUINELY read-only and builds one COMPLETE,
// immutable plan before confirmation is even asked for; the mutation
// phase executes exactly that frozen plan and never re-fetches or
// broadens it. `teardown` never re-seeds -- it deletes fixture-linked
// records/storage (the same frozen plan reset-to-baseline uses), then
// re-verifies both ownership markers against the EXACT ids frozen
// during preflight before deleting the two Auth users, last.
//
// PHASE-1C review round 3, item 4: EVERY deletion target table (not
// just purchases) has its exact row ids frozen during preflight, into
// `ApprovedPlan.deletionTargets`. The mutation phase deletes ONLY those
// frozen ids, via a single generic `deps.deleteByIds(table, ids)` --
// never re-deriving "current owner matches" dynamically at mutation
// time (closes a TOCTOU gap: a row that changed ownership or was
// created between preflight and mutation must never be swept up by a
// delete that re-runs the WHERE clause at execution time).
//
// Every phase takes its Supabase/Storage/stdin interactions as an
// injected `Deps` object -- this is what makes every function here
// directly unit-testable (see reset.test.ts) without any network access
// or real credentials. live-deps.mts wires `Deps` to a real
// @supabase/supabase-js admin client; it is only ever imported from
// this file's own CLI-entry-point block at the bottom, never executed
// by any test.
import { assertStagingTargetFromEnv } from "./guard.mts";
import {
  FIXTURE_AUTHOR_EMAIL,
  FIXTURE_READER_EMAIL,
  FIXTURE_READER_ROLE,
  FIXTURE_AUTHOR_ROLE,
  FIXTURE_PURCHASE_ID,
  FIXTURE_PURCHASE_TARGET_BOOK_ID,
  FIXTURE_STRIPE_CHECKOUT_SESSION_ID,
  FIXTURE_STRIPE_PAYMENT_INTENT_ID,
  FIXTURE_PURCHASE_REGIME,
  FIXTURE_PURCHASE_AMOUNT_CENTS,
  baselineTableRowIds,
} from "./manifest.mts";
import {
  discoverFixtureUser,
  requireValidForReadOnly,
  type ListUsersFn,
  type GetProfileByIdFn,
  type FixtureAuthUser,
} from "./auth-ownership.mts";
import {
  orderedDeleteTables,
  protectedTables,
  transientOnlyDeleteTables,
  BASELINE_RESEEDED_TABLES,
  classifyPurchase,
  type FixturePurchaseRow,
  type ExpectedSyntheticPurchase,
} from "./dispositions.mts";
import {
  planStorageCleanup,
  planNamespaceCleanup,
  discoverStorageObjects,
  expectedBaselineObjectKeys,
  FIXTURE_STORAGE_BUCKETS,
  type StorageCleanupPlanEntry,
  type ListEntriesFn,
  type FixtureStorageBucket,
} from "./storage-keys.mts";

export type ResetMode = "reset-to-baseline" | "teardown";

export type FixtureContext = { authorId: string; readerId: string };

export class PreflightHardStopError extends Error {
  constructor(public readonly table: string, message: string) {
    super(message);
  }
}
export class ConfirmationMismatchError extends Error {}
export class TeardownIdentityChangedError extends Error {}
export class PostconditionFailedError extends Error {}

// ============================================================
// The complete, immutable plan preflight produces. The mutation phase
// (deleteFixtureLinkedRecords / deleteFixtureStorageObjects / teardown's
// Auth delete) executes EXACTLY this -- it is never recomputed,
// re-fetched, or broadened after confirmation.
// ============================================================
export type ApprovedPlan = {
  authorId: string;
  readerId: string;
  stagingRef: string;
  // PHASE-1C review round 3, item 4: every orderedDeleteTables() table's
  // exact row ids, frozen during read-only preflight -- including
  // "purchases", which used to be the only frozen table.
  deletionTargets: Readonly<Record<string, readonly string[]>>;
  storagePlan: readonly StorageCleanupPlanEntry[];
  recentSignInWarnings: readonly string[];
};

// ============================================================
// Deps
// ============================================================
export type ProfileExternalState = {
  avatarPath: string | null;
  stripeAccountId: string | null;
  stripePayoutsEnabled: boolean;
};

export type Deps = {
  listUsers: ListUsersFn;
  getProfileById: GetProfileByIdFn;
  getProfileRole: (id: string) => Promise<string | null>;
  // PHASE-1C review round 3, item 5: must propagate any error that is
  // not a genuine "user not found" signal -- never silently convert
  // every failure into null. See live-deps.mts's implementation for the
  // AuthError.code === 'user_not_found' check this contract requires.
  getUserById: (id: string) => Promise<FixtureAuthUser | null>;
  // PHASE-1C review round 4, item 4: covers EVERY protectedTables()
  // entry uniformly, including the 3 zero-grant payout tables -- their
  // live-deps.mts implementation routes through a narrowly scoped
  // SECURITY DEFINER count-only RPC instead of a direct REST count, but
  // that distinction is invisible here (see dispositions.mts's
  // queriedViaRpc / rpcOnlyProtectedTables).
  countRowsMatchingTraversal: (table: string, ctx: FixtureContext) => Promise<number>;
  // PHASE-1C review round 3, item 6: real external Stripe Connect state
  // this design has no reviewed safe reset procedure for.
  getProfileExternalState: (id: string) => Promise<ProfileExternalState>;
  discoverAuthorBookIds: (authorId: string) => Promise<string[]>;
  fetchFixturePurchases: (ctx: FixtureContext) => Promise<FixturePurchaseRow[]>;
  // Genuinely read-only: `SELECT id FROM <table> WHERE <traversal>` for
  // the given table's documented traversal (dispositions.mts). Used both
  // to freeze deletionTargets during preflight AND to re-discover
  // current state during postcondition verification -- it never mutates
  // anything.
  discoverFixtureLinkedRowIds: (table: string, ctx: FixtureContext) => Promise<string[]>;
  // Deletes EXACTLY the given ids from the given table -- never
  // re-derives "current matches" from ctx at call time.
  deleteByIds: (table: string, ids: readonly string[]) => Promise<{ deletedCount: number }>;
  listStorageEntries: (bucket: FixtureStorageBucket, path: string, options: { limit: number; offset: number }) => Promise<
    { name: string; id: string | null; metadata: { size: number } | null }[]
  >;
  removeStorageObjects: (bucket: FixtureStorageBucket, keys: string[]) => Promise<void>;
  // PHASE-1C review round 3, item 6: converges avatar_path back to its
  // defined safe baseline (null) for one profile, after the actual
  // storage object (if any) has already been removed.
  convergeProfileAvatarBaseline: (id: string) => Promise<void>;
  readConfirmationPhrase: () => Promise<string>;
  reseedBaseline: (ctx: FixtureContext) => Promise<FixtureContext>;
  deleteUserById: (id: string) => Promise<void>;
  now: () => string;
  onPhase?: (phaseName: string) => void;
};

function emit(deps: Deps, phase: string) {
  deps.onPhase?.(phase);
}

const RECENT_SIGN_IN_WARNING_MINUTES = 15;

// Pure -- testable without any Deps at all.
export function isRecentSignIn(lastSignInAt: string | null | undefined, nowIso: string, thresholdMinutes = RECENT_SIGN_IN_WARNING_MINUTES): boolean {
  if (!lastSignInAt) return false;
  const last = Date.parse(lastSignInAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(last) || Number.isNaN(now)) return false;
  return now - last < thresholdMinutes * 60 * 1000;
}

// A single fresh, independent recursive walk of one bucket under one
// account's own namespace -- shared by BOTH preflight (to build the
// deletion plan) and postcondition (to verify the real end state,
// PHASE-1C review round 4, item 6: "perform a fresh recursive namespace
// discovery after mutation ... do not verify only the keys frozen
// during preflight"). Every call goes through the exact same
// `discoverStorageObjects` validation (folder/file distinction,
// path-traversal rejection, namespace-prefix check) preflight itself
// uses -- there is no separate, weaker postcondition-only code path.
async function discoverNamespaceObjectKeys(deps: Deps, bucket: FixtureStorageBucket, namespaceId: string): Promise<string[]> {
  const objects = await discoverStorageObjects({
    listEntries: ((path, options) => deps.listStorageEntries(bucket, path, options)) as ListEntriesFn,
    fixtureAuthorId: namespaceId,
  });
  return objects.map((o) => o.fullKey);
}

function expectedSyntheticPurchase(readerId: string): ExpectedSyntheticPurchase {
  return {
    id: FIXTURE_PURCHASE_ID,
    readerId,
    bookId: FIXTURE_PURCHASE_TARGET_BOOK_ID,
    amountCents: FIXTURE_PURCHASE_AMOUNT_CENTS,
    stripeCheckoutSessionId: FIXTURE_STRIPE_CHECKOUT_SESSION_ID,
    stripePaymentIntentId: FIXTURE_STRIPE_PAYMENT_INTENT_ID,
    regime: FIXTURE_PURCHASE_REGIME,
  };
}

// ============================================================
// Preflight: genuinely read-only. Discovers both accounts, validates
// their markers/profiles/roles, checks every protected table, hard-stops
// on real external Stripe/payout state, classifies purchases, FREEZES
// the exact row ids eligible for deletion in EVERY deletion-target
// table, builds and validates the complete Storage deletion plan (BOTH
// accounts' namespaces, across EVERY fixture bucket, symmetrically --
// no bucket is excluded for either account), and warns on recent
// sign-ins -- ALL before confirmation and before the first mutation.
// ============================================================
export async function runPreflight(deps: Deps): Promise<ApprovedPlan> {
  emit(deps, "preflight:start");

  const stagingRef = assertStagingTargetFromEnv();

  const authorDiscovered = await discoverFixtureUser({
    listUsers: deps.listUsers,
    getProfileById: deps.getProfileById,
    email: FIXTURE_AUTHOR_EMAIL,
  });
  const readerDiscovered = await discoverFixtureUser({
    listUsers: deps.listUsers,
    getProfileById: deps.getProfileById,
    email: FIXTURE_READER_EMAIL,
  });
  const author = requireValidForReadOnly(authorDiscovered, FIXTURE_AUTHOR_EMAIL);
  const reader = requireValidForReadOnly(readerDiscovered, FIXTURE_READER_EMAIL);

  emit(deps, "preflight:validate-roles");
  const authorRole = await deps.getProfileRole(author.id);
  if (authorRole !== FIXTURE_AUTHOR_ROLE) {
    throw new PreflightHardStopError(
      "profiles",
      `Preflight hard-stop: fixture author account's profile role is "${authorRole}", expected ` +
        `"${FIXTURE_AUTHOR_ROLE}". Refusing to proceed -- the account's identity does not match ` +
        "what this design expects.",
    );
  }
  const readerRole = await deps.getProfileRole(reader.id);
  if (readerRole !== FIXTURE_READER_ROLE) {
    throw new PreflightHardStopError(
      "profiles",
      `Preflight hard-stop: fixture reader account's profile role is "${readerRole}", expected ` +
        `"${FIXTURE_READER_ROLE}". Refusing to proceed.`,
    );
  }

  const ctx: FixtureContext = { authorId: author.id, readerId: reader.id };

  // PHASE-1C review round 4, item 4: a single uniform loop over EVERY
  // protectedTables() entry -- including the 3 zero-grant payout tables,
  // which live-deps.mts now counts via a narrowly scoped, SECURITY
  // DEFINER, count-only RPC (public.staging_fixture_protected_table_
  // counts, migration 057) instead of a direct REST count. The prior
  // round-3 "human attestation boolean" gate is removed entirely -- this
  // now obtains REAL counts for every protected table, automatically.
  emit(deps, "preflight:protected-tables");
  for (const table of protectedTables("resetToBaseline")) {
    const count = await deps.countRowsMatchingTraversal(table, ctx);
    if (count > 0) {
      throw new PreflightHardStopError(
        table,
        `Preflight hard-stop: ${count} row(s) found in protected table "${table}" for the fixture ` +
          "account(s). Refusing to proceed with ANY mutation. A human with direct database access " +
          "must review these rows -- see scripts/staging-fixtures/README.md's recovery/escalation " +
          "procedure. No row content or secret is logged, only the table name and count above.",
      );
    }
  }

  // PHASE-1C review round 3, item 6: no reviewed safe reset procedure
  // exists for real external Stripe Connect state.
  emit(deps, "preflight:external-identity-state");
  for (const id of [ctx.authorId, ctx.readerId]) {
    const state = await deps.getProfileExternalState(id);
    if (state.stripeAccountId !== null || state.stripePayoutsEnabled === true) {
      throw new PreflightHardStopError(
        "profiles",
        `Preflight hard-stop: profile ${id} has a non-null stripe_account_id or ` +
          "stripe_payouts_enabled=true -- real external Stripe Connect state this design has no " +
          "reviewed safe reset procedure for. Refusing to proceed with ANY mutation.",
      );
    }
  }

  emit(deps, "preflight:classify-purchases");
  const fixtureAuthorBookIds = await deps.discoverAuthorBookIds(ctx.authorId);
  const purchases = await deps.fetchFixturePurchases(ctx);
  const purchaseIdsToDelete: string[] = [];
  for (const purchase of purchases) {
    const classification = classifyPurchase(purchase, {
      fixtureReaderId: ctx.readerId,
      fixtureAuthorBookIds,
      expectedSynthetic: expectedSyntheticPurchase(ctx.readerId),
    });
    if (classification.kind === "hard_stop_unexplained") {
      throw new PreflightHardStopError(
        "purchases",
        `Preflight hard-stop: purchase ${purchase.id} does not classify as either the known ` +
          "synthetic fixture row or a genuine free acquisition -- refusing to proceed with ANY " +
          "mutation. No purchase content beyond its id is logged.",
      );
    }
    purchaseIdsToDelete.push(purchase.id);
  }

  // PHASE-1C review round 3, item 4: freeze EVERY deletion-target
  // table's exact row ids now, during read-only preflight -- the
  // mutation phase below executes only these frozen ids, never a
  // dynamically re-derived "current match".
  emit(deps, "preflight:freeze-deletion-targets");
  const deletionTargets: Record<string, readonly string[]> = {};
  for (const table of orderedDeleteTables("resetToBaseline")) {
    if (table === "purchases") {
      deletionTargets[table] = purchaseIdsToDelete;
      continue;
    }
    deletionTargets[table] = await deps.discoverFixtureLinkedRowIds(table, ctx);
  }

  // PHASE-1C review round 3, item 6 / round 4, items 2 and 1: Storage
  // discovery covers BOTH fixture accounts' namespaces, across EVERY
  // fixture bucket (covers, manuscripts, avatars) for EACH account --
  // no bucket is special-cased or excluded for either account. Round 4
  // originally special-cased the reader to skip "covers" (reasoning:
  // "no non-author ever writes there") -- REJECTED by the round-4
  // review: an anomalous/leftover object under covers/<readerId>/...
  // must still be discovered, included in the frozen deletion plan, and
  // cause a postcondition failure if it survives, exactly like any
  // other unexpected object would. avatar-field.tsx also stages a temp
  // avatar upload at manuscripts/<userId>/tmp/avatar/<uuid>.<ext> for
  // EITHER account (confirmed directly against source; the public
  // "avatars" bucket only ever receives the finalized object) -- this
  // symmetric, no-exclusions walk covers that case too, for both
  // accounts, without needing a special case at all.
  emit(deps, "preflight:storage-plan");
  const discoveredByBucket: Record<FixtureStorageBucket, string[]> = { covers: [], manuscripts: [], avatars: [] };
  for (const bucket of FIXTURE_STORAGE_BUCKETS) {
    discoveredByBucket[bucket] = await discoverNamespaceObjectKeys(deps, bucket, ctx.authorId);
  }
  const authorStoragePlan = planStorageCleanup({ fixtureAuthorId: ctx.authorId, discoveredByBucket });

  let readerStoragePlan: StorageCleanupPlanEntry[] = [];
  for (const bucket of FIXTURE_STORAGE_BUCKETS) {
    const keys = await discoverNamespaceObjectKeys(deps, bucket, ctx.readerId);
    readerStoragePlan = readerStoragePlan.concat(
      planNamespaceCleanup({ namespaceId: ctx.readerId, bucket, discoveredKeys: keys }),
    );
  }

  const storagePlan = [...authorStoragePlan, ...readerStoragePlan];

  emit(deps, "preflight:recent-sign-in-check");
  const nowIso = deps.now();
  const recentSignInWarnings: string[] = [];
  if (isRecentSignIn(author.last_sign_in_at, nowIso)) recentSignInWarnings.push("author");
  if (isRecentSignIn(reader.last_sign_in_at, nowIso)) recentSignInWarnings.push("reader");

  emit(deps, "preflight:complete");
  return {
    authorId: ctx.authorId,
    readerId: ctx.readerId,
    stagingRef,
    deletionTargets,
    storagePlan,
    recentSignInWarnings,
  };
}

// ============================================================
// Mutation phase 1: delete fixture-linked DB records, executing ONLY the
// FROZEN, exact-id plan -- never re-deriving "current owner matches" at
// mutation time (PHASE-1C review round 3, item 4).
// ============================================================
export async function deleteFixtureLinkedRecords(deps: Deps, plan: ApprovedPlan): Promise<void> {
  emit(deps, "delete-records:start");
  for (const table of orderedDeleteTables("resetToBaseline")) {
    emit(deps, `delete-records:${table}`);
    await deps.deleteByIds(table, plan.deletionTargets[table] ?? []);
  }
  emit(deps, "delete-records:complete");
}

// ============================================================
// Mutation phase 2: delete fixture-owned Storage objects, executing the
// FROZEN storage plan built during preflight (both accounts'
// namespaces).
// ============================================================
export async function deleteFixtureStorageObjects(deps: Deps, plan: ApprovedPlan): Promise<void> {
  emit(deps, "delete-storage:start");
  const byBucket = new Map<FixtureStorageBucket, string[]>();
  for (const entry of plan.storagePlan) {
    byBucket.set(entry.bucket, [...(byBucket.get(entry.bucket) ?? []), entry.key]);
  }
  for (const [bucket, keys] of byBucket) {
    emit(deps, `delete-storage:${bucket}`);
    await deps.removeStorageObjects(bucket, keys);
  }
  emit(deps, "delete-storage:complete");
}

// ============================================================
// Mutation phase 3 (reset-to-baseline only): converge both fixture
// accounts' avatar_path back to its defined safe baseline (null), now
// that any actual avatar storage object has already been removed
// (PHASE-1C review round 3, item 6).
// ============================================================
export async function convergeProfileExternalBaseline(deps: Deps, plan: ApprovedPlan): Promise<void> {
  emit(deps, "converge-avatar-baseline:start");
  await deps.convergeProfileAvatarBaseline(plan.authorId);
  await deps.convergeProfileAvatarBaseline(plan.readerId);
  emit(deps, "converge-avatar-baseline:complete");
}

// ============================================================
// Confirmation (item 9): derived from the GUARD's own validated ref
// (plan.stagingRef), never a separately supplied parameter.
// ============================================================
export function expectedConfirmationPhrase(mode: ResetMode, plan: ApprovedPlan): string {
  return mode === "teardown" ? `${plan.stagingRef} TEARDOWN` : plan.stagingRef;
}

export async function requireTypedConfirmation(deps: Deps, mode: ResetMode, plan: ApprovedPlan): Promise<void> {
  emit(deps, "confirmation:prompt");
  if (plan.recentSignInWarnings.length > 0) {
    emit(deps, `confirmation:recent-sign-in-warning:${plan.recentSignInWarnings.join(",")}`);
  }
  const typed = (await deps.readConfirmationPhrase()).trim();
  const expected = expectedConfirmationPhrase(mode, plan);
  if (typed !== expected) {
    throw new ConfirmationMismatchError(
      `Typed confirmation did not match exactly. Refusing to proceed with "${mode}". No mutation occurred.`,
    );
  }
  emit(deps, "confirmation:accepted");
}

// ============================================================
// Postcondition verification (item 11, redesigned per round 3 item 2 and
// item 5): success is never reported based only on mutation calls
// returning no error -- everything below is a fresh, independent
// re-discovery.
// ============================================================
export async function verifyResetToBaselinePostconditions(deps: Deps, plan: ApprovedPlan): Promise<void> {
  emit(deps, "postcondition:reset-to-baseline:start");
  const ctx: FixtureContext = { authorId: plan.authorId, readerId: plan.readerId };

  // PHASE-1C review round 3, item 2: genuinely transient tables must be
  // empty; BASELINE_RESEEDED_TABLES must contain EXACTLY the reseeded
  // baseline rows -- never "empty" (the previous, incorrect check).
  for (const table of transientOnlyDeleteTables("resetToBaseline")) {
    const ids = await deps.discoverFixtureLinkedRowIds(table, ctx);
    if (ids.length > 0) {
      throw new PostconditionFailedError(
        `Postcondition failed: ${ids.length} row(s) still present in transient table "${table}" ` +
          "after reset-to-baseline's delete phase.",
      );
    }
  }

  const expectedBaseline = baselineTableRowIds();
  for (const table of BASELINE_RESEEDED_TABLES) {
    const actualIds = await deps.discoverFixtureLinkedRowIds(table, ctx);
    const expectedIds = expectedBaseline[table] ?? [];
    const actualSet = new Set(actualIds);
    const expectedSet = new Set(expectedIds);
    const missing = expectedIds.filter((id) => !actualSet.has(id));
    const unexpected = actualIds.filter((id) => !expectedSet.has(id));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new PostconditionFailedError(
        `Postcondition failed: baseline table "${table}" does not contain exactly the expected ` +
          `reseeded rows (missing: [${missing.join(", ")}], unexpected: [${unexpected.join(", ")}]).`,
      );
    }
  }

  const afterAuthor = await deps.getUserById(plan.authorId);
  const afterReader = await deps.getUserById(plan.readerId);
  if (afterAuthor === null || afterAuthor.id !== plan.authorId) {
    throw new PostconditionFailedError("Postcondition failed: fixture author Auth id was not preserved.");
  }
  if (afterReader === null || afterReader.id !== plan.readerId) {
    throw new PostconditionFailedError("Postcondition failed: fixture reader Auth id was not preserved.");
  }

  // PHASE-1C review round 4, item 6: a FRESH recursive Storage
  // discovery, independent of `plan.storagePlan` -- never trust the
  // keys frozen during preflight, which cannot see an object created
  // AFTER preflight ran. The author must hold EXACTLY the 10 baseline
  // objects (5 books x cover+manuscript); the reader must hold NONE.
  emit(deps, "postcondition:reset-to-baseline:storage-start");
  const authorActualKeys = new Set<string>();
  for (const bucket of FIXTURE_STORAGE_BUCKETS) {
    for (const key of await discoverNamespaceObjectKeys(deps, bucket, plan.authorId)) {
      authorActualKeys.add(`${bucket}:${key}`);
    }
  }
  const authorExpectedKeys = new Set(expectedBaselineObjectKeys(plan.authorId).map((e) => `${e.bucket}:${e.key}`));
  const missingStorage = [...authorExpectedKeys].filter((k) => !authorActualKeys.has(k));
  const unexpectedStorage = [...authorActualKeys].filter((k) => !authorExpectedKeys.has(k));
  if (missingStorage.length > 0 || unexpectedStorage.length > 0) {
    throw new PostconditionFailedError(
      "Postcondition failed: fixture author's Storage objects do not match the expected baseline " +
        `exactly after reset-to-baseline (missing: [${missingStorage.join(", ")}], unexpected: ` +
        `[${unexpectedStorage.join(", ")}]).`,
    );
  }

  const readerLeftoverKeys: string[] = [];
  for (const bucket of FIXTURE_STORAGE_BUCKETS) {
    for (const key of await discoverNamespaceObjectKeys(deps, bucket, plan.readerId)) {
      readerLeftoverKeys.push(`${bucket}:${key}`);
    }
  }
  if (readerLeftoverKeys.length > 0) {
    throw new PostconditionFailedError(
      "Postcondition failed: fixture reader's Storage namespace is not empty after reset-to-baseline " +
        `(found: [${readerLeftoverKeys.join(", ")}]).`,
    );
  }
  emit(deps, "postcondition:reset-to-baseline:storage-complete");

  emit(deps, "postcondition:reset-to-baseline:complete");
}

export async function verifyTeardownPostconditions(deps: Deps, plan: ApprovedPlan): Promise<void> {
  emit(deps, "postcondition:teardown:start");

  // PHASE-1C review round 3, item 5: getUserById now propagates any
  // unexpected error rather than converting it into "user absent" --
  // null here means a genuine, verified absence.
  const authorAfter = await deps.getUserById(plan.authorId);
  const readerAfter = await deps.getUserById(plan.readerId);
  if (authorAfter !== null) {
    throw new PostconditionFailedError("Postcondition failed: fixture author Auth user still found after teardown.");
  }
  if (readerAfter !== null) {
    throw new PostconditionFailedError("Postcondition failed: fixture reader Auth user still found after teardown.");
  }

  // Database: teardown never reseeds, so EVERY deletion-target table
  // (transient and baseline alike) must now be empty.
  const ctx: FixtureContext = { authorId: plan.authorId, readerId: plan.readerId };
  for (const table of orderedDeleteTables("teardown")) {
    const ids = await deps.discoverFixtureLinkedRowIds(table, ctx);
    if (ids.length > 0) {
      throw new PostconditionFailedError(
        `Postcondition failed: ${ids.length} row(s) still present in "${table}" after teardown.`,
      );
    }
  }

  // PHASE-1C review round 4, item 6: a FRESH recursive Storage
  // discovery across every bucket in BOTH accounts' namespaces --
  // teardown never reseeds, so both must now be completely empty. Never
  // trust `plan.storagePlan`'s frozen keys alone (they cannot see an
  // object created after preflight ran).
  const authorLeftoverKeys: string[] = [];
  for (const bucket of FIXTURE_STORAGE_BUCKETS) {
    for (const key of await discoverNamespaceObjectKeys(deps, bucket, plan.authorId)) {
      authorLeftoverKeys.push(`${bucket}:${key}`);
    }
  }
  if (authorLeftoverKeys.length > 0) {
    throw new PostconditionFailedError(
      "Postcondition failed: fixture author's Storage namespace still has objects after teardown " +
        `(found: [${authorLeftoverKeys.join(", ")}]).`,
    );
  }

  const readerLeftoverKeys: string[] = [];
  for (const bucket of FIXTURE_STORAGE_BUCKETS) {
    for (const key of await discoverNamespaceObjectKeys(deps, bucket, plan.readerId)) {
      readerLeftoverKeys.push(`${bucket}:${key}`);
    }
  }
  if (readerLeftoverKeys.length > 0) {
    throw new PostconditionFailedError(
      "Postcondition failed: fixture reader's Storage namespace still has objects after teardown " +
        `(found: [${readerLeftoverKeys.join(", ")}]).`,
    );
  }

  emit(deps, "postcondition:teardown:complete");
}

// ============================================================
// The one place reset-to-baseline's and teardown's sequences are
// decided.
// ============================================================
export async function runReset(mode: ResetMode, deps: Deps): Promise<void> {
  const plan = await runPreflight(deps);
  await requireTypedConfirmation(deps, mode, plan);
  await deleteFixtureLinkedRecords(deps, plan);
  await deleteFixtureStorageObjects(deps, plan);

  if (mode === "reset-to-baseline") {
    await convergeProfileExternalBaseline(deps, plan);

    emit(deps, "reseed:start");
    const reseeded = await deps.reseedBaseline({ authorId: plan.authorId, readerId: plan.readerId });
    if (reseeded.authorId !== plan.authorId || reseeded.readerId !== plan.readerId) {
      throw new TeardownIdentityChangedError(
        "reset-to-baseline: reseed returned different Auth ids than the ones frozen during preflight -- aborting.",
      );
    }
    emit(deps, "reseed:complete");
    await verifyResetToBaselinePostconditions(deps, plan);
    emit(deps, "reset-to-baseline:success");
    return;
  }

  // teardown: NEVER re-seeds. Immediately before Auth deletion,
  // re-resolve and revalidate BOTH ownership markers, and assert the
  // re-resolved ids EXACTLY equal the ids frozen during preflight --
  // abort on any disappearance or id change, rather than trusting that
  // nothing changed between preflight and here.
  emit(deps, "teardown:reverify-markers");
  const authorRecheck = requireValidForReadOnly(
    await discoverFixtureUser({ listUsers: deps.listUsers, getProfileById: deps.getProfileById, email: FIXTURE_AUTHOR_EMAIL }),
    FIXTURE_AUTHOR_EMAIL,
  );
  if (authorRecheck.id !== plan.authorId) {
    throw new TeardownIdentityChangedError(
      `teardown: re-resolved fixture author id (${authorRecheck.id}) no longer matches the id frozen ` +
        `during preflight (${plan.authorId}). Aborting before any Auth deletion.`,
    );
  }
  const readerRecheck = requireValidForReadOnly(
    await discoverFixtureUser({ listUsers: deps.listUsers, getProfileById: deps.getProfileById, email: FIXTURE_READER_EMAIL }),
    FIXTURE_READER_EMAIL,
  );
  if (readerRecheck.id !== plan.readerId) {
    throw new TeardownIdentityChangedError(
      `teardown: re-resolved fixture reader id (${readerRecheck.id}) no longer matches the id frozen ` +
        `during preflight (${plan.readerId}). Aborting before any Auth deletion.`,
    );
  }

  emit(deps, "teardown:delete-auth-users");
  await deps.deleteUserById(plan.authorId);
  await deps.deleteUserById(plan.readerId);
  emit(deps, "teardown:complete");

  await verifyTeardownPostconditions(deps, plan);
  emit(deps, "teardown:success");
}

// ============================================================
// CLI entry point. Wires Deps to a REAL @supabase/supabase-js admin
// client via live-deps.mts (implemented, but this block is never
// executed in this session -- no `npm run staging:fixtures:*` command
// was run; see REVIEW-REPORT.txt). Dynamic import so importing THIS
// module for its exported functions (as reset.test.ts does) never pulls
// in live-deps.mts or constructs any client.
// ============================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] as ResetMode | undefined;
  if (mode !== "reset-to-baseline" && mode !== "teardown") {
    console.error('Usage: node --experimental-strip-types --env-file=.env.staging.local reset.mts <reset-to-baseline|teardown>');
    process.exit(1);
  }
  const { buildLiveResetDeps } = await import("./live-deps.mts");
  const deps = buildLiveResetDeps();
  await runReset(mode, deps);
}
