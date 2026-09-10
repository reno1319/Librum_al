import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runReset,
  runPreflight,
  expectedConfirmationPhrase,
  isRecentSignIn,
  PreflightHardStopError,
  ConfirmationMismatchError,
  TeardownIdentityChangedError,
  PostconditionFailedError,
  type Deps,
} from "./reset.mts";
import { STAGING_SUPABASE_PROJECT_REF } from "./guard.mts";
import {
  FIXTURE_AUTHOR_EMAIL,
  FIXTURE_READER_EMAIL,
  FIXTURE_STRIPE_PAYMENT_INTENT_ID,
  FIXTURE_STRIPE_CHECKOUT_SESSION_ID,
  FIXTURE_PURCHASE_ID,
  FIXTURE_PURCHASE_TARGET_BOOK_ID,
  FIXTURE_PURCHASE_REGIME,
  FIXTURE_PURCHASE_AMOUNT_CENTS,
  FIXTURE_OWNERSHIP_MARKER,
  FIXTURE_BOOK_IDS,
  baselineTableRowIds,
} from "./manifest.mts";
import { expectedBaselineObjectKeys } from "./storage-keys.mts";
import type { ListUsersFn } from "./auth-ownership.mts";

const AUTHOR_ID = "author-1";
const READER_ID = "reader-1";
const NOW = "2026-01-01T12:00:00.000Z";

// Tables reset.mts's preflight freezes via discoverFixtureLinkedRowIds
// (every orderedDeleteTables("resetToBaseline") entry except purchases,
// which is frozen separately via classification).
const TRANSIENT_TABLES = [
  "refund_request_items",
  "bundle_checkout_reader_holds",
  "bundle_checkout_reservations",
  "book_checkout_intents",
  "refund_requests",
  "reviews",
  "wishlist_items",
  "author_follows",
  "book_reports",
];
// BASELINE_RESEEDED_TABLES (dispositions.mts) -- reseeded, not emptied.
const BASELINE_TABLES = ["series", "books", "book_contributors", "bundle_books", "bundles", "discount_codes", "purchases"];

function baseListUsers(overrides: { authorId?: string; readerId?: string; authorLastSignIn?: string | null } = {}): ListUsersFn {
  return async () => ({
    users: [
      {
        id: overrides.authorId ?? AUTHOR_ID,
        email: FIXTURE_AUTHOR_EMAIL,
        app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER },
        last_sign_in_at: overrides.authorLastSignIn ?? null,
      },
      {
        id: overrides.readerId ?? READER_ID,
        email: FIXTURE_READER_EMAIL,
        app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER },
        last_sign_in_at: null,
      },
    ],
  });
}

// A minimal, stateful fake Storage: `keysByBucket` holds the CURRENT set
// of full object keys per bucket; `listStorageEntries` derives the
// direct children (files and folders) of whatever path is asked for --
// exactly what discoverStorageObjects()'s recursive walk needs -- and
// `removeStorageObjects` actually deletes from that same state. This is
// what makes a FRESH postcondition discovery (PHASE-1C review round 4,
// item 6) meaningfully different from just re-reading the frozen plan.
function makeStatefulStorage(initialKeysByBucket: Partial<Record<string, string[]>> = {}) {
  const keysByBucket = new Map<string, Set<string>>();
  for (const bucket of ["covers", "manuscripts", "avatars"]) {
    keysByBucket.set(bucket, new Set(initialKeysByBucket[bucket] ?? []));
  }

  function childrenAt(bucket: string, path: string) {
    const keys = keysByBucket.get(bucket) ?? new Set<string>();
    const prefix = `${path}/`;
    const children = new Map<string, boolean>(); // name -> isFile
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1) children.set(rest, true);
      else children.set(rest.slice(0, slashIdx), false);
    }
    return [...children.entries()].map(([name, isFile]) => ({
      name,
      id: isFile ? `id:${path}/${name}` : null,
      metadata: isFile ? { size: 10 } : null,
    }));
  }

  return {
    keysByBucket,
    listStorageEntries: vi.fn(async (bucket: string, path: string) => childrenAt(bucket, path)),
    removeStorageObjects: vi.fn(async (bucket: string, keys: string[]) => {
      const set = keysByBucket.get(bucket);
      if (!set) return;
      for (const key of keys) set.delete(key);
    }),
  };
}

