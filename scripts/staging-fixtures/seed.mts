// PHASE-1C: `seed` is for INITIAL fixture setup or a DELIBERATE,
// intentional convergence of the baseline's own fields -- see README.md.
// It does not delete transient QA-created rows, but it DOES overwrite
// baseline state (password, confirmation/ban state, metadata, storage
// bytes, and every baseline row's fields) unconditionally on every run.
// Do not run it during an active QA journey, and never run it (or
// reset/teardown) while another person is signed into the fixture
// accounts -- see auth-ownership.mts's convergeAuthUser, which always
// issues a fresh password/ban-state/metadata update.
import { assertStagingTargetFromEnv } from "./guard.mts";
import {
  FIXTURE_AUTHOR_EMAIL,
  FIXTURE_READER_EMAIL,
  FIXTURE_AUTHOR_DISPLAY_NAME,
  FIXTURE_READER_DISPLAY_NAME,
  FIXTURE_AUTHOR_ROLE,
  FIXTURE_READER_ROLE,
  FIXTURE_SERIES_ID,
  FIXTURE_BUNDLE_ID,
  FIXTURE_BUNDLE_MEMBERSHIPS,
  FIXTURE_DISCOUNT_CODE_ID,
  FIXTURE_DISCOUNT_TARGET_BOOK_ID,
  FIXTURE_PURCHASE_ID,
  FIXTURE_PURCHASE_TARGET_BOOK_ID,
  FIXTURE_PURCHASE_AMOUNT_CENTS,
  FIXTURE_CONTRIBUTOR_ID,
  FIXTURE_BOOKS,
  fixtureCoverPath,
  fixtureManuscriptPath,
  buildFixtureCoverBytes,
  buildFixtureEpubBytes,
  type FixtureBookDefinition,
  type FixtureBundleMembership,
} from "./manifest.mts";
import {
  discoverFixtureUser,
  repairOrphanIfNeeded,
  createFixtureUserWithProfileVerification,
  convergeAuthUser,
  convergeExistingUserProfile,
  convergeNewUserProfile,
  FixtureOwnershipMarkerError,
  type ListUsersFn,
  type CreateUserFn,
  type DeleteUserByIdFn,
  type UpdateUserByIdFn,
  type GetProfileByIdFn,
  type UpsertProfileFn,
  type DiscoveredFixtureUser,
} from "./auth-ownership.mts";

export class SeedPostconditionFailedError extends Error {}
// PHASE-1C review round 3, item 6: real external Stripe Connect state
// this design has no reviewed safe convergence procedure for.
export class SeedExternalStateHardStopError extends Error {}

export type SeedDeps = {
  listUsers: ListUsersFn;
  createUser: CreateUserFn;
  deleteUserById: DeleteUserByIdFn;
  updateUserById: UpdateUserByIdFn;
  getProfileById: GetProfileByIdFn;
  upsertProfile: UpsertProfileFn;
  requiredPassword: (which: "author" | "reader") => string;
  uploadObject: (bucket: "covers" | "manuscripts", key: string, bytes: Buffer, contentType: string) => Promise<void>;
  // PHASE-1C mandatory correction, item 8: reports the ACTUAL post-
  // upload size (or null if the object can't be found at all) -- never
  // just a boolean "exists".
  verifyObjectSize: (bucket: "covers" | "manuscripts", key: string) => Promise<{ sizeBytes: number | null }>;
  upsertSeries: (id: string, authorId: string) => Promise<void>;
  upsertBook: (
    book: FixtureBookDefinition,
    authorId: string,
    coverPath: string,
    manuscriptPath: string,
  ) => Promise<void>;
  upsertContributor: (id: string, bookId: string) => Promise<void>;
  upsertBundle: (id: string, authorId: string) => Promise<void>;
  // PHASE-1C review round 4, item 1: takes the manifest's ACTUAL
  // membership objects (each carrying its own fixed `id`), never merely
  // bundle-to-book pairs -- bundle_books.id has no other unique
  // constraint to converge on (only (bundle_id, book_id) does), so
  // omitting the fixed id here would let Postgres assign a fresh random
  // one on every first insert, defeating baselineTableRowIds()'s exact-
  // id postcondition check.
  upsertBundleBooks: (bundleId: string, memberships: readonly FixtureBundleMembership[]) => Promise<void>;
  upsertDiscountCode: (id: string, authorId: string, bookId: string) => Promise<void>;
  upsertPurchase: (id: string, readerId: string, bookId: string, amountCents: number) => Promise<void>;
  // PHASE-1C review round 3, item 6: real external Stripe Connect state
  // has no reviewed safe convergence procedure -- a non-null/true value
  // is a hard-stop, never silently overwritten or ignored.
  getProfileExternalState: (
    id: string,
  ) => Promise<{ avatarPath: string | null; stripeAccountId: string | null; stripePayoutsEnabled: boolean }>;
  // Converges avatar_path back to its defined safe baseline (null).
  convergeProfileAvatarBaseline: (id: string) => Promise<void>;
  // Postcondition verification (item 11) -- reread, never inferred from
  // a mutation call's own "no error" result.
  getUserById: (id: string) => Promise<{ id: string } | null>;
  getBookById: (id: string) => Promise<{ id: string; title: string; status: string } | null>;
  onPhase?: (phase: string) => void;
};

