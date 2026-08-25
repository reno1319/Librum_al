import { describe, expect, it, vi, afterEach } from "vitest";
import {
  RECOVERY_COOKIE_NAME,
  RECOVERY_COOKIE_TTL_SECONDS,
  isRecoverySessionActive,
  shouldRedirectForRecovery,
  setRecoverySession,
  clearRecoverySession,
} from "./recovery-session";

function fakeReader(entries: Record<string, string>) {
  return {
    get: (name: string) => (name in entries ? { value: entries[name] } : undefined),
  };
}

describe("isRecoverySessionActive", () => {
  it("returns true when the recovery cookie is present with the expected value", () => {
    expect(isRecoverySessionActive(fakeReader({ [RECOVERY_COOKIE_NAME]: "1" }))).toBe(true);
  });

  it("returns false when the cookie is absent", () => {
    expect(isRecoverySessionActive(fakeReader({}))).toBe(false);
  });

  it("returns false when the cookie is present with an unexpected value -- never trusts an arbitrary value", () => {
    expect(isRecoverySessionActive(fakeReader({ [RECOVERY_COOKIE_NAME]: "true" }))).toBe(false);
  });

  it("is unaffected by unrelated cookies", () => {
    expect(
      isRecoverySessionActive(fakeReader({ "sb-access-token": "whatever", other: "1" })),
    ).toBe(false);
  });
});

describe("shouldRedirectForRecovery", () => {
  it("recovery inactive -> never redirects, regardless of path", () => {
    expect(shouldRedirectForRecovery("/library", false)).toBe(false);
    expect(shouldRedirectForRecovery("/dashboard/payouts", false)).toBe(false);
    expect(shouldRedirectForRecovery("/admin/refunds", false)).toBe(false);
  });

  it("recovery active + /library -> redirects", () => {
    expect(shouldRedirectForRecovery("/library", true)).toBe(true);
  });

  it("recovery active + /dashboard/* -> redirects", () => {
    expect(shouldRedirectForRecovery("/dashboard", true)).toBe(true);
    expect(shouldRedirectForRecovery("/dashboard/payouts", true)).toBe(true);
    expect(shouldRedirectForRecovery("/dashboard/sales", true)).toBe(true);
  });

  it("recovery active + /admin/* -> redirects", () => {
    expect(shouldRedirectForRecovery("/admin", true)).toBe(true);
    expect(shouldRedirectForRecovery("/admin/refunds", true)).toBe(true);
  });

  it("recovery active + /reset-password -> allowed, no redirect", () => {
    expect(shouldRedirectForRecovery("/reset-password", true)).toBe(false);
  });

  it("recovery active + /auth/callback -> allowed, no redirect", () => {
    expect(shouldRedirectForRecovery("/auth/callback", true)).toBe(false);
  });

  it("recovery active + /login -> allowed, no redirect", () => {
    expect(shouldRedirectForRecovery("/login", true)).toBe(false);
  });

  it("recovery active + an unrelated path prefixed with an allowed one -> still redirects (exact match only)", () => {
    expect(shouldRedirectForRecovery("/reset-password-lookalike", true)).toBe(true);
  });

  it("recovery active + root path -> redirects", () => {
    expect(shouldRedirectForRecovery("/", true)).toBe(true);
  });
});

describe("setRecoverySession / clearRecoverySession", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    vi.unstubAllEnvs();
    void originalNodeEnv;
  });

  it("sets the cookie with the exact name, a presence-only value, and HttpOnly/SameSite=Lax/Path=/", () => {
    vi.stubEnv("NODE_ENV", "test");
    const set = vi.fn();
    setRecoverySession({ set, delete: vi.fn() });

    expect(set).toHaveBeenCalledOnce();
    const [name, value, options] = set.mock.calls[0];
    expect(name).toBe(RECOVERY_COOKIE_NAME);
    expect(value).toBe("1");
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: RECOVERY_COOKIE_TTL_SECONDS,
    });
  });

  it("marks the cookie Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const set = vi.fn();
    setRecoverySession({ set, delete: vi.fn() });
    expect(set.mock.calls[0][2]).toMatchObject({ secure: true });
  });

  it("does not mark the cookie Secure outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    const set = vi.fn();
    setRecoverySession({ set, delete: vi.fn() });
    expect(set.mock.calls[0][2]).toMatchObject({ secure: false });
  });

  it("clearRecoverySession deletes exactly the recovery cookie by name", () => {
    const del = vi.fn();
    clearRecoverySession({ set: vi.fn(), delete: del });
    expect(del).toHaveBeenCalledExactlyOnceWith(RECOVERY_COOKIE_NAME);
  });
});

// LAUNCH-1 P1-11 CORRECTION: regression coverage for the confirmed
// timed-bypass defect -- the ORIGINAL 15-minute TTL let the recovery
// marker expire while the underlying Supabase session (governed by a
// wholly separate, much longer-lived cookie) remained fully
// authenticated, silently promoting a recovery-derived session to
// ordinary access. See RECOVERY_COOKIE_TTL_SECONDS's own comment for
// the full node_modules-sourced trace this fix is based on.
describe("recovery marker lifetime safety (LAUNCH-1 P1-11 correction)", () => {
  // The exact value node_modules/@supabase/ssr/dist/module/utils/
  // constants.js's DEFAULT_COOKIE_OPTIONS.maxAge uses for the real
  // session cookie in this app's actual, unmodified createServerClient()
  // setup (src/lib/supabase/server.ts, src/lib/supabase/middleware.ts --
  // neither overrides cookieOptions). Not re-imported from the
  // installed package (its constants module has no public export path
  // this app is meant to depend on) -- restated here, literally, as the
  // authoritative figure this test pins the recovery marker against.
  const SUPABASE_SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

  it("recovery session survives longer than the original 15-minute marker -- the marker's own TTL must not be shorter than the real session cookie's", () => {
    // This is the literal regression test for the confirmed defect:
    // under the OLD value (15 * 60 = 900), this assertion fails,
    // exactly reproducing the timed-bypass window the finding
    // described. Under the corrected value, it passes because the two
    // lifetimes are pinned to the same underlying constant.
    expect(RECOVERY_COOKIE_TTL_SECONDS).toBeGreaterThanOrEqual(
      SUPABASE_SESSION_COOKIE_MAX_AGE_SECONDS,
    );
    // Sanity check the old defect would actually have been caught here.
    expect(15 * 60).toBeLessThan(SUPABASE_SESSION_COOKIE_MAX_AGE_SECONDS);
  });

  it("the marker's cookie options set a persistent, non-zero maxAge -- never a browser-session-only cookie", () => {
    // Necessary, not merely sufficient: if the Supabase session cookie
    // survives a browser restart (it does -- it's a persistent cookie,
    // not session-scoped, per the same DEFAULT_COOKIE_OPTIONS), a
    // session-only recovery cookie (no maxAge) would vanish on restart
    // while the session itself remained valid -- reproducing the exact
    // bypass with "browser restart" as the trigger instead of "15
    // minutes." maxAge must be an explicit, positive number.
    const set = vi.fn();
    setRecoverySession({ set, delete: vi.fn() });
    const options = set.mock.calls[0][2] as { maxAge?: number };
    expect(typeof options.maxAge).toBe("number");
    expect(options.maxAge).toBeGreaterThan(0);
  });
});
