import { describe, expect, it } from "vitest";
import { AVATARS_BUCKET, canonicalAvatarPath, isOwnCanonicalAvatarPath } from "./avatar-path";
import {
  AVATAR_FIXTURE_OTHER_ID as OTHER,
  AVATAR_FIXTURE_USER_ID as USER,
  UNSAFE_AVATAR_PATHS_FOR_USER,
} from "./avatar-path-test-fixtures";

// AVATAR-STORAGE-PATH-AUTH-1: the canonical-avatar-key rule shared by
// updateProfile (writer) and deleteAccount (privileged remover).

describe("canonicalAvatarPath", () => {
  it("builds <user id>/avatar.<jpg|png>", () => {
    expect(canonicalAvatarPath(USER, "png")).toBe(`${USER}/avatar.png`);
    expect(canonicalAvatarPath(USER, "jpg")).toBe(`${USER}/avatar.jpg`);
  });

  it.each(["", "user-1", USER.toUpperCase(), `${USER}/x`, `../${USER}`, `${USER} `])(
    "refuses a malformed user id %j",
    (id) => {
      expect(() => canonicalAvatarPath(id, "png")).toThrow();
    },
  );

  it("refuses an unsupported extension", () => {
    expect(() => canonicalAvatarPath(USER, "gif" as never)).toThrow();
    expect(() => canonicalAvatarPath(USER, "jpeg" as never)).toThrow();
  });

  it("the bucket is avatars", () => {
    expect(AVATARS_BUCKET).toBe("avatars");
  });
});

describe("isOwnCanonicalAvatarPath", () => {
  it("accepts exactly the user's own two canonical keys", () => {
    expect(isOwnCanonicalAvatarPath(`${USER}/avatar.png`, USER)).toBe(true);
    expect(isOwnCanonicalAvatarPath(`${USER}/avatar.jpg`, USER)).toBe(true);
  });

  it.each(UNSAFE_AVATAR_PATHS_FOR_USER)("rejects %s", (_label, value) => {
    expect(isOwnCanonicalAvatarPath(value, USER)).toBe(false);
  });

  it("is keyed to the deleting user: another user's own key is canonical only for them", () => {
    expect(isOwnCanonicalAvatarPath(`${OTHER}/avatar.png`, OTHER)).toBe(true);
    expect(isOwnCanonicalAvatarPath(`${OTHER}/avatar.png`, USER)).toBe(false);
  });

  it.each(["", "user-1", USER.toUpperCase(), `${USER}/avatar`])("never accepts anything for a malformed user id %j", (id) => {
    expect(isOwnCanonicalAvatarPath(`${id}/avatar.png`, id)).toBe(false);
  });
});