function emit(deps: SeedDeps, phase: string) {
  deps.onPhase?.(phase);
}

// PHASE-1C mandatory correction, item 2: both accounts are fully
// DISCOVERED and marker-validated before EITHER is repaired or created.
async function discoverBoth(deps: SeedDeps): Promise<{ author: DiscoveredFixtureUser; reader: DiscoveredFixtureUser }> {
  const author = await discoverFixtureUser({
    listUsers: deps.listUsers,
    getProfileById: deps.getProfileById,
    email: FIXTURE_AUTHOR_EMAIL,
  });
  const reader = await discoverFixtureUser({
    listUsers: deps.listUsers,
    getProfileById: deps.getProfileById,
    email: FIXTURE_READER_EMAIL,
  });

  for (const [discovered, email] of [
    [author, FIXTURE_AUTHOR_EMAIL],
    [reader, FIXTURE_READER_EMAIL],
  ] as const) {
    if (discovered.kind === "marker_missing") {
      throw new FixtureOwnershipMarkerError(
        `An account already exists at ${email} with no fixture ownership marker -- refusing to touch it. ` +
          "No mutation was attempted for EITHER fixture account.",
      );
    }
    if (discovered.kind === "marker_conflict") {
      throw new FixtureOwnershipMarkerError(
        `An account already exists at ${email} with a CONFLICTING fixture ownership marker -- refusing ` +
          "to touch it. No mutation was attempted for EITHER fixture account.",
      );
    }
  }

  return { author, reader };
}

type ResolvedAccount = {
  id: string;
  wasCreated: boolean;
  existingAppMetadata: Record<string, unknown> | null | undefined;
};

async function resolveAfterDiscovery(
  deps: SeedDeps,
  discovered: DiscoveredFixtureUser,
  email: string,
  password: string,
  role: "author" | "reader",
  displayName: string,
): Promise<ResolvedAccount> {
  // Only "orphan" and "not_found" reach here -- marker problems already
  // threw in discoverBoth(), and "valid" is handled by the caller
  // without needing repair/create at all.
  const repaired = await repairOrphanIfNeeded({ deleteUserById: deps.deleteUserById }, discovered);
  if (repaired.kind === "valid") {
    return { id: repaired.user.id, wasCreated: false, existingAppMetadata: repaired.user.app_metadata };
  }
  const created = await createFixtureUserWithProfileVerification({
    createUser: deps.createUser,
    deleteUserById: deps.deleteUserById,
    getProfileById: deps.getProfileById,
    email,
    password,
    role,
    displayName,
  });
  return { id: created.id, wasCreated: true, existingAppMetadata: null };
}

