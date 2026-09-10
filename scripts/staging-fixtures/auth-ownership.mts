// PHASE-1C: fixture Auth-user ownership, discovery, repair, and
// convergence logic.
//
// Every function here takes its Supabase interactions as EXPLICIT,
// INJECTED async callables rather than a live client -- this is what
// makes every branch (marker acceptance/rejection, pagination,
// orphan repair, convergence, missing-profile handling) directly
// unit-testable with plain fakes, with zero network access and zero
// real credentials. The real CLI entry points (seed.mts/reset.mts) wire
// these callables to the actual @supabase/supabase-js admin client via
// live-deps.mts.
import { FIXTURE_OWNERSHIP_MARKER, type FixtureOwnershipMarker } from "./manifest.mts";

// ============================================================
// Types matching the shape of what @supabase/auth-js's Admin API
// actually returns (traced directly from the installed
// GoTrueAdminApi.d.ts / lib/types.d.ts) -- not guessed. Kept minimal/
// local rather than importing the SDK's own types, so this module has
// no import-time dependency on @supabase/supabase-js at all.
// ============================================================

export type FixtureAuthUser = {
  id: string;
  email: string | null | undefined;
  app_metadata: Record<string, unknown> | null | undefined;
  last_sign_in_at: string | null | undefined;
};

export type ListUsersPage = { users: FixtureAuthUser[] };
export type ListUsersFn = (params: { page: number; perPage: number }) => Promise<ListUsersPage>;

export type CreateUserFn = (attrs: {
  email: string;
  password: string;
  email_confirm: true;
  user_metadata: { role: "author" | "reader"; display_name: string };
  app_metadata: Record<string, unknown>;
}) => Promise<{ id: string }>;

export type UpdateUserByIdFn = (
  id: string,
  attrs: {
    password?: string;
    email_confirm?: boolean;
    ban_duration?: string;
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
  },
) => Promise<void>;

// PHASE-1C mandatory correction, item 2: needed for exact-ID orphan
// recovery (delete a specific broken Auth user this module itself
// verified has no profile, never a blanket cleanup).
export type DeleteUserByIdFn = (id: string) => Promise<void>;

export type GetProfileByIdFn = (
  id: string,
) => Promise<{ role: string; display_name: string; public_author_name: string | null; bio: string | null } | null>;

export type UpsertProfileFn = (
  id: string,
  fields: { role: string; display_name: string; public_author_name: string | null; bio: string | null },
) => Promise<{ affectedRows: number }>;

// ============================================================
// Ownership marker validation
// ============================================================

export type MarkerCheckResult =
  | { kind: "accepted" }
  | { kind: "missing" }
  | { kind: "conflicting"; found: unknown };

export function checkOwnershipMarker(
  appMetadata: Record<string, unknown> | null | undefined,
): MarkerCheckResult {
  const found = appMetadata?.["librum_fixture"];
  if (found === undefined || found === null) {
    return { kind: "missing" };
  }
  const candidate = found as Partial<FixtureOwnershipMarker>;
  if (
    candidate.namespace === FIXTURE_OWNERSHIP_MARKER.namespace &&
    candidate.schema_version === FIXTURE_OWNERSHIP_MARKER.schema_version
  ) {
    return { kind: "accepted" };
  }
  return { kind: "conflicting", found };
}

export class FixtureOwnershipMarkerError extends Error {}
export class FixtureProfileMissingError extends Error {
  readonly authUserId: string;
  constructor(authUserId: string, message: string) {
    super(message);
    this.authUserId = authUserId;
  }
}
export class FixtureProfileIntegrityError extends Error {}

// ============================================================
// Paginated exact-email lookup
// ============================================================
//
// listUsers() has no server-side email filter (confirmed from the
// installed GoTrueAdminApi.d.ts) -- every page must be fetched and
// matched client-side, EXACTLY (never a substring/includes() match, to
// avoid ever matching an unrelated real staging user whose email
// happens to contain the fixture string).
export async function findUserByExactEmail(
  listUsers: ListUsersFn,
  email: string,
  perPage = 50,
): Promise<FixtureAuthUser | null> {
  const normalizedTarget = email.trim().toLowerCase();
  let page = 1;
  // Bounded to prevent an infinite loop against a misbehaving fake/API
  // that never returns a short page -- 500 pages * 50/page = 25,000
  // users is far beyond any plausible staging project size.
  const MAX_PAGES = 500;
  for (; page <= MAX_PAGES; page++) {
    const result = await listUsers({ page, perPage });
    const match = result.users.find(
      (u) => (u.email ?? "").trim().toLowerCase() === normalizedTarget,
    );
    if (match) return match;
    if (result.users.length < perPage) return null;
  }
  throw new Error(
    `findUserByExactEmail: exceeded ${MAX_PAGES} pages without exhausting listUsers() -- refusing to loop further.`,
  );
}

// ============================================================
// PHASE-1C mandatory correction, item 2: discovery is now fully
// separated from mutation. discoverFixtureUser() NEVER creates,
// updates, or deletes anything -- it is safe to call from reset.mts's
// genuinely-read-only preflight as well as from seed.mts.
// ============================================================

