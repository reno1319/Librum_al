import { describe, expect, it } from "vitest";
import { resolvePublicAuthorName } from "./author-name";

describe("resolvePublicAuthorName", () => {
  it("public_author_name equal to display_name: returns that name", () => {
    expect(
      resolvePublicAuthorName({ display_name: "Renato Kalemi", public_author_name: "Renato Kalemi" }),
    ).toBe("Renato Kalemi");
  });

  it("public_author_name is a pseudonym: returns the pseudonym, never display_name", () => {
    expect(
      resolvePublicAuthorName({ display_name: "Renato Kalemi", public_author_name: "Arben Leka" }),
    ).toBe("Arben Leka");
  });

  it("public_author_name is null: falls back to display_name", () => {
    expect(
      resolvePublicAuthorName({ display_name: "Renato Kalemi", public_author_name: null }),
    ).toBe("Renato Kalemi");
  });

  it("profile is null: returns null", () => {
    expect(resolvePublicAuthorName(null)).toBeNull();
  });

  it("profile is undefined: returns null", () => {
    expect(resolvePublicAuthorName(undefined)).toBeNull();
  });

  it("preserves Unicode / Albanian diacritics (ë, ç) exactly", () => {
    expect(
      resolvePublicAuthorName({ display_name: "Renato Kalemi", public_author_name: "Ëngjëll Çela" }),
    ).toBe("Ëngjëll Çela");
    expect(
      resolvePublicAuthorName({ display_name: "Ëngjëll Çela", public_author_name: null }),
    ).toBe("Ëngjëll Çela");
  });

  it("preserves punctuation and initials exactly", () => {
    expect(
      resolvePublicAuthorName({ display_name: "Renato Kalemi", public_author_name: "R. Kalemi" }),
    ).toBe("R. Kalemi");
    expect(
      resolvePublicAuthorName({ display_name: "Renato Kalemi", public_author_name: "R.K." }),
    ).toBe("R.K.");
  });

  // LIBRUM 2.0 AUTHOR-1C: public reader-facing queries now read through
  // the public_author_profiles database view (migration 045), which has
  // no display_name column at all -- an object shaped exactly like what
  // that view returns (public_author_name present, display_name simply
  // absent, not merely null) must resolve correctly, with no way to
  // "recover" a private name that was never in the object to begin with.
  it("view-shaped object (no display_name key at all): resolves via public_author_name alone", () => {
    expect(resolvePublicAuthorName({ public_author_name: "Arben Leka" })).toBe("Arben Leka");
  });

  it("view-shaped object with a null public_author_name and no display_name key: returns null, never throws", () => {
    expect(resolvePublicAuthorName({ public_author_name: null })).toBeNull();
  });
});
