import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSeed, SeedExternalStateHardStopError, type SeedDeps } from "./seed.mts";
import { UnsafeStagingTargetError, STAGING_SUPABASE_PROJECT_REF } from "./guard.mts";
import { FixtureOwnershipMarkerError } from "./auth-ownership.mts";
import {
  FIXTURE_PURCHASE_TARGET_BOOK_ID,
  FIXTURE_DISCOUNT_TARGET_BOOK_ID,
  FIXTURE_AUTHOR_EMAIL,
  FIXTURE_READER_EMAIL,
  FIXTURE_BOOKS,
  FIXTURE_OWNERSHIP_MARKER,
  FIXTURE_BUNDLE_ID,
  FIXTURE_BUNDLE_MEMBERSHIPS,
} from "./manifest.mts";

const AUTHOR_ID = "new-author-id";
const READER_ID = "new-reader-id";

function baseDeps(overrides: Partial<SeedDeps> = {}): SeedDeps {
  const profiles = new Map<string, { role: string; display_name: string; public_author_name: string | null; bio: string | null }>();
  const books = new Map<string, { id: string; title: string; status: string }>();
  const uploadedSizes = new Map<string, number>();

  return {
    listUsers: vi.fn().mockResolvedValue({ users: [] }),
    createUser: vi.fn().mockImplementation(async (attrs) => {
      const id = attrs.email === FIXTURE_AUTHOR_EMAIL ? AUTHOR_ID : READER_ID;
      // Simulate the handle_new_user() trigger creating a profile.
      profiles.set(id, { role: attrs.user_metadata.role, display_name: attrs.user_metadata.display_name, public_author_name: null, bio: null });
      return { id };
    }),
    deleteUserById: vi.fn().mockImplementation(async (id: string) => {
      profiles.delete(id);
    }),
    updateUserById: vi.fn().mockResolvedValue(undefined),
    getProfileById: vi.fn().mockImplementation(async (id: string) => profiles.get(id) ?? null),
    upsertProfile: vi.fn().mockImplementation(async (id: string, fields) => {
      profiles.set(id, fields);
      return { affectedRows: 1 };
    }),
    requiredPassword: vi.fn().mockReturnValue("test-password-not-real"),
    uploadObject: vi.fn().mockImplementation(async (bucket: string, key: string, bytes: Buffer) => {
      uploadedSizes.set(`${bucket}:${key}`, bytes.length);
    }),
    verifyObjectSize: vi.fn().mockImplementation(async (bucket: string, key: string) => ({
      sizeBytes: uploadedSizes.get(`${bucket}:${key}`) ?? null,
    })),
    upsertSeries: vi.fn().mockResolvedValue(undefined),
    upsertBook: vi.fn().mockImplementation(async (book) => {
      books.set(book.id, { id: book.id, title: book.title, status: book.status });
    }),
    upsertContributor: vi.fn().mockResolvedValue(undefined),
    upsertBundle: vi.fn().mockResolvedValue(undefined),
    upsertBundleBooks: vi.fn().mockResolvedValue(undefined),
    upsertDiscountCode: vi.fn().mockResolvedValue(undefined),
    upsertPurchase: vi.fn().mockResolvedValue(undefined),
    getProfileExternalState: vi.fn().mockResolvedValue({ avatarPath: null, stripeAccountId: null, stripePayoutsEnabled: false }),
    convergeProfileAvatarBaseline: vi.fn().mockResolvedValue(undefined),
    getUserById: vi.fn().mockImplementation(async (id: string) => (profiles.has(id) ? { id } : id === AUTHOR_ID || id === READER_ID ? { id } : null)),
    getBookById: vi.fn().mockImplementation(async (id: string) => books.get(id) ?? null),
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

describe("runSeed guard-first ordering (item 5's required test, seed side)", () => {
  it("calls no deps function at all when the staging guard rejects the target", async () => {
    process.env.STAGING_FIXTURE_SUPABASE_URL = "https://pwkukotgpsegieshulpj.supabase.co";
    const deps = baseDeps();
    await expect(runSeed(deps)).rejects.toBeInstanceOf(UnsafeStagingTargetError);
    for (const [key, value] of Object.entries(deps)) {
      if (typeof value === "function" && "mock" in value) {
        expect(value, `expected ${key} not to have been called`).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects a missing target URL before any mutation", async () => {
    delete process.env.STAGING_FIXTURE_SUPABASE_URL;
    const deps = baseDeps();
    await expect(runSeed(deps)).rejects.toBeInstanceOf(UnsafeStagingTargetError);
    expect(deps.listUsers).not.toHaveBeenCalled();
  });
});

describe("runSeed dependency ordering", () => {
  it("upserts series before any book, and books before the bundle", async () => {
    const phaseOrder: string[] = [];
    const deps = baseDeps({ onPhase: (p) => phaseOrder.push(p) });
    await runSeed(deps);

    const seriesIndex = phaseOrder.indexOf("series:upserted");
    const firstBookIndex = phaseOrder.findIndex((p) => p.startsWith("book:"));
    const bundleIndex = phaseOrder.indexOf("bundle:upserted");
    const discountIndex = phaseOrder.indexOf("discount-code:upserted");
    const purchaseIndex = phaseOrder.indexOf("purchase:upserted");
    const postconditionIndex = phaseOrder.indexOf("postcondition:complete");

    expect(seriesIndex).toBeGreaterThanOrEqual(0);
    expect(firstBookIndex).toBeGreaterThan(seriesIndex);
    expect(bundleIndex).toBeGreaterThan(firstBookIndex);
    expect(discountIndex).toBeGreaterThan(bundleIndex);
    expect(purchaseIndex).toBeGreaterThan(discountIndex);
    expect(postconditionIndex).toBeGreaterThan(purchaseIndex);
  });

  it("uploads and verifies storage objects for every fixture book before upserting its row", async () => {
    const uploadCalls: string[] = [];
    const upsertCalls: string[] = [];
    const sizes = new Map<string, number>();
    const deps = baseDeps({
      uploadObject: vi.fn(async (bucket: string, key: string, bytes: Buffer) => {
        uploadCalls.push(key);
        sizes.set(`${bucket}:${key}`, bytes.length);
      }),
      verifyObjectSize: vi.fn(async (bucket: string, key: string) => ({ sizeBytes: sizes.get(`${bucket}:${key}`) ?? null })),
      upsertBook: vi.fn(async (book) => {
        upsertCalls.push(book.id);
      }),
      getBookById: vi.fn(async (id: string) =>
        upsertCalls.includes(id) ? { id, title: "x", status: FIXTURE_BOOKS.find((b) => b.id === id)!.status } : null,
      ),
    });
    await runSeed(deps);
    expect(upsertCalls.length).toBe(FIXTURE_BOOKS.length);
    expect(uploadCalls.length).toBe(FIXTURE_BOOKS.length * 2);
  });

  // PHASE-1C mandatory correction, item 8 / item 9's required test:
  // "Size mismatch stops before the corresponding book row upsert."
  it("throws and does not upsert the book row if the uploaded size doesn't match the exact expected length", async () => {
    const deps = baseDeps({
      verifyObjectSize: vi.fn().mockResolvedValue({ sizeBytes: 999999 }), // never matches the real byte length
    });
    await expect(runSeed(deps)).rejects.toThrow(/size mismatch/);
    expect(deps.upsertBook).not.toHaveBeenCalled();
  });

  it("throws on a null size (object not found) rather than treating it as success", async () => {
    const deps = baseDeps({ verifyObjectSize: vi.fn().mockResolvedValue({ sizeBytes: null }) });
    await expect(runSeed(deps)).rejects.toThrow(/null \(not found\)/);
    expect(deps.upsertBook).not.toHaveBeenCalled();
  });
});

// PHASE-1C review round 4, item 1's required regression test: "assert
// the live bundle_books payload contains the manifest's fixed IDs" --
// at the seed orchestration boundary, proving runSeed passes the ACTUAL
// membership objects through to upsertBundleBooks, not merely a bare
// list of book ids a real adapter could only insert with a fresh
// gen_random_uuid() id every time.
describe("runSeed passes the manifest's fixed bundle_books membership ids through (round 4, item 1)", () => {
  it("calls upsertBundleBooks with the exact FIXTURE_BUNDLE_MEMBERSHIPS objects, each carrying its own fixed id", async () => {
    const deps = baseDeps();
    await runSeed(deps);
    expect(deps.upsertBundleBooks).toHaveBeenCalledWith(FIXTURE_BUNDLE_ID, FIXTURE_BUNDLE_MEMBERSHIPS);
    const [, memberships] = (deps.upsertBundleBooks as ReturnType<typeof vi.fn>).mock.calls[0];
    for (const membership of FIXTURE_BUNDLE_MEMBERSHIPS) {
      expect(memberships).toContainEqual(membership);
      expect(typeof membership.id).toBe("string");
      expect(membership.id.length).toBeGreaterThan(0);
    }
  });
});

describe("runSeed places the discount code and purchase on the correct books", () => {
  it("purchase targets the owned-review book (P1), discount targets the wishlist book (P2)", async () => {
    const deps = baseDeps();
    await runSeed(deps);
    expect(deps.upsertPurchase).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      FIXTURE_PURCHASE_TARGET_BOOK_ID,
      expect.any(Number),
    );
    expect(deps.upsertDiscountCode).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      FIXTURE_DISCOUNT_TARGET_BOOK_ID,
    );
  });
});

describe("runSeed ownership-marker gating (item 2)", () => {
  it("hard-stops before ANY mutation if either account's email matches with no marker", async () => {
    const deps = baseDeps({
      listUsers: vi.fn().mockResolvedValue({
        users: [{ id: "unmarked", email: FIXTURE_AUTHOR_EMAIL, app_metadata: {}, last_sign_in_at: null }],
      }),
    });
    await expect(runSeed(deps)).rejects.toBeInstanceOf(FixtureOwnershipMarkerError);
    expect(deps.createUser).not.toHaveBeenCalled();
    expect(deps.deleteUserById).not.toHaveBeenCalled();
    expect(deps.updateUserById).not.toHaveBeenCalled();
  });
});

// PHASE-1C mandatory correction, item 3 / item 9's required test:
// "Reused app_metadata is preserved" -- proven through the ASSEMBLED
// runSeed workflow, not just the isolated convergeAuthUser helper.
describe("runSeed preserves a reused account's unrelated app_metadata (assembled)", () => {
  it("merges the reused author's actual existing app_metadata into the update call", async () => {
    const existingAppMetadata = { librum_fixture: FIXTURE_OWNERSHIP_MARKER, some_unrelated_key: "keep-me" };
    const deps = baseDeps({
      listUsers: vi.fn().mockResolvedValue({
        users: [
          { id: AUTHOR_ID, email: FIXTURE_AUTHOR_EMAIL, app_metadata: existingAppMetadata, last_sign_in_at: null },
          { id: READER_ID, email: FIXTURE_READER_EMAIL, app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER }, last_sign_in_at: null },
        ],
      }),
      getProfileById: vi.fn().mockResolvedValue({ role: "author", display_name: "x", public_author_name: "x", bio: null }),
    });
    await runSeed(deps);
    expect(deps.updateUserById).toHaveBeenCalledWith(
      AUTHOR_ID,
      expect.objectContaining({
        app_metadata: expect.objectContaining({ some_unrelated_key: "keep-me" }),
      }),
    );
  });
});

// PHASE-1C mandatory correction, item 2 / item 9's required test:
// "Missing existing profile causes zero mutations" (seed side: an
// ORPHAN -- marker valid, no profile -- must be repaired via exact-ID
// delete+recreate, never silently skipped, and must not proceed to
// upsert any book/series/etc. data using a stale id).
describe("runSeed orphan repair (item 2)", () => {
  it("repairs a marker-valid orphan by exact-ID delete, then creates fresh", async () => {
    const deps = baseDeps({
      listUsers: vi.fn().mockResolvedValue({
        users: [{ id: "orphan-id", email: FIXTURE_AUTHOR_EMAIL, app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER }, last_sign_in_at: null }],
      }),
      getProfileById: vi.fn().mockImplementation(async (id: string) => (id === "orphan-id" ? null : { role: "author", display_name: "x", public_author_name: "x", bio: null })),
    });
    await runSeed(deps);
    expect(deps.deleteUserById).toHaveBeenCalledWith("orphan-id");
    expect(deps.createUser).toHaveBeenCalled();
  });
});

