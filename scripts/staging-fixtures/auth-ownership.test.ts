import { describe, expect, it, vi } from "vitest";
import {
  checkOwnershipMarker,
  findUserByExactEmail,
  discoverFixtureUser,
  requireValidForReadOnly,
  repairOrphanIfNeeded,
  createFixtureUserWithProfileVerification,
  convergeAuthUser,
  convergeExistingUserProfile,
  convergeNewUserProfile,
  unbannedDuration,
  FixtureOwnershipMarkerError,
  FixtureProfileMissingError,
  FixtureProfileIntegrityError,
  type FixtureAuthUser,
  type ListUsersFn,
  type GetProfileByIdFn,
} from "./auth-ownership.mts";
import { FIXTURE_OWNERSHIP_MARKER } from "./manifest.mts";

function fakeUser(overrides: Partial<FixtureAuthUser> = {}): FixtureAuthUser {
  return {
    id: "user-1",
    email: "librum-staging-fixture-author@example.invalid",
    app_metadata: { librum_fixture: FIXTURE_OWNERSHIP_MARKER },
    last_sign_in_at: null,
    ...overrides,
  };
}

describe("checkOwnershipMarker", () => {
  it("accepts an exact marker match", () => {
    expect(checkOwnershipMarker({ librum_fixture: { ...FIXTURE_OWNERSHIP_MARKER } })).toEqual({
      kind: "accepted",
    });
  });

  it("reports missing when no marker key is present", () => {
    expect(checkOwnershipMarker({})).toEqual({ kind: "missing" });
    expect(checkOwnershipMarker(null)).toEqual({ kind: "missing" });
    expect(checkOwnershipMarker(undefined)).toEqual({ kind: "missing" });
  });

  it("reports conflicting for a different namespace or schema_version", () => {
    expect(
      checkOwnershipMarker({ librum_fixture: { namespace: "other", schema_version: 1 } }).kind,
    ).toBe("conflicting");
    expect(
      checkOwnershipMarker({
        librum_fixture: { namespace: FIXTURE_OWNERSHIP_MARKER.namespace, schema_version: 99 },
      }).kind,
    ).toBe("conflicting");
  });
});

describe("findUserByExactEmail", () => {
  it("matches exactly, not by substring, and paginates", async () => {
    const pages: Record<number, FixtureAuthUser[]> = {
      1: Array.from({ length: 50 }, (_, i) => fakeUser({ id: `p1-${i}`, email: `nobody-${i}@x.invalid` })),
      2: [fakeUser({ id: "target", email: "librum-staging-fixture-author@example.invalid" })],
    };
    const listUsers: ListUsersFn = async ({ page }) => ({ users: pages[page] ?? [] });
    const result = await findUserByExactEmail(listUsers, "librum-staging-fixture-author@example.invalid");
    expect(result?.id).toBe("target");
  });

  it("returns null when nothing matches", async () => {
    const listUsers: ListUsersFn = async () => ({ users: [fakeUser({ id: "irrelevant" })] });
    expect(await findUserByExactEmail(listUsers, "nobody@example.invalid")).toBeNull();
  });
});

describe("discoverFixtureUser (read-only)", () => {
  it("returns not_found when no email match exists", async () => {
    const result = await discoverFixtureUser({
      listUsers: async () => ({ users: [] }),
      getProfileById: vi.fn(),
      email: "x@example.invalid",
    });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns valid when marker matches and a profile exists", async () => {
    const getProfileById: GetProfileByIdFn = vi
      .fn()
      .mockResolvedValue({ role: "author", display_name: "x", public_author_name: "x", bio: null });
    const result = await discoverFixtureUser({
      listUsers: async () => ({ users: [fakeUser()] }),
      getProfileById,
      email: fakeUser().email!,
    });
    expect(result.kind).toBe("valid");
  });

  it("returns orphan when marker matches but no profile exists -- never mutates", async () => {
    const getProfileById = vi.fn().mockResolvedValue(null);
    const result = await discoverFixtureUser({
      listUsers: async () => ({ users: [fakeUser()] }),
      getProfileById,
      email: fakeUser().email!,
    });
    expect(result.kind).toBe("orphan");
  });

  it("returns marker_missing / marker_conflict without ever calling getProfileById", async () => {
    const getProfileById = vi.fn();
    const missing = await discoverFixtureUser({
      listUsers: async () => ({ users: [fakeUser({ app_metadata: {} })] }),
      getProfileById,
      email: fakeUser().email!,
    });
    expect(missing.kind).toBe("marker_missing");

    const conflict = await discoverFixtureUser({
      listUsers: async () => ({
        users: [fakeUser({ app_metadata: { librum_fixture: { namespace: "other", schema_version: 1 } } })],
      }),
      getProfileById,
      email: fakeUser().email!,
    });
    expect(conflict.kind).toBe("marker_conflict");
    expect(getProfileById).not.toHaveBeenCalled();
  });
});

describe("requireValidForReadOnly -- reset/teardown's hard-stop gate", () => {
  it("returns the user for a valid discovery", () => {
    const user = fakeUser();
    expect(requireValidForReadOnly({ kind: "valid", user }, user.email!)).toBe(user);
  });

  it("throws for not_found, marker_missing, marker_conflict, and orphan", () => {
    const user = fakeUser();
    expect(() => requireValidForReadOnly({ kind: "not_found" }, "x")).toThrow(FixtureOwnershipMarkerError);
    expect(() => requireValidForReadOnly({ kind: "marker_missing", user }, "x")).toThrow(
      FixtureOwnershipMarkerError,
    );
    expect(() => requireValidForReadOnly({ kind: "marker_conflict", user }, "x")).toThrow(
      FixtureOwnershipMarkerError,
    );
    // PHASE-1C item 2: reset/teardown must NEVER repair an orphan --
    // only seed may. This must be a hard stop here, not a silent pass.
    expect(() => requireValidForReadOnly({ kind: "orphan", user }, "x")).toThrow(FixtureProfileIntegrityError);
  });
});