export type DiscoveredFixtureUser =
  | { kind: "not_found" }
  | { kind: "valid"; user: FixtureAuthUser }
  // marker OK, but no profiles row -- a known orphan shape, safe to
  // repair by exact-ID delete+recreate (see repairOrphanIfNeeded below,
  // seed.mts only -- reset/teardown must never repair anything).
  | { kind: "orphan"; user: FixtureAuthUser }
  | { kind: "marker_missing"; user: FixtureAuthUser }
  | { kind: "marker_conflict"; user: FixtureAuthUser };

export async function discoverFixtureUser(deps: {
  listUsers: ListUsersFn;
  getProfileById: GetProfileByIdFn;
  email: string;
}): Promise<DiscoveredFixtureUser> {
  const existing = await findUserByExactEmail(deps.listUsers, deps.email);
  if (existing === null) return { kind: "not_found" };

  const markerCheck = checkOwnershipMarker(existing.app_metadata);
  if (markerCheck.kind === "missing") return { kind: "marker_missing", user: existing };
  if (markerCheck.kind === "conflicting") return { kind: "marker_conflict", user: existing };

  const profile = await deps.getProfileById(existing.id);
  if (profile === null) return { kind: "orphan", user: existing };
  return { kind: "valid", user: existing };
}

// Hard-stops on anything that isn't a clean, existing, marker-valid,
// profile-having account -- used by reset.mts, which must NEVER create,
// delete, or repair anything during preflight. An "orphan" here is
// explicitly NOT self-healed: reset/teardown has no mutation budget for
// repair, only for the deletion its own mode authorizes.
export function requireValidForReadOnly(discovered: DiscoveredFixtureUser, email: string): FixtureAuthUser {
  if (discovered.kind === "valid") return discovered.user;
  if (discovered.kind === "not_found") {
    throw new FixtureOwnershipMarkerError(
      `No existing fixture account found at ${email} -- nothing to reset/tear down. Run \`seed\` first.`,
    );
  }
  if (discovered.kind === "marker_missing") {
    throw new FixtureOwnershipMarkerError(
      `An account already exists at ${email} with no fixture ownership marker. This may be a ` +
        "real user or a pre-marker fixture account -- refusing to touch it. No mutation was attempted.",
    );
  }
  if (discovered.kind === "marker_conflict") {
    throw new FixtureOwnershipMarkerError(
      `An account already exists at ${email} with a CONFLICTING fixture ownership marker ` +
        "(a different/incompatible fixture generation). Refusing to touch it. No mutation was attempted.",
    );
  }
  // discovered.kind === "orphan"
  throw new FixtureProfileIntegrityError(
    `Fixture account at ${email} is marker-verified but has no matching profiles row (a known ` +
      "orphan shape from a previously interrupted seed run). reset/teardown cannot repair this -- " +
      "run \`seed\` first, which will safely delete and recreate this exact orphaned account by ID.",
  );
}

// ============================================================
// Seed-only: exact-ID orphan repair (item 2). Only ever called for a
// discovery result already confirmed marker-valid ("orphan" specifically
// -- never "marker_missing"/"marker_conflict", which are never touched).
// Deleting is safe here because (a) the marker proves WE created this
// account, and (b) no profile exists, so nothing else in the database
// references it -- there is nothing to lose.
// ============================================================
export async function repairOrphanIfNeeded(
  deps: { deleteUserById: DeleteUserByIdFn },
  discovered: DiscoveredFixtureUser,
): Promise<DiscoveredFixtureUser> {
  if (discovered.kind !== "orphan") return discovered;
  await deps.deleteUserById(discovered.user.id);
  return { kind: "not_found" };
}

// ============================================================
// Seed-only: create a fixture user, verify its trigger-created profile
// immediately, and self-heal with ONE bounded delete+recreate retry if
// the trigger did not fire -- so a transient failure doesn't
// permanently block every future run on its own (a later run's
// discovery would also find this exact case as "orphan" and repair it
// again via repairOrphanIfNeeded, so "permanently blocked" is
// structurally impossible either way -- this in-run retry just avoids
// needing a second invocation for the common transient case).
// ============================================================
export type CreatedFixtureUser = { id: string };

export async function createFixtureUserWithProfileVerification(deps: {
  createUser: CreateUserFn;
  deleteUserById: DeleteUserByIdFn;
  getProfileById: GetProfileByIdFn;
  email: string;
  password: string;
  role: "author" | "reader";
  displayName: string;
}): Promise<CreatedFixtureUser> {
  const attempt = async (): Promise<{ id: string; profileExists: boolean }> => {
    const created = await deps.createUser({
      email: deps.email,
      password: deps.password,
      email_confirm: true,
      user_metadata: { role: deps.role, display_name: deps.displayName },
      app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER },
    });
    const profile = await deps.getProfileById(created.id);
    return { id: created.id, profileExists: profile !== null };
  };

  const first = await attempt();
  if (first.profileExists) return { id: first.id };

  // Bounded self-heal: exact-ID delete of the just-created orphan, then
  // exactly one more attempt.
  await deps.deleteUserById(first.id);
  const second = await attempt();
  if (second.profileExists) return { id: second.id };

  throw new FixtureProfileMissingError(
    second.id,
    `Auth user ${second.id} was created, but no matching profiles row exists -- the ` +
      "handle_new_user() trigger did not fire or failed, even after one automatic exact-ID " +
      "delete-and-retry. PARTIAL STATE: an orphaned Auth user now exists with no profile. " +
      "This run is aborting. A future \`seed\` run's discovery phase will find this exact " +
      "account as a known orphan and repair it automatically -- this is not a permanent block " +
      "-- but if it recurs, investigate the trigger directly rather than retrying indefinitely.",
  );
}

