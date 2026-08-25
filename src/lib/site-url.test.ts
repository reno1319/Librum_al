import { describe, expect, it, afterEach, vi } from "vitest";
import { resolveSiteOrigin } from "./site-url";

// LAUNCH-1 P1-10: vi.stubEnv (not direct `process.env.NODE_ENV = ...`)
// for NODE_ENV specifically -- @types/node declares ProcessEnv.NODE_ENV
// as readonly, so a plain assignment fails `tsc --noEmit`. vi.stubEnv
// sets the underlying env value without going through that typed
// property assignment, and vi.unstubAllEnvs() in afterEach restores
// every stubbed var (NODE_ENV and NEXT_PUBLIC_SITE_URL both) to its
// pre-test value, so a thrown assertion mid-test can never leak env
// state into a later test.
describe("resolveSiteOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("1. configured https URL returns normalized origin", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app");
    expect(resolveSiteOrigin()).toBe("https://librumal.vercel.app");
  });

  it("2. configured http URL is accepted outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://example.com");
    expect(resolveSiteOrigin()).toBe("http://example.com");
  });

  it("3. trailing slash is removed", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app/");
    expect(resolveSiteOrigin()).toBe("https://librumal.vercel.app");
  });

  it("4. missing value outside production -> http://localhost:3000", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    expect(resolveSiteOrigin()).toBe("http://localhost:3000");
  });

  it("5. missing value in production -> throws", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    expect(() => resolveSiteOrigin()).toThrow(/NEXT_PUBLIC_SITE_URL is not configured/);
  });

  it("6. malformed configured URL -> throws (in every environment)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    expect(() => resolveSiteOrigin()).toThrow(/malformed URL/);

    vi.stubEnv("NODE_ENV", "production");
    expect(() => resolveSiteOrigin()).toThrow(/malformed URL/);
  });

  it("7. non-http(s) protocol -> throws", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "ftp://example.com");
    expect(() => resolveSiteOrigin()).toThrow(/must use http or https/);
  });

  // https:// (not http://) so this isolates the localhost-rejection
  // rule specifically -- an http:// localhost value in production would
  // now ALSO trip the separate https-in-production check added below
  // (see test 12), and this test's job is to prove the localhost check
  // on its own, not which of two independently-sufficient reasons fires
  // first.
  it("8. production localhost -> throws", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://localhost:3000");
    expect(() => resolveSiteOrigin()).toThrow(/localhost address/);
  });

  it("9. production 127.0.0.1 -> throws", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://127.0.0.1:3000");
    expect(() => resolveSiteOrigin()).toThrow(/localhost address/);
  });

  it("10. production ::1 -> throws", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://[::1]:3000");
    expect(() => resolveSiteOrigin()).toThrow(/localhost address/);
  });

  it("11. production valid https origin succeeds", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app");
    expect(resolveSiteOrigin()).toBe("https://librumal.vercel.app");
  });

  // Not in the required list, but directly proves the fail-closed
  // invariant this whole change exists for: a localhost value is fine
  // OUTSIDE production (the dev-default case) -- only production treats
  // it as a configuration error.
  it("the same localhost URL is accepted outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    expect(resolveSiteOrigin()).toBe("http://localhost:3000");
  });

  // ------------------------------------------------------------------
  // LAUNCH-1 P1-10 final correction: https-only in production, and
  // origin-only (no path/query/hash/credentials) in every environment.
  // ------------------------------------------------------------------

  it("12. production http public origin throws (https required in production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://librumal.vercel.app");
    expect(() => resolveSiteOrigin()).toThrow(/must use https in production/);
  });

  it("http public origin is still accepted outside production even after the https-in-production tightening", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://librumal.vercel.app");
    expect(resolveSiteOrigin()).toBe("http://librumal.vercel.app");
  });

  it("13. non-root pathname throws", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app/foo");
    expect(() => resolveSiteOrigin()).toThrow(/must not include a path/);
  });

  it("14. query parameters throw", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app/?x=1");
    expect(() => resolveSiteOrigin()).toThrow(/must not include query parameters/);
  });

  it("15. a fragment/hash throws", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app/#x");
    expect(() => resolveSiteOrigin()).toThrow(/must not include a fragment/);
  });

  it("16. username/password credentials throw", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://user:pass@librumal.vercel.app");
    expect(() => resolveSiteOrigin()).toThrow(/must not include username\/password credentials/);
  });

  it("17. a single trailing slash remains accepted and normalized (including in production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app/");
    expect(resolveSiteOrigin()).toBe("https://librumal.vercel.app");
  });

  // The path/query/hash/credentials rules apply in every environment,
  // not just production -- a present-but-invalid shape is a
  // configuration bug regardless of NODE_ENV, matching the existing
  // "malformed URL" and "non-http(s) protocol" checks above.
  it("non-root pathname, query, hash, and credentials all throw outside production too", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app/foo");
    expect(() => resolveSiteOrigin()).toThrow(/must not include a path/);

    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app/?x=1");
    expect(() => resolveSiteOrigin()).toThrow(/must not include query parameters/);

    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librumal.vercel.app/#x");
    expect(() => resolveSiteOrigin()).toThrow(/must not include a fragment/);

    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://user:pass@librumal.vercel.app");
    expect(() => resolveSiteOrigin()).toThrow(/must not include username\/password credentials/);
  });

  // A thrown credentials error must never echo the password (or the
  // whole configured value, which would contain it) back into an error
  // message that could land in logs.
  it("the credentials error message never leaks the password", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://user:supersecret@librumal.vercel.app");
    expect(() => resolveSiteOrigin()).toThrow();
    try {
      resolveSiteOrigin();
    } catch (error) {
      expect(String(error)).not.toContain("supersecret");
    }
  });
});