// PHASE-1C review round 3, item 6 / round 4, item 5: real external
// Stripe Connect state has no reviewed safe convergence procedure -- a
// non-null/true value is a hard-stop, never silently overwritten or
// ignored, and (round 4) is checked during READ-ONLY DISCOVERY, before
// ANY mutation of any kind for either account.
function bothAccountsValidListUsers() {
  return vi.fn().mockResolvedValue({
    users: [
      { id: AUTHOR_ID, email: FIXTURE_AUTHOR_EMAIL, app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER }, last_sign_in_at: null },
      { id: READER_ID, email: FIXTURE_READER_EMAIL, app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER }, last_sign_in_at: null },
    ],
  });
}

describe("runSeed external Stripe/payout identity hard-stop (round 3, item 6 / round 4, item 5)", () => {
  it("hard-stops before any Auth convergence if a reused account has a non-null stripe_account_id", async () => {
    const deps = baseDeps({
      listUsers: bothAccountsValidListUsers(),
      getProfileById: vi.fn().mockResolvedValue({ role: "author", display_name: "x", public_author_name: "x", bio: null }),
      getProfileExternalState: vi.fn().mockImplementation(async (id: string) =>
        id === AUTHOR_ID
          ? { avatarPath: null, stripeAccountId: "acct_real_looking", stripePayoutsEnabled: false }
          : { avatarPath: null, stripeAccountId: null, stripePayoutsEnabled: false },
      ),
    });
    await expect(runSeed(deps)).rejects.toBeInstanceOf(SeedExternalStateHardStopError);
    expect(deps.updateUserById).not.toHaveBeenCalled();
    expect(deps.upsertProfile).not.toHaveBeenCalled();
    expect(deps.deleteUserById).not.toHaveBeenCalled();
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it("hard-stops if stripe_payouts_enabled is true even with a null account id", async () => {
    const deps = baseDeps({
      listUsers: bothAccountsValidListUsers(),
      getProfileById: vi.fn().mockResolvedValue({ role: "author", display_name: "x", public_author_name: "x", bio: null }),
      getProfileExternalState: vi.fn().mockResolvedValue({ avatarPath: null, stripeAccountId: null, stripePayoutsEnabled: true }),
    });
    await expect(runSeed(deps)).rejects.toBeInstanceOf(SeedExternalStateHardStopError);
  });

  it("proceeds normally when external state is null/false for both accounts", async () => {
    const deps = baseDeps();
    await expect(runSeed(deps)).resolves.toBeDefined();
  });

  it("never calls getProfileExternalState for a not_found account (nothing exists yet to check)", async () => {
    const deps = baseDeps(); // default: listUsers -> [] -> both "not_found"
    await runSeed(deps);
    expect(deps.getProfileExternalState).not.toHaveBeenCalled();
  });

  // PHASE-1C review round 4, item 5's required regression test: one
  // account absent/orphaned, the other valid and Stripe-connected --
  // must hard-stop before ANY mutation, including the orphan's own
  // repair-delete.
  it("hard-stops before ANY mutation when one account is orphaned and the other is valid+Stripe-connected", async () => {
    const deps = baseDeps({
      listUsers: vi.fn().mockResolvedValue({
        users: [
          { id: "orphan-id", email: FIXTURE_AUTHOR_EMAIL, app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER }, last_sign_in_at: null },
          { id: READER_ID, email: FIXTURE_READER_EMAIL, app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER }, last_sign_in_at: null },
        ],
      }),
      getProfileById: vi.fn().mockImplementation(async (id: string) =>
        id === "orphan-id" ? null : { role: "reader", display_name: "x", public_author_name: null, bio: null },
      ),
      getProfileExternalState: vi.fn().mockImplementation(async (id: string) =>
        id === READER_ID
          ? { avatarPath: null, stripeAccountId: "acct_real_looking", stripePayoutsEnabled: false }
          : { avatarPath: null, stripeAccountId: null, stripePayoutsEnabled: false },
      ),
    });
    await expect(runSeed(deps)).rejects.toBeInstanceOf(SeedExternalStateHardStopError);
    // Zero mutation of ANY kind -- not even the orphan's own repair-delete.
    expect(deps.deleteUserById).not.toHaveBeenCalled();
    expect(deps.createUser).not.toHaveBeenCalled();
    expect(deps.updateUserById).not.toHaveBeenCalled();
    expect(deps.upsertProfile).not.toHaveBeenCalled();
    expect(deps.convergeProfileAvatarBaseline).not.toHaveBeenCalled();
    expect(deps.uploadObject).not.toHaveBeenCalled();
    expect(deps.upsertSeries).not.toHaveBeenCalled();
    expect(deps.upsertBook).not.toHaveBeenCalled();
    expect(deps.upsertBundleBooks).not.toHaveBeenCalled();
    expect(deps.upsertPurchase).not.toHaveBeenCalled();
  });
});

// PHASE-1C review round 3, item 6: avatar_path converges back to its
// defined safe baseline (null) for BOTH accounts, after profile field
// convergence and before any Storage/book upload work.
describe("runSeed avatar_path baseline convergence (round 3, item 6)", () => {
  it("converges avatar_path for both accounts", async () => {
    const deps = baseDeps();
    await runSeed(deps);
    expect(deps.convergeProfileAvatarBaseline).toHaveBeenCalledWith(AUTHOR_ID);
    expect(deps.convergeProfileAvatarBaseline).toHaveBeenCalledWith(READER_ID);
  });

  it("converges avatar baseline after profile convergence but before series/book upserts", async () => {
    const phaseOrder: string[] = [];
    const deps = baseDeps({ onPhase: (p) => phaseOrder.push(p) });
    await runSeed(deps);
    const profilesIndex = phaseOrder.indexOf("profiles:converged");
    const avatarIndex = phaseOrder.indexOf("avatar-baseline:converged");
    const seriesIndex = phaseOrder.indexOf("series:upserted");
    expect(avatarIndex).toBeGreaterThan(profilesIndex);
    expect(seriesIndex).toBeGreaterThan(avatarIndex);
  });
});