// ============================================================
// Convergence: password / confirmation / ban state / user_metadata /
// app_metadata, run unconditionally on every seed -- whether the user
// was just created or reused -- so a reused user self-heals to the
// exact expected state.
// ============================================================

// PHASE-1C: "Verify the installed SDK behavior for unbanning; do not
// assume ban_duration: 'none' without a source/type or local
// unit-tested abstraction." Confirmed directly from the installed
// @supabase/auth-js AdminUserAttributes JSDoc
// (node_modules/@supabase/auth-js/dist/module/lib/types.d.ts:483-492):
// "Setting the ban duration to 'none' lifts the ban on the user." This
// tiny wrapper exists so that source citation has exactly one place to
// live and be tested, rather than a bare string literal scattered
// through the convergence call site.
export function unbannedDuration(): "none" {
  return "none";
}

// PHASE-1C mandatory correction, item 3: callers MUST pass the reused
// user's ACTUAL existing app_metadata (from discovery) -- never `{}`.
// This function merges it with the fixture marker client-side (never
// trusting unconfirmed server-side merge semantics for app_metadata
// updates) so any unrelated key a human or another process set on this
// account survives.
export async function convergeAuthUser(deps: {
  updateUserById: UpdateUserByIdFn;
  id: string;
  password: string;
  role: "author" | "reader";
  displayName: string;
  existingAppMetadata: Record<string, unknown> | null | undefined;
}): Promise<void> {
  const mergedAppMetadata = {
    ...(deps.existingAppMetadata ?? {}),
    librum_fixture: FIXTURE_OWNERSHIP_MARKER,
  };

  await deps.updateUserById(deps.id, {
    password: deps.password,
    email_confirm: true,
    ban_duration: unbannedDuration(),
    user_metadata: { role: deps.role, display_name: deps.displayName },
    app_metadata: mergedAppMetadata,
  });
}

// ============================================================
// Profile integrity
// ============================================================
//
// handle_new_user() (supabase/schema.sql) fires ONLY on INSERT INTO
// auth.users -- it never re-runs on an existing user, so a reused
// user's profiles row can independently drift with nothing to fix it.
// It is also the ONLY sanctioned way a profiles row is created; this
// module never inserts one directly.

export type ProfileConvergenceResult =
  | { kind: "converged"; affectedRows: number }
  | { kind: "created_and_converged"; affectedRows: number };

// For a REUSED, marker-verified, profile-having user (discovery already
// confirmed the profile exists -- this is the convergence step, not the
// existence check, which now lives in discoverFixtureUser above). An
// update affecting zero rows means the row vanished between discovery
// and here (a real, if unlikely, race) -- checked explicitly.
export async function convergeExistingUserProfile(deps: {
  upsertProfile: UpsertProfileFn;
  id: string;
  role: "author" | "reader";
  displayName: string;
  publicAuthorName: string | null;
  bio: string | null;
}): Promise<ProfileConvergenceResult> {
  const result = await deps.upsertProfile(deps.id, {
    role: deps.role,
    display_name: deps.displayName,
    public_author_name: deps.publicAuthorName,
    bio: deps.bio,
  });
  if (result.affectedRows !== 1) {
    throw new FixtureProfileIntegrityError(
      `Profile convergence UPDATE for ${deps.id} affected ${result.affectedRows} rows, expected exactly 1. ` +
        "Refusing to proceed -- the profile row may have been deleted concurrently.",
    );
  }
  return { kind: "converged", affectedRows: result.affectedRows };
}

// For a newly created (and profile-verified, by
// createFixtureUserWithProfileVerification above) Auth user: converges
// the already-confirmed-to-exist profile's fields.
export async function convergeNewUserProfile(deps: {
  upsertProfile: UpsertProfileFn;
  id: string;
  role: "author" | "reader";
  displayName: string;
  publicAuthorName: string | null;
  bio: string | null;
}): Promise<ProfileConvergenceResult> {
  const result = await deps.upsertProfile(deps.id, {
    role: deps.role,
    display_name: deps.displayName,
    public_author_name: deps.publicAuthorName,
    bio: deps.bio,
  });
  if (result.affectedRows !== 1) {
    throw new FixtureProfileIntegrityError(
      `Profile convergence UPDATE for newly-created user ${deps.id} affected ` +
        `${result.affectedRows} rows, expected exactly 1.`,
    );
  }
  return { kind: "created_and_converged", affectedRows: result.affectedRows };
}