// A minimal, STATEFUL fake "database" so deleteByIds/discoverFixtureLinkedRowIds/
// reseedBaseline behave consistently with each other across a single run --
// this is what makes the redesigned postcondition checks (PHASE-1C review
// round 3, item 2 and item 4; round 4, item 6) meaningfully testable, rather
// than trivially true regardless of what the code under test actually does.
function baseDeps(overrides: Partial<Deps> = {}): Deps {
  const deletedAuthIds = new Set<string>();
  const baseline = baselineTableRowIds();
  const tableState = new Map<string, Set<string>>();
  for (const table of BASELINE_TABLES) {
    tableState.set(table, new Set(table === "purchases" ? [FIXTURE_PURCHASE_ID] : (baseline[table] ?? [])));
  }
  for (const table of TRANSIENT_TABLES) {
    tableState.set(table, new Set());
  }

  const discoverFixtureLinkedRowIds = vi.fn(async (table: string) => [...(tableState.get(table) ?? new Set<string>())]);
  const deleteByIds = vi.fn(async (table: string, ids: readonly string[]) => {
    const set = tableState.get(table);
    let deletedCount = 0;
    if (set) {
      for (const id of ids) {
        if (set.delete(id)) deletedCount++;
      }
    }
    return { deletedCount };
  });

  // Author starts holding exactly the 10 baseline Storage objects
  // (5 books x cover+manuscript); reader starts with nothing.
  const authorBaselineKeys = expectedBaselineObjectKeys(AUTHOR_ID);
  const storage = makeStatefulStorage({
    covers: authorBaselineKeys.filter((e) => e.bucket === "covers").map((e) => e.key),
    manuscripts: authorBaselineKeys.filter((e) => e.bucket === "manuscripts").map((e) => e.key),
    avatars: [],
  });

  return {
    listUsers: vi.fn(baseListUsers()),
    getProfileById: vi.fn().mockResolvedValue({ role: "author", display_name: "x", public_author_name: "x", bio: null }),
    getProfileRole: vi.fn().mockImplementation(async (id: string) => (id === AUTHOR_ID ? "author" : "reader")),
    getUserById: vi.fn().mockImplementation(async (id: string) =>
      !deletedAuthIds.has(id) && (id === AUTHOR_ID || id === READER_ID)
        ? { id, email: "x", app_metadata: {}, last_sign_in_at: null }
        : null,
    ),
    countRowsMatchingTraversal: vi.fn().mockResolvedValue(0),
    getProfileExternalState: vi.fn().mockResolvedValue({ avatarPath: null, stripeAccountId: null, stripePayoutsEnabled: false }),
    discoverAuthorBookIds: vi.fn().mockResolvedValue([...FIXTURE_BOOK_IDS]),
    fetchFixturePurchases: vi.fn().mockResolvedValue([
      {
        id: FIXTURE_PURCHASE_ID,
        readerId: READER_ID,
        bookId: FIXTURE_PURCHASE_TARGET_BOOK_ID,
        amountCents: FIXTURE_PURCHASE_AMOUNT_CENTS,
        stripeCheckoutSessionId: FIXTURE_STRIPE_CHECKOUT_SESSION_ID,
        stripePaymentIntentId: FIXTURE_STRIPE_PAYMENT_INTENT_ID,
        regime: FIXTURE_PURCHASE_REGIME,
        hasLinkedPaymentId: false,
      },
    ]),
    discoverFixtureLinkedRowIds,
    deleteByIds,
    listStorageEntries: storage.listStorageEntries,
    removeStorageObjects: storage.removeStorageObjects,
    convergeProfileAvatarBaseline: vi.fn().mockResolvedValue(undefined),
    readConfirmationPhrase: vi.fn().mockResolvedValue(""),
    reseedBaseline: vi.fn().mockImplementation(async (ctx: { authorId: string; readerId: string }) => {
      // Simulate a real seed run: every baseline table AND every
      // baseline Storage object returns to exactly its expected state.
      for (const table of BASELINE_TABLES) {
        tableState.set(table, new Set(baseline[table] ?? (table === "purchases" ? [FIXTURE_PURCHASE_ID] : [])));
      }
      const coversSet = storage.keysByBucket.get("covers")!;
      const manuscriptsSet = storage.keysByBucket.get("manuscripts")!;
      for (const entry of authorBaselineKeys) {
        (entry.bucket === "covers" ? coversSet : manuscriptsSet).add(entry.key);
      }
      return ctx;
    }),
    deleteUserById: vi.fn().mockImplementation(async (id: string) => {
      deletedAuthIds.add(id);
    }),
    now: () => NOW,
    ...overrides,
  };
}