describe("repairOrphanIfNeeded -- seed only", () => {
  it("deletes the exact orphaned id and returns not_found", async () => {
    const user = fakeUser({ id: "orphan-id" });
    const deleteUserById = vi.fn().mockResolvedValue(undefined);
    const result = await repairOrphanIfNeeded({ deleteUserById }, { kind: "orphan", user });
    expect(deleteUserById).toHaveBeenCalledWith("orphan-id");
    expect(result).toEqual({ kind: "not_found" });
  });

  it("is a no-op (no delete call) for every non-orphan discovery", async () => {
    const deleteUserById = vi.fn();
    for (const discovered of [
      { kind: "not_found" as const },
      { kind: "valid" as const, user: fakeUser() },
    ]) {
      const result = await repairOrphanIfNeeded({ deleteUserById }, discovered);
      expect(result).toEqual(discovered);
    }
    expect(deleteUserById).not.toHaveBeenCalled();
  });
});

describe("createFixtureUserWithProfileVerification", () => {
  it("succeeds on the first attempt when the trigger fires normally", async () => {
    const getProfileById = vi.fn().mockResolvedValue({ role: "author", display_name: "x", public_author_name: "x", bio: null });
    const createUser = vi.fn().mockResolvedValue({ id: "new-1" });
    const deleteUserById = vi.fn();
    const result = await createFixtureUserWithProfileVerification({
      createUser,
      deleteUserById,
      getProfileById,
      email: "a@example.invalid",
      password: "pw",
      role: "author",
      displayName: "Fixture Author",
    });
    expect(result).toEqual({ id: "new-1" });
    expect(deleteUserById).not.toHaveBeenCalled();
  });

  it("self-heals with exactly one delete+retry when the trigger doesn't fire the first time", async () => {
    let call = 0;
    const createUser = vi.fn().mockImplementation(async () => {
      call++;
      return { id: `attempt-${call}` };
    });
    const getProfileById = vi.fn().mockImplementation(async (id: string) => {
      // Only the SECOND created id has a profile -- simulates the
      // trigger failing once, then working on retry.
      return id === "attempt-2" ? { role: "author", display_name: "x", public_author_name: "x", bio: null } : null;
    });
    const deleteUserById = vi.fn().mockResolvedValue(undefined);
    const result = await createFixtureUserWithProfileVerification({
      createUser,
      deleteUserById,
      getProfileById,
      email: "a@example.invalid",
      password: "pw",
      role: "author",
      displayName: "Fixture Author",
    });
    expect(result).toEqual({ id: "attempt-2" });
    expect(deleteUserById).toHaveBeenCalledWith("attempt-1");
    expect(createUser).toHaveBeenCalledTimes(2);
  });

  it("throws FixtureProfileMissingError after the trigger fails twice -- does not retry forever", async () => {
    const createUser = vi.fn().mockResolvedValue({ id: "always-orphan" });
    const getProfileById = vi.fn().mockResolvedValue(null);
    const deleteUserById = vi.fn().mockResolvedValue(undefined);
    await expect(
      createFixtureUserWithProfileVerification({
        createUser,
        deleteUserById,
        getProfileById,
        email: "a@example.invalid",
        password: "pw",
        role: "author",
        displayName: "Fixture Author",
      }),
    ).rejects.toBeInstanceOf(FixtureProfileMissingError);
    expect(createUser).toHaveBeenCalledTimes(2);
    expect(deleteUserById).toHaveBeenCalledTimes(1);
  });
});

describe("convergeAuthUser preserves unrelated app_metadata", () => {
  it("merges the caller's actual existing app_metadata with the marker", async () => {
    const updateUserById = vi.fn().mockResolvedValue(undefined);
    await convergeAuthUser({
      updateUserById,
      id: "u1",
      password: "new-pass",
      role: "reader",
      displayName: "Fixture Reader",
      existingAppMetadata: { some_unrelated_key: "keep-me", provider: "email" },
    });
    expect(updateUserById).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        app_metadata: {
          some_unrelated_key: "keep-me",
          provider: "email",
          librum_fixture: FIXTURE_OWNERSHIP_MARKER,
        },
      }),
    );
  });

  it("uses the documented unban value", () => {
    // Source: node_modules/@supabase/auth-js .../lib/types.d.ts
    // AdminUserAttributes.ban_duration JSDoc.
    expect(unbannedDuration()).toBe("none");
  });
});

describe("profile convergence affected-row verification", () => {
  it("convergeExistingUserProfile throws if the UPDATE affects zero rows", async () => {
    const upsertProfile = vi.fn().mockResolvedValue({ affectedRows: 0 });
    await expect(
      convergeExistingUserProfile({
        upsertProfile,
        id: "u1",
        role: "author",
        displayName: "x",
        publicAuthorName: "x",
        bio: null,
      }),
    ).rejects.toBeInstanceOf(FixtureProfileIntegrityError);
  });

  it("convergeNewUserProfile succeeds when exactly one row is affected", async () => {
    const upsertProfile = vi.fn().mockResolvedValue({ affectedRows: 1 });
    const result = await convergeNewUserProfile({
      upsertProfile,
      id: "u1",
      role: "reader",
      displayName: "x",
      publicAuthorName: null,
      bio: null,
    });
    expect(result.kind).toBe("created_and_converged");
  });
});