export async function runSeed(deps: SeedDeps): Promise<{ authorId: string; readerId: string }> {
  // The guard runs before ANY Supabase interaction -- the very first
  // statement, before any deps.* call.
  assertStagingTargetFromEnv();
  emit(deps, "guard:passed");

  // ---- Phase 1: discover + validate BOTH accounts (read-only except
  // the internal profile-existence check) before repairing/creating
  // EITHER (item 2). ----
  const { author: authorDiscovered, reader: readerDiscovered } = await discoverBoth(deps);
  emit(deps, `discover:author:${authorDiscovered.kind}`);
  emit(deps, `discover:reader:${readerDiscovered.kind}`);

  // ---- Phase 1.5: hard-stop on real external Stripe/payout state for
  // any ALREADY-EXISTING ("valid") account, BEFORE any mutation of any
  // kind -- including orphan repair (a DELETE) or account creation for
  // the OTHER account (PHASE-1C review round 4, item 5: the round-3
  // check ran AFTER resolveAfterDiscovery for both accounts, meaning an
  // orphan-repair delete or a fresh account creation could already have
  // happened for one account before the other's Stripe state was ever
  // checked). An "orphan" or "not_found" account has no profiles row
  // yet at all, so there is nothing to check for it here -- it will
  // simply be created/repaired fresh, with null/false external state by
  // construction. ----
  for (const [discovered, label] of [
    [authorDiscovered, "author"],
    [readerDiscovered, "reader"],
  ] as const) {
    if (discovered.kind !== "valid") continue;
    const state = await deps.getProfileExternalState(discovered.user.id);
    if (state.stripeAccountId !== null || state.stripePayoutsEnabled === true) {
      throw new SeedExternalStateHardStopError(
        `seed: existing fixture ${label} profile ${discovered.user.id} has a non-null ` +
          "stripe_account_id or stripe_payouts_enabled=true -- real external Stripe Connect state " +
          "this design has no reviewed safe convergence procedure for. Refusing to proceed with ANY " +
          "mutation for either account, including repair/creation of the other account.",
      );
    }
  }
  emit(deps, "external-state:checked");

  // ---- Phase 2: repair orphans / create absent (only now, item 2). ----
  const authorResolved =
    authorDiscovered.kind === "valid"
      ? { id: authorDiscovered.user.id, wasCreated: false, existingAppMetadata: authorDiscovered.user.app_metadata }
      : await resolveAfterDiscovery(
          deps,
          authorDiscovered,
          FIXTURE_AUTHOR_EMAIL,
          deps.requiredPassword("author"),
          "author",
          FIXTURE_AUTHOR_DISPLAY_NAME,
        );
  emit(deps, `auth:author:${authorResolved.wasCreated ? "created" : "reused"}`);

  const readerResolved =
    readerDiscovered.kind === "valid"
      ? { id: readerDiscovered.user.id, wasCreated: false, existingAppMetadata: readerDiscovered.user.app_metadata }
      : await resolveAfterDiscovery(
          deps,
          readerDiscovered,
          FIXTURE_READER_EMAIL,
          deps.requiredPassword("reader"),
          "reader",
          FIXTURE_READER_DISPLAY_NAME,
        );
  emit(deps, `auth:reader:${readerResolved.wasCreated ? "created" : "reused"}`);

  // ---- Phase 3: converge Auth state. PHASE-1C mandatory correction,
  // item 3: the REUSED account's ACTUAL existing app_metadata is passed
  // -- never `{}` -- so unrelated keys survive. ----
  await convergeAuthUser({
    updateUserById: deps.updateUserById,
    id: authorResolved.id,
    password: deps.requiredPassword("author"),
    role: "author",
    displayName: FIXTURE_AUTHOR_DISPLAY_NAME,
    existingAppMetadata: authorResolved.existingAppMetadata,
  });
  await convergeAuthUser({
    updateUserById: deps.updateUserById,
    id: readerResolved.id,
    password: deps.requiredPassword("reader"),
    role: "reader",
    displayName: FIXTURE_READER_DISPLAY_NAME,
    existingAppMetadata: readerResolved.existingAppMetadata,
  });
  emit(deps, "auth:converged");

  // ---- Phase 4: converge profiles. ----
  const converge = authorResolved.wasCreated ? convergeNewUserProfile : convergeExistingUserProfile;
  await converge({
    upsertProfile: deps.upsertProfile,
    id: authorResolved.id,
    role: FIXTURE_AUTHOR_ROLE,
    displayName: FIXTURE_AUTHOR_DISPLAY_NAME,
    publicAuthorName: FIXTURE_AUTHOR_DISPLAY_NAME,
    bio: null,
  });
  const convergeReader = readerResolved.wasCreated ? convergeNewUserProfile : convergeExistingUserProfile;
  await convergeReader({
    upsertProfile: deps.upsertProfile,
    id: readerResolved.id,
    role: FIXTURE_READER_ROLE,
    displayName: FIXTURE_READER_DISPLAY_NAME,
    publicAuthorName: null,
    bio: null,
  });
  emit(deps, "profiles:converged");

  const authorId = authorResolved.id;
  const readerId = readerResolved.id;

  // ---- Phase 4.5: converge avatar_path back to its defined safe
  // baseline (null) for BOTH accounts (PHASE-1C review round 3, item 6).
  // ----
  await deps.convergeProfileAvatarBaseline(authorId);
  await deps.convergeProfileAvatarBaseline(readerId);
  emit(deps, "avatar-baseline:converged");

  // ---- Series ----
  await deps.upsertSeries(FIXTURE_SERIES_ID, authorId);
  emit(deps, "series:upserted");

  // ---- Storage + books: real bytes, uploaded before the row
  // referencing them exists (matching createBook()'s own order).
  // PHASE-1C mandatory correction, item 8: verify the EXACT expected
  // byte length, not just existence. ----
  for (const book of FIXTURE_BOOKS) {
    const coverPath = fixtureCoverPath(authorId, book.id);
    const manuscriptPath = fixtureManuscriptPath(authorId, book.id);

    const coverBytes = buildFixtureCoverBytes();
    await deps.uploadObject("covers", coverPath, coverBytes, "image/png");
    const coverVerify = await deps.verifyObjectSize("covers", coverPath);
    if (coverVerify.sizeBytes === null || coverVerify.sizeBytes !== coverBytes.length) {
      throw new Error(
        `seed: cover upload for ${book.id} size mismatch -- expected ${coverBytes.length} bytes, got ` +
          `${coverVerify.sizeBytes === null ? "null (not found)" : coverVerify.sizeBytes}. Aborting ` +
          "before upserting this book's row.",
      );
    }

    const manuscriptBytes = await buildFixtureEpubBytes(book.title);
    await deps.uploadObject("manuscripts", manuscriptPath, manuscriptBytes, "application/epub+zip");
    const manuscriptVerify = await deps.verifyObjectSize("manuscripts", manuscriptPath);
    if (manuscriptVerify.sizeBytes === null || manuscriptVerify.sizeBytes !== manuscriptBytes.length) {
      throw new Error(
        `seed: manuscript upload for ${book.id} size mismatch -- expected ${manuscriptBytes.length} ` +
          `bytes, got ${manuscriptVerify.sizeBytes === null ? "null (not found)" : manuscriptVerify.sizeBytes}. ` +
          "Aborting before upserting this book's row.",
      );
    }

    await deps.upsertBook(book, authorId, coverPath, manuscriptPath);
    emit(deps, `book:${book.id}:upserted`);
  }

  await deps.upsertContributor(FIXTURE_CONTRIBUTOR_ID, FIXTURE_PURCHASE_TARGET_BOOK_ID);

  await deps.upsertBundle(FIXTURE_BUNDLE_ID, authorId);
  await deps.upsertBundleBooks(FIXTURE_BUNDLE_ID, FIXTURE_BUNDLE_MEMBERSHIPS);
  emit(deps, "bundle:upserted");

  await deps.upsertDiscountCode(FIXTURE_DISCOUNT_CODE_ID, authorId, FIXTURE_DISCOUNT_TARGET_BOOK_ID);
  emit(deps, "discount-code:upserted");

  await deps.upsertPurchase(FIXTURE_PURCHASE_ID, readerId, FIXTURE_PURCHASE_TARGET_BOOK_ID, FIXTURE_PURCHASE_AMOUNT_CENTS);
  emit(deps, "purchase:upserted");

  // ---- Phase 5: postcondition verification (item 11) -- reread and
  // compare, never inferred from mutation calls returning no error. ----
  emit(deps, "postcondition:start");
  const authorCheck = await deps.getUserById(authorId);
  if (authorCheck === null || authorCheck.id !== authorId) {
    throw new SeedPostconditionFailedError(`Postcondition failed: fixture author ${authorId} not found after seeding.`);
  }
  const readerCheck = await deps.getUserById(readerId);
  if (readerCheck === null || readerCheck.id !== readerId) {
    throw new SeedPostconditionFailedError(`Postcondition failed: fixture reader ${readerId} not found after seeding.`);
  }
  for (const book of FIXTURE_BOOKS) {
    const bookCheck = await deps.getBookById(book.id);
    if (bookCheck === null) {
      throw new SeedPostconditionFailedError(`Postcondition failed: fixture book ${book.id} not found after seeding.`);
    }
    if (bookCheck.status !== book.status) {
      throw new SeedPostconditionFailedError(
        `Postcondition failed: fixture book ${book.id} has status "${bookCheck.status}", expected "${book.status}".`,
      );
    }
  }
  emit(deps, "postcondition:complete");

  emit(deps, "seed:complete");
  return { authorId, readerId };
}

// ============================================================
// CLI entry point. Wires SeedDeps to a REAL @supabase/supabase-js admin
// client via live-deps.mts (implemented, but never executed in this
// session -- no `npm run staging:fixtures:*` command was run).
// ============================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  const { buildLiveSeedDeps } = await import("./live-deps.mts");
  const deps = buildLiveSeedDeps();
  await runSeed(deps);
}