const REAL_ENV = process.env.STAGING_FIXTURE_SUPABASE_URL;
beforeEach(() => {
  process.env.STAGING_FIXTURE_SUPABASE_URL = `https://${STAGING_SUPABASE_PROJECT_REF}.supabase.co`;
});
afterEach(() => {
  if (REAL_ENV === undefined) delete process.env.STAGING_FIXTURE_SUPABASE_URL;
  else process.env.STAGING_FIXTURE_SUPABASE_URL = REAL_ENV;
});

describe("isRecentSignIn", () => {
  it("is true for a sign-in within the warning window", () => {
    expect(isRecentSignIn("2026-01-01T11:50:00.000Z", NOW)).toBe(true);
  });
  it("is false for an old sign-in, null, or invalid input", () => {
    expect(isRecentSignIn("2025-01-01T00:00:00.000Z", NOW)).toBe(false);
    expect(isRecentSignIn(null, NOW)).toBe(false);
    expect(isRecentSignIn("not-a-date", NOW)).toBe(false);
  });
});

describe("runPreflight", () => {
  it("resolves both fixture users and freezes an ApprovedPlan when nothing is wrong", async () => {
    const deps = baseDeps();
    const plan = await runPreflight(deps);
    expect(plan.authorId).toBe(AUTHOR_ID);
    expect(plan.readerId).toBe(READER_ID);
    expect(plan.deletionTargets.purchases).toEqual([FIXTURE_PURCHASE_ID]);
    expect(plan.deletionTargets.books).toEqual([...FIXTURE_BOOK_IDS]);
    expect(plan.recentSignInWarnings).toEqual([]);
  });

  // PHASE-1C review round 3, item 4: EVERY deletion-target table is
  // frozen during preflight, not just purchases.
  it("freezes deletionTargets for every orderedDeleteTables() table, not just purchases", async () => {
    const deps = baseDeps();
    const plan = await runPreflight(deps);
    for (const table of [...TRANSIENT_TABLES, "discount_codes", "bundles", "books", "series", "purchases"]) {
      expect(plan.deletionTargets, `expected deletionTargets to have a frozen entry for "${table}"`).toHaveProperty(table);
    }
  });

  it("hard-stops on a protected table before classifying purchases or building the storage plan", async () => {
    const callOrder: string[] = [];
    const deps = baseDeps({
      countRowsMatchingTraversal: vi.fn(async (table: string) => {
        callOrder.push(`count:${table}`);
        return table === "author_payouts" ? 1 : 0;
      }),
      fetchFixturePurchases: vi.fn(async () => {
        callOrder.push("fetch-purchases");
        return [];
      }),
      listStorageEntries: vi.fn(async () => {
        callOrder.push("list-storage");
        return [];
      }),
    });
    await expect(runPreflight(deps)).rejects.toBeInstanceOf(PreflightHardStopError);
    expect(callOrder).not.toContain("fetch-purchases");
    expect(callOrder).not.toContain("list-storage");
  });

  // PHASE-1C mandatory correction, item 6: refund_issuance_attempts is
  // in the protected list (dispositions.mts), so a non-zero count there
  // is caught by the same generic protected-table loop.
  it("hard-stops when refund_issuance_attempts has a matching row", async () => {
    const deps = baseDeps({
      countRowsMatchingTraversal: vi.fn(async (table: string) => (table === "refund_issuance_attempts" ? 1 : 0)),
    });
    const err = await runPreflight(deps).catch((e) => e);
    expect(err).toBeInstanceOf(PreflightHardStopError);
    expect((err as PreflightHardStopError).table).toBe("refund_issuance_attempts");
  });

  // PHASE-1C review round 4, item 4: the 3 zero-grant payout tables are
  // now checked in the SAME uniform loop as every other protected
  // table -- reset.mts makes no distinction; a non-zero count from any
  // of them hard-stops exactly like any other protected table would.
  it("hard-stops when a zero-grant payout table (routed through the RPC in live-deps.mts) has a non-zero count", async () => {
    const deps = baseDeps({
      countRowsMatchingTraversal: vi.fn(async (table: string) => (table === "payout_reversal" ? 1 : 0)),
    });
    const err = await runPreflight(deps).catch((e) => e);
    expect(err).toBeInstanceOf(PreflightHardStopError);
    expect((err as PreflightHardStopError).table).toBe("payout_reversal");
  });

  // PHASE-1C review round 3, item 6 / round 4, item 5.
  describe("external Stripe/payout identity hard-stop", () => {
    it("hard-stops if the author profile has a non-null stripe_account_id", async () => {
      const deps = baseDeps({
        getProfileExternalState: vi.fn().mockImplementation(async (id: string) =>
          id === AUTHOR_ID
            ? { avatarPath: null, stripeAccountId: "acct_real_looking", stripePayoutsEnabled: false }
            : { avatarPath: null, stripeAccountId: null, stripePayoutsEnabled: false },
        ),
      });
      await expect(runPreflight(deps)).rejects.toBeInstanceOf(PreflightHardStopError);
    });

    it("hard-stops if stripe_payouts_enabled is true even with a null account id", async () => {
      const deps = baseDeps({
        getProfileExternalState: vi.fn().mockResolvedValue({ avatarPath: null, stripeAccountId: null, stripePayoutsEnabled: true }),
      });
      await expect(runPreflight(deps)).rejects.toBeInstanceOf(PreflightHardStopError);
    });

    it("does not hard-stop on a null/false external state", async () => {
      const deps = baseDeps();
      await expect(runPreflight(deps)).resolves.toBeDefined();
    });
  });

  // PHASE-1C mandatory correction, item 3 / item 9's required test:
  // "Missing existing profile causes zero mutations."
  it("a missing profile (orphan) causes zero mutations of any kind", async () => {
    const deps = baseDeps({ getProfileById: vi.fn().mockResolvedValue(null) });
    await expect(runPreflight(deps)).rejects.toThrow();
    expect(deps.deleteByIds).not.toHaveBeenCalled();
    expect(deps.removeStorageObjects).not.toHaveBeenCalled();
    expect(deps.deleteUserById).not.toHaveBeenCalled();
  });

  // item 9's required test: "Storage collision/folder error causes zero
  // mutations." A file entry name shaped as a path-traversal attempt
  // reconstructs to a key that starts with the exact namespace prefix
  // STRING but doesn't actually stay under it -- discoverStorageObjects
  // must reject it (see storage-keys.test.ts), and that rejection must
  // propagate out of preflight before any delete call is ever made.
  it("an unexpected/malformed storage entry (path-traversal-shaped name) causes zero mutations", async () => {
    const deps = baseDeps({
      listStorageEntries: vi.fn().mockImplementation(async (_bucket: string, path: string) =>
        path === AUTHOR_ID ? [{ name: "../../some-other-author/evil.png", id: "id-1", metadata: { size: 10 } }] : [],
      ),
    });
    await expect(runPreflight(deps)).rejects.toThrow();
    expect(deps.deleteByIds).not.toHaveBeenCalled();
    expect(deps.removeStorageObjects).not.toHaveBeenCalled();
  });

  // item 9's required test: "Recent sign-in warning executes."
  it("records a recent-sign-in warning without hard-stopping", async () => {
    const deps = baseDeps({ listUsers: baseListUsers({ authorLastSignIn: "2026-01-01T11:58:00.000Z" }) });
    const plan = await runPreflight(deps);
    expect(plan.recentSignInWarnings).toContain("author");
  });

  // PHASE-1C review round 3, item 6 / round 4, item 2: storage
  // discovery now covers the author's namespace AND the reader's own
  // avatar AND manuscripts-tmp-avatar namespaces.
  describe("Storage discovery covers both accounts' full namespaces (round 4, item 2)", () => {
    it("includes the reader's own finalized avatar object, validated under the reader's namespace", async () => {
      const deps = baseDeps({
        listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) => {
          if (bucket === "avatars" && path === READER_ID) {
            return [{ name: "avatar.png", id: "id-1", metadata: { size: 42 } }];
          }
          return [];
        }),
      });
      const plan = await runPreflight(deps);
      expect(plan.storagePlan).toContainEqual({ bucket: "avatars", key: `${READER_ID}/avatar.png` });
    });

    // PHASE-1C review round 4, item 2's required regression test:
    // "Detect manuscripts/<reader-id>/tmp/avatar/..." -- avatar-field.tsx
    // stages the reader's TEMP avatar upload in the manuscripts bucket,
    // never avatars, confirmed directly against source.
    it("detects a reader's temp avatar object at manuscripts/<readerId>/tmp/avatar/<uuid>.<ext>", async () => {
      const deps = baseDeps({
        listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) => {
          if (bucket === "manuscripts" && path === READER_ID) {
            return [{ name: "tmp", id: null, metadata: null }];
          }
          if (bucket === "manuscripts" && path === `${READER_ID}/tmp`) {
            return [{ name: "avatar", id: null, metadata: null }];
          }
          if (bucket === "manuscripts" && path === `${READER_ID}/tmp/avatar`) {
            return [{ name: "9f2c-uuid.png", id: "id-1", metadata: { size: 2048 } }];
          }
          return [];
        }),
      });
      const plan = await runPreflight(deps);
      expect(plan.storagePlan).toContainEqual({ bucket: "manuscripts", key: `${READER_ID}/tmp/avatar/9f2c-uuid.png` });
    });

    // PHASE-1C review round 5, item 1's required regression test: "A
    // leftover at covers/<readerId>/... must be included in the frozen
    // deletion plan." Round 4 special-cased the reader to skip the
    // "covers" bucket entirely (reasoning: "no non-author ever writes
    // there") -- REJECTED by round 5: an anomalous object there must
    // still be discovered and cleaned up, symmetrically with every
    // other bucket, for BOTH accounts, with no special-cased exclusion.
    it("includes a leftover object at covers/<readerId>/... in the frozen deletion plan", async () => {
      const deps = baseDeps({
        listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) => {
          if (bucket === "covers" && path === READER_ID) {
            return [{ name: "anomalous-cover.png", id: "id-1", metadata: { size: 99 } }];
          }
          return [];
        }),
      });
      const plan = await runPreflight(deps);
      expect(plan.storagePlan).toContainEqual({ bucket: "covers", key: `${READER_ID}/anomalous-cover.png` });
    });

    // The author's namespace is scanned across all 3 buckets too --
    // symmetric with the reader, no bucket excluded either way.
    it("scans the author's namespace across avatars as well as covers/manuscripts", async () => {
      const deps = baseDeps({
        listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) => {
          if (bucket === "avatars" && path === AUTHOR_ID) {
            return [{ name: "avatar.png", id: "id-1", metadata: { size: 7 } }];
          }
          return [];
        }),
      });
      const plan = await runPreflight(deps);
      expect(plan.storagePlan).toContainEqual({ bucket: "avatars", key: `${AUTHOR_ID}/avatar.png` });
    });
  });

  describe("Storage postcondition failure on a covers/<readerId>/... leftover (round 5, item 1)", () => {
    it("reset-to-baseline: fails if a covers/<readerId>/... object survives mutation", async () => {
      const deps = baseDeps({
        readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
        listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) => {
          if (bucket === "covers" && path === READER_ID) {
            return [{ name: "leftover.png", id: "id-1", metadata: { size: 3 } }];
          }
          if (bucket === "covers" || bucket === "manuscripts") {
            const authorKeys = expectedBaselineObjectKeys(AUTHOR_ID)
              .filter((e) => e.bucket === bucket)
              .map((e) => e.key);
            const prefix = `${path}/`;
            const names = authorKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
            return names.map((name) => ({ name, id: `id:${name}`, metadata: { size: 10 } }));
          }
          return [];
        }),
      });
      await expect(runReset("reset-to-baseline", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
    });

    it("teardown: fails if a covers/<readerId>/... object survives mutation", async () => {
      const deps = baseDeps({
        readConfirmationPhrase: vi.fn().mockResolvedValue(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`),
        listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) =>
          bucket === "covers" && path === READER_ID ? [{ name: "leftover.png", id: "id-1", metadata: { size: 3 } }] : [],
        ),
      });
      await expect(runReset("teardown", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
    });
  });
});

describe("expectedConfirmationPhrase (item 9: derived from the guard's own validated ref)", () => {
  it("reset-to-baseline requires exactly the validated staging ref", async () => {
    const plan = await runPreflight(baseDeps());
    expect(expectedConfirmationPhrase("reset-to-baseline", plan)).toBe(STAGING_SUPABASE_PROJECT_REF);
  });

  it("teardown requires a stronger, distinct phrase built from the same validated ref", async () => {
    const plan = await runPreflight(baseDeps());
    expect(expectedConfirmationPhrase("teardown", plan)).toBe(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`);
  });
});

describe("runReset confirmation gating", () => {
  it("aborts with no mutation when the typed confirmation doesn't match", async () => {
    const deps = baseDeps({ readConfirmationPhrase: vi.fn().mockResolvedValue("wrong phrase") });
    await expect(runReset("reset-to-baseline", deps)).rejects.toBeInstanceOf(ConfirmationMismatchError);
    expect(deps.deleteByIds).not.toHaveBeenCalled();
    expect(deps.reseedBaseline).not.toHaveBeenCalled();
    expect(deps.deleteUserById).not.toHaveBeenCalled();
  });
});

describe("runReset('teardown', ...) never reseeds and deletes purchases before Auth users", () => {
  it("never calls reseedBaseline; deletes both auth users", async () => {
    const deps = baseDeps({ readConfirmationPhrase: vi.fn().mockResolvedValue(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`) });
    await runReset("teardown", deps);
    expect(deps.reseedBaseline).not.toHaveBeenCalled();
    expect(deps.deleteUserById).toHaveBeenCalledWith(AUTHOR_ID);
    expect(deps.deleteUserById).toHaveBeenCalledWith(READER_ID);
  });

  it("deletes purchases and every RESTRICT-dependent table strictly before deleting Auth users", async () => {
    const phaseOrder: string[] = [];
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`),
      onPhase: (phase) => phaseOrder.push(phase),
    });
    await runReset("teardown", deps);
    const purchasesIndex = phaseOrder.indexOf("delete-records:purchases");
    const authDeleteIndex = phaseOrder.indexOf("teardown:delete-auth-users");
    expect(purchasesIndex).toBeGreaterThanOrEqual(0);
    expect(authDeleteIndex).toBeGreaterThan(purchasesIndex);
  });

  // PHASE-1C mandatory correction, item 10 / item 9's required test:
  // "Teardown refuses changed Auth IDs."
  it("aborts before any Auth deletion if the re-resolved author id no longer matches the frozen plan", async () => {
    let call = 0;
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`),
      listUsers: (async (params) => {
        call++;
        // First two calls (preflight) resolve normally; subsequent calls
        // (teardown's re-verification) return a DIFFERENT author id.
        if (call <= 2) return baseListUsers()(params);
        return {
          users: [
            { id: "a-different-author-id", email: FIXTURE_AUTHOR_EMAIL, app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER }, last_sign_in_at: null },
            { id: READER_ID, email: FIXTURE_READER_EMAIL, app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER }, last_sign_in_at: null },
          ],
        };
      }) as ListUsersFn,
    });
    await expect(runReset("teardown", deps)).rejects.toBeInstanceOf(TeardownIdentityChangedError);
    expect(deps.deleteUserById).not.toHaveBeenCalled();
  });

  // item 9's required test: "Final postcondition failure prevents a
  // success result."
  it("throws PostconditionFailedError (not a success) if a deleted auth user is somehow still found afterward", async () => {
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`),
      getUserById: vi.fn().mockResolvedValue({ id: AUTHOR_ID, email: "x", app_metadata: {}, last_sign_in_at: null }),
    });
    await expect(runReset("teardown", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
  });

  // PHASE-1C review round 3, item 5 / round 4, item 6: teardown's
  // postcondition now verifies the database AND Storage independently,
  // via a FRESH recursive rediscovery -- never the frozen preflight
  // plan.
  it("fails the postcondition if a fixture-linked row somehow survives the delete phase", async () => {
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`),
      discoverFixtureLinkedRowIds: vi.fn().mockImplementation(async (table: string) => (table === "books" ? ["stray-book"] : [])),
    });
    await expect(runReset("teardown", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
  });

  it("fails the postcondition if a Storage object still exists (freshly rediscovered) after teardown", async () => {
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`),
      // removeStorageObjects "succeeds" (resolves) but the object is
      // still there on the fresh re-list -- exactly the failure mode a
      // frozen-plan-only check (round 3) could never catch.
      removeStorageObjects: vi.fn().mockResolvedValue(undefined),
    });
    await expect(runReset("teardown", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
  });

  // PHASE-1C review round 4, item 6's required regression test: "Detect
  // an object introduced after preflight during fresh postcondition
  // checks."
  it("detects a Storage object created AFTER preflight ran, during teardown's fresh postcondition discovery", async () => {
    let preflightDone = false;
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(`${STAGING_SUPABASE_PROJECT_REF} TEARDOWN`),
      onPhase: (phase) => {
        if (phase === "preflight:complete") preflightDone = true;
      },
      listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) => {
        // A brand-new object appears in the author's avatars bucket only
        // AFTER preflight has already finished building its plan.
        if (preflightDone && bucket === "avatars" && path === AUTHOR_ID) {
          return [{ name: "surprise.png", id: "id-late", metadata: { size: 5 } }];
        }
        return [];
      }),
    });
    await expect(runReset("teardown", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
  });
});

describe("runReset('reset-to-baseline', ...) preserves Auth users and reseeds", () => {
  it("calls reseedBaseline and never calls deleteUserById", async () => {
    const deps = baseDeps({ readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF) });
    await runReset("reset-to-baseline", deps);
    expect(deps.reseedBaseline).toHaveBeenCalledTimes(1);
    expect(deps.deleteUserById).not.toHaveBeenCalled();
  });

  it("deletes fixture-linked records and storage before reseeding, then verifies postconditions", async () => {
    const phaseOrder: string[] = [];
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
      onPhase: (phase) => phaseOrder.push(phase),
    });
    await runReset("reset-to-baseline", deps);
    const deleteComplete = phaseOrder.indexOf("delete-records:complete");
    const storageComplete = phaseOrder.indexOf("delete-storage:complete");
    const reseedStart = phaseOrder.indexOf("reseed:start");
    const postcondition = phaseOrder.indexOf("postcondition:reset-to-baseline:complete");
    expect(storageComplete).toBeGreaterThan(deleteComplete);
    expect(reseedStart).toBeGreaterThan(storageComplete);
    expect(postcondition).toBeGreaterThan(reseedStart);
    expect(phaseOrder).toContain("reset-to-baseline:success");
  });

  // PHASE-1C review round 3, item 6: avatar_path is converged back to
  // its safe baseline (null) for BOTH accounts before reseeding.
  it("converges both accounts' avatar_path baseline before reseeding", async () => {
    const phaseOrder: string[] = [];
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
      onPhase: (phase) => phaseOrder.push(phase),
    });
    await runReset("reset-to-baseline", deps);
    expect(deps.convergeProfileAvatarBaseline).toHaveBeenCalledWith(AUTHOR_ID);
    expect(deps.convergeProfileAvatarBaseline).toHaveBeenCalledWith(READER_ID);
    const convergeIndex = phaseOrder.indexOf("converge-avatar-baseline:complete");
    const reseedIndex = phaseOrder.indexOf("reseed:start");
    expect(convergeIndex).toBeGreaterThanOrEqual(0);
    expect(reseedIndex).toBeGreaterThan(convergeIndex);
  });

  it("fails the postcondition if a supposedly-deleted transient table still has rows after the delete phase", async () => {
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
      discoverFixtureLinkedRowIds: vi.fn().mockImplementation(async (table: string) => (table === "reviews" ? ["stray-review-id"] : [])),
    });
    await expect(runReset("reset-to-baseline", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
  });

  // PHASE-1C review round 3, item 2: a baseline table must contain
  // EXACTLY the expected reseeded rows -- an extra/unexpected row is
  // just as much a failure as a missing one, and "empty" is never
  // correct for these tables.
  it("fails the postcondition if a baseline table has an extra, unexpected row after reseeding", async () => {
    const expectedBaseline = baselineTableRowIds();
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
      discoverFixtureLinkedRowIds: vi.fn().mockImplementation(async (table: string) => {
        if (TRANSIENT_TABLES.includes(table)) return [];
        if (table === "books") return [...(expectedBaseline.books ?? []), "stray-extra-book-id"];
        return expectedBaseline[table] ?? [];
      }),
    });
    await expect(runReset("reset-to-baseline", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
  });

  it("fails the postcondition if a baseline table is missing an expected reseeded row", async () => {
    const expectedBaseline = baselineTableRowIds();
    const deps = baseDeps({
      readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
      discoverFixtureLinkedRowIds: vi.fn().mockImplementation(async (table: string) => {
        if (TRANSIENT_TABLES.includes(table)) return [];
        if (table === "series") return [];
        return expectedBaseline[table] ?? [];
      }),
    });
    await expect(runReset("reset-to-baseline", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
  });

  // PHASE-1C review round 4, item 6: Storage postcondition uses a FRESH
  // recursive re-discovery, not the frozen preflight plan -- the
  // author must hold EXACTLY the 10 baseline objects and nothing else,
  // the reader must hold nothing at all.
  describe("Storage postcondition (round 4, item 6)", () => {
    it("fails if the author's Storage namespace is missing an expected baseline object after reseeding", async () => {
      const deps = baseDeps({
        readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
        reseedBaseline: vi.fn().mockImplementation(async (ctx) => ctx), // never re-uploads anything
      });
      await expect(runReset("reset-to-baseline", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
    });

    it("fails if the author's Storage namespace has an unexpected extra object after reseeding", async () => {
      let reseeded = false;
      const deps = baseDeps({
        readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
        onPhase: (phase) => {
          if (phase === "reseed:complete") reseeded = true;
        },
        // Honestly report the correct 10 baseline covers/manuscripts
        // objects at every point (so ONLY the extra avatar object is
        // what makes this fail), plus one unexpected avatar object that
        // only appears after reseeding.
        listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) => {
          if (reseeded && bucket === "avatars" && path === AUTHOR_ID) {
            return [{ name: "stray.png", id: "id-stray", metadata: { size: 3 } }];
          }
          if (bucket === "covers" || bucket === "manuscripts") {
            const authorKeys = expectedBaselineObjectKeys(AUTHOR_ID)
              .filter((e) => e.bucket === bucket)
              .map((e) => e.key);
            const prefix = `${path}/`;
            const names = authorKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
            return names.map((name) => ({ name, id: `id:${name}`, metadata: { size: 10 } }));
          }
          return [];
        }),
      });
      await expect(runReset("reset-to-baseline", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
    });

    it("fails if the reader's Storage namespace still has an object after reset-to-baseline", async () => {
      const deps = baseDeps({
        readConfirmationPhrase: vi.fn().mockResolvedValue(STAGING_SUPABASE_PROJECT_REF),
        listStorageEntries: vi.fn().mockImplementation(async (bucket: string, path: string) => {
          if (bucket === "avatars" && path === READER_ID) {
            return [{ name: "leftover.png", id: "id-leftover", metadata: { size: 3 } }];
          }
          if (bucket === "covers" || bucket === "manuscripts") {
            const authorKeys = expectedBaselineObjectKeys(AUTHOR_ID)
              .filter((e) => e.bucket === bucket)
              .map((e) => e.key);
            const prefix = `${path}/`;
            const names = authorKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
            return names.map((name) => ({ name, id: `id:${name}`, metadata: { size: 10 } }));
          }
          return [];
        }),
      });
      await expect(runReset("reset-to-baseline", deps)).rejects.toBeInstanceOf(PostconditionFailedError);
    });
  });
});

describe("CLI guard failure constructs no client (item 5's required test, reset side)", () => {
  it("runPreflight throws before touching any dep when the staging target is wrong", async () => {
    process.env.STAGING_FIXTURE_SUPABASE_URL = "https://pwkukotgpsegieshulpj.supabase.co";
    const deps = baseDeps();
    await expect(runPreflight(deps)).rejects.toThrow();
    expect(deps.listUsers).not.toHaveBeenCalled();
  });
});
