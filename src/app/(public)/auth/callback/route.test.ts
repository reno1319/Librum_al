import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

const mockExchangeCodeForSession = vi.fn();
const mockVerifyOtp = vi.fn();
const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
      verifyOtp: mockVerifyOtp,
    },
  }),
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

const { GET, isRecoveryExchange, isRecoveryAttempt } = await import("./route");

describe("isRecoveryExchange", () => {
  it("redirectType === 'recovery' -> true", () => {
    expect(isRecoveryExchange({ redirectType: "recovery" })).toBe(true);
  });

  it("absent redirectType -> false", () => {
    expect(isRecoveryExchange({ session: {}, user: {} })).toBe(false);
  });

  it("unexpected redirectType value -> false", () => {
    expect(isRecoveryExchange({ redirectType: "signup" })).toBe(false);
    expect(isRecoveryExchange({ redirectType: null })).toBe(false);
    expect(isRecoveryExchange({ redirectType: 1 })).toBe(false);
  });

  it("malformed/unexpected exchange result fails safely as non-recovery", () => {
    expect(isRecoveryExchange(null)).toBe(false);
    expect(isRecoveryExchange(undefined)).toBe(false);
    expect(isRecoveryExchange("recovery")).toBe(false);
    expect(isRecoveryExchange(42)).toBe(false);
    expect(isRecoveryExchange([])).toBe(false);
  });
});

// AUTH-1C: isRecoveryExchange() reads `redirectType`, a field
// exchangeCodeForSession()'s PUBLIC TypeScript type does NOT declare --
// confirmed SDK-internal behavior (see route.ts's own comment, and the
// trace through node_modules/@supabase/auth-js/dist/module/
// GoTrueClient.js: resetPasswordForEmail() stores the PKCE verifier as
// "<verifier>/recovery", and _exchangeCodeForSession() splits that back
// apart into `redirectType`). The describe block above only proves
// isRecoveryExchange() itself is correct given a FABRICATED result
// shape -- it can't catch a future @supabase/auth-js upgrade that
// changes what shape the SDK actually produces, since nothing there
// touches the installed package.
//
// This reads the ACTUAL installed @supabase/auth-js source from
// node_modules at test-run time (same "assert on the real installed
// file" technique already used by
// src/app/admin/(protected)/staff/actions.test.ts's own source-contract
// tests) and asserts the two facts isRecoveryExchange()'s entire
// correctness depends on: that exchangeCodeForSession() still resolves
// its data object with a `redirectType` key, and that the SDK still
// derives it by comparing to the literal string "recovery". A future
// `npm update` that renames the field, changes the comparison, or
// restructures the method breaks THIS test loudly in CI -- not merely
// a mocked assumption that could quietly drift from reality.
describe("isRecoveryExchange: pinned against the installed @supabase/auth-js SDK's actual behavior (AUTH-1C)", () => {
  it("the installed @supabase/auth-js still derives redirectType from a 'recovery' comparison inside exchangeCodeForSession's implementation", () => {
    const require = createRequire(import.meta.url);
    const authJsPackageJsonPath = require.resolve("@supabase/auth-js/package.json");
    const authJsDir = authJsPackageJsonPath.replace(/package\.json$/, "");
    const goTrueClientSource = readFileSync(
      `${authJsDir}dist/module/GoTrueClient.js`,
      "utf8",
    );

    // The exact runtime mechanism route.ts's own comment documents:
    // _exchangeCodeForSession() splits a stored "<verifier>/recovery"
    // string apart, then compares the resulting redirectType to the
    // literal string 'recovery' when deciding what to return/notify.
    expect(goTrueClientSource).toContain("_exchangeCodeForSession");
    expect(goTrueClientSource).toMatch(/redirectType\s*===\s*['"]recovery['"]/);
    // The resolved data object exchangeCodeForSession() ultimately
    // returns still carries a `redirectType` key at all -- not just the
    // internal comparison above, but the field actually reaching
    // isRecoveryExchange()'s caller.
    expect(goTrueClientSource).toMatch(/redirectType\s*:/);
  });
});

describe("isRecoveryAttempt (AUTH-1E)", () => {
  it("type === 'recovery' -> true, regardless of next", () => {
    expect(isRecoveryAttempt("recovery", "/")).toBe(true);
    expect(isRecoveryAttempt("recovery", "/reset-password")).toBe(true);
  });

  it("next === '/reset-password' -> true, even with no/other type (failed code-exchange fallback signal)", () => {
    expect(isRecoveryAttempt(null, "/reset-password")).toBe(true);
    expect(isRecoveryAttempt("signup", "/reset-password")).toBe(true);
  });

  it("neither signal present -> false", () => {
    expect(isRecoveryAttempt(null, "/")).toBe(false);
    expect(isRecoveryAttempt("signup", "/")).toBe(false);
    expect(isRecoveryAttempt("email", "/library")).toBe(false);
  });
});

describe("GET /auth/callback", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    mockExchangeCodeForSession.mockReset();
    mockVerifyOtp.mockReset();
  });

  it("a successful recovery exchange sets the recovery cookie", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: {}, user: {}, redirectType: "recovery" },
      error: null,
    });

    const response = await GET(
      new Request("https://librumal.vercel.app/auth/callback?code=abc&next=/reset-password"),
    );

    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
    const setCookieHeader = response.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(`${RECOVERY_COOKIE_NAME}=1`);
    expect(setCookieHeader.toLowerCase()).toContain("httponly");
  });

  // LAUNCH-1 P1-11 STALE-MARKER CORRECTION: this route also handles
  // ordinary, non-recovery confirmations (its own doc comment: "signup/
  // password-reset confirmation"). A confirmed successful exchange that
  // is NOT a recovery exchange now CLEARS any stale recovery marker
  // (does not merely leave it untouched) -- see the equivalent
  // regression in src/app/auth/actions.test.ts for login().
  it("an ordinary (non-recovery) successful exchange clears any stale recovery marker, and never sets one", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: {}, user: {}, redirectType: null },
      error: null,
    });

    const response = await GET(
      new Request("https://librumal.vercel.app/auth/callback?code=abc&next=/"),
    );

    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
    const setCookieHeader = response.headers.get("set-cookie") ?? "";
    // A clear/delete is expressed as a Set-Cookie with an empty value and
    // an already-past Expires -- never the "=1" the active-marker value
    // would carry.
    expect(setCookieHeader).toContain(RECOVERY_COOKIE_NAME);
    expect(setCookieHeader).not.toContain(`${RECOVERY_COOKIE_NAME}=1`);
  });

  it("a failed exchange does not clear an existing recovery marker (failed/unknown exchange must not weaken active recovery state)", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null, redirectType: null },
      error: { message: "invalid code" },
    });

    const response = await GET(
      new Request("https://librumal.vercel.app/auth/callback?code=bad&next=/reset-password"),
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    // AUTH-1E: next=/reset-password is the recovery-attempt fallback
    // signal (see isRecoveryAttempt()) -- the safe error copy must be
    // the recovery-specific one, never "Could not confirm your email".
    expect(location.searchParams.get("error")).toBe(
      "This password reset link is invalid or has expired. Please request a new one.",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("no code and no token_hash at all redirects to /login with the generic confirmation-link message, never touches the recovery cookie, and never creates a Supabase client", async () => {
    const response = await GET(new Request("https://librumal.vercel.app/auth/callback"));

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe(
      "This confirmation link is invalid or has expired. Please request a new one.",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  // LAUNCH-1 P1: `next` is now routed through the same centralized
  // safe-redirect policy login() uses (src/lib/safe-redirect.ts) rather
  // than the previous `${origin}${next}` string concatenation, whose
  // safety against a raw unvalidated `next` was accidental (a property of
  // how NextResponse.redirect happened to be called, not a designed
  // guard). These assert on the actual Location header, not just the pure
  // helper (already covered directly in src/lib/safe-redirect.test.ts).
  describe("`next` redirect safety", () => {
    it("a legitimate internal next is honored", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { session: {}, user: {}, redirectType: null },
        error: null,
      });

      const response = await GET(
        new Request("https://librumal.vercel.app/auth/callback?code=abc&next=/library"),
      );

      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://librumal.vercel.app");
      expect(location.pathname).toBe("/library");
    });

    it("a protocol-relative next cannot produce a cross-origin Location", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { session: {}, user: {}, redirectType: null },
        error: null,
      });

      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?code=abc&next=" +
            encodeURIComponent("//evil.com/phish"),
        ),
      );

      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://librumal.vercel.app");
      expect(location.hostname).not.toBe("evil.com");
      // Falls back to the route's existing default destination ("/"),
      // not an error page -- an invalid `next` is ignored, same policy
      // as login()'s.
      expect(location.pathname).toBe("/");
    });

    it("a backslash-host next cannot produce a cross-origin Location", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { session: {}, user: {}, redirectType: null },
        error: null,
      });

      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?code=abc&next=" +
            encodeURIComponent("/\\evil.com/phish"),
        ),
      );

      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://librumal.vercel.app");
      expect(location.hostname).not.toBe("evil.com");
      expect(location.pathname).toBe("/");
    });

    it("a full external URL as next cannot produce a cross-origin Location", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { session: {}, user: {}, redirectType: null },
        error: null,
      });

      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?code=abc&next=" +
            encodeURIComponent("https://evil.com/phish"),
        ),
      );

      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://librumal.vercel.app");
      expect(location.hostname).not.toBe("evil.com");
      expect(location.pathname).toBe("/");
    });

    it("an unsafe next does not weaken P1-11 recovery-marker behavior -- a recovery exchange still sets the marker", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { session: {}, user: {}, redirectType: "recovery" },
        error: null,
      });

      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?code=abc&next=" +
            encodeURIComponent("//evil.com/phish"),
        ),
      );

      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://librumal.vercel.app");
      const setCookieHeader = response.headers.get("set-cookie") ?? "";
      expect(setCookieHeader).toContain(`${RECOVERY_COOKIE_NAME}=1`);
    });

    it("an unsafe next on an ordinary exchange still clears a stale recovery marker", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { session: {}, user: {}, redirectType: null },
        error: null,
      });

      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?code=abc&next=" +
            encodeURIComponent("https://evil.com/phish"),
        ),
      );

      const setCookieHeader = response.headers.get("set-cookie") ?? "";
      expect(setCookieHeader).toContain(RECOVERY_COOKIE_NAME);
      expect(setCookieHeader).not.toContain(`${RECOVERY_COOKIE_NAME}=1`);
    });

    it("a failed exchange with an unsafe next still redirects to /login, unaffected by next validation, and still does not touch the recovery marker", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { session: null, user: null, redirectType: null },
        error: { message: "invalid code" },
      });

      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?code=bad&next=" +
            encodeURIComponent("//evil.com/phish"),
        ),
      );

      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://librumal.vercel.app");
      expect(location.pathname).toBe("/login");
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  });
});

// AUTH-1E: the token_hash/verifyOtp() path -- for links that arrive
// with no stored PKCE verifier (see route.ts's top-of-file comment).
describe("GET /auth/callback: token_hash/verifyOtp() path (AUTH-1E)", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    mockExchangeCodeForSession.mockReset();
    mockVerifyOtp.mockReset();
  });

  it("a valid signup confirmation link (type=signup) verifies, establishes a session, and does NOT set the recovery marker", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { session: {}, user: {} },
      error: null,
    });

    const response = await GET(
      new Request(
        "https://librumal.vercel.app/auth/callback?token_hash=th_abc&type=signup&next=/",
      ),
    );

    expect(mockVerifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "th_abc" });
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
    const setCookieHeader = response.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(RECOVERY_COOKIE_NAME);
    expect(setCookieHeader).not.toContain(`${RECOVERY_COOKIE_NAME}=1`);
  });

  it("a valid recovery link (type=recovery) verifies, establishes a session, SETS the recovery marker, and redirects to /reset-password", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { session: {}, user: {} },
      error: null,
    });

    const response = await GET(
      new Request(
        "https://librumal.vercel.app/auth/callback?token_hash=th_recovery&type=recovery&next=/reset-password",
      ),
    );

    expect(mockVerifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "th_recovery" });
    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
    const setCookieHeader = response.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(`${RECOVERY_COOKIE_NAME}=1`);
    expect(setCookieHeader.toLowerCase()).toContain("httponly");
  });

  it("an invalid/expired signup confirmation token_hash gets the confirmation-specific safe error, never the recovery one", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "Token has expired or is invalid" },
    });

    const response = await GET(
      new Request(
        "https://librumal.vercel.app/auth/callback?token_hash=th_bad&type=signup&next=/",
      ),
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe(
      "This confirmation link is invalid or has expired. Please request a new one.",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("an invalid/expired recovery token_hash gets the recovery-specific safe error, never 'Could not confirm your email'", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "Token has expired or is invalid" },
    });

    const response = await GET(
      new Request(
        "https://librumal.vercel.app/auth/callback?token_hash=th_bad&type=recovery&next=/reset-password",
      ),
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe(
      "This password reset link is invalid or has expired. Please request a new one.",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("never exposes the raw Supabase/GoTrue error message for a failed verification", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "otp_expired: raw provider detail that must never reach the browser" },
    });

    const response = await GET(
      new Request(
        "https://librumal.vercel.app/auth/callback?token_hash=th_bad&type=recovery&next=/reset-password",
      ),
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).not.toContain("otp_expired");
    expect(location.searchParams.get("error")).not.toContain("raw provider detail");
  });

  it("does not attempt verifyOtp() when only token_hash is present without type (malformed link), and never creates a Supabase client", async () => {
    const response = await GET(
      new Request("https://librumal.vercel.app/auth/callback?token_hash=th_only"),
    );

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe(
      "This confirmation link is invalid or has expired. Please request a new one.",
    );
  });

  // AUTH-1E revision: `type` is a closed, Librum-controlled set
  // ("signup"/"recovery" only) -- the SDK's own EmailOtpType also
  // includes "invite"/"magiclink"/"email"/"email_change"/an open
  // string fallback, none of which this route accepts, since `type`
  // also decides whether to set the recovery-session restriction.
  describe("unsupported token_hash types are rejected before verifyOtp() is ever called", () => {
    it.each(["magiclink", "email", "email_change", "invite", "some_future_type"])(
      "type=%s: does not call verifyOtp(), does not create a Supabase client, and does not touch the recovery marker",
      async (unsupportedType) => {
        const response = await GET(
          new Request(
            `https://librumal.vercel.app/auth/callback?token_hash=th_x&type=${unsupportedType}&next=/`,
          ),
        );

        expect(mockVerifyOtp).not.toHaveBeenCalled();
        expect(mockCreateClient).not.toHaveBeenCalled();
        expect(response.headers.get("set-cookie")).toBeNull();
        const location = new URL(response.headers.get("location")!);
        expect(location.pathname).toBe("/login");
      },
    );

    it("an unsupported type combined with next=/reset-password still gets the recovery-specific copy (isRecoveryAttempt's own next-based fallback), even though verifyOtp() is never called", async () => {
      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?token_hash=th_x&type=email&next=/reset-password",
        ),
      );

      expect(mockVerifyOtp).not.toHaveBeenCalled();
      const location = new URL(response.headers.get("location")!);
      expect(location.searchParams.get("error")).toBe(
        "This password reset link is invalid or has expired. Please request a new one.",
      );
    });
  });

  it("a `code` param takes precedence over token_hash/type when both are somehow present -- the existing PKCE path is not shadowed", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: {}, user: {}, redirectType: null },
      error: null,
    });

    await GET(
      new Request(
        "https://librumal.vercel.app/auth/callback?code=abc&token_hash=th_abc&type=signup&next=/",
      ),
    );

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  describe("open-redirect protection also applies to the token_hash path", () => {
    it("an unsafe next on a successful token_hash verification cannot produce a cross-origin Location", async () => {
      mockVerifyOtp.mockResolvedValue({
        data: { session: {}, user: {} },
        error: null,
      });

      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?token_hash=th_abc&type=signup&next=" +
            encodeURIComponent("https://evil.com/phish"),
        ),
      );

      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://librumal.vercel.app");
      expect(location.hostname).not.toBe("evil.com");
      expect(location.pathname).toBe("/");
    });

    it("an unsafe next on a successful recovery token_hash verification still sets the marker safely, off-origin next ignored", async () => {
      mockVerifyOtp.mockResolvedValue({
        data: { session: {}, user: {} },
        error: null,
      });

      const response = await GET(
        new Request(
          "https://librumal.vercel.app/auth/callback?token_hash=th_recovery&type=recovery&next=" +
            encodeURIComponent("//evil.com/phish"),
        ),
      );

      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://librumal.vercel.app");
      const setCookieHeader = response.headers.get("set-cookie") ?? "";
      expect(setCookieHeader).toContain(`${RECOVERY_COOKIE_NAME}=1`);
    });
  });
});

// AUTH-1E: source-contract check -- this route handles a raw one-time
// token_hash and PKCE code on every request; neither may ever reach a
// log line (Vercel runtime logs are not a secure secret store). Reading
// the actual source rather than only asserting on mock call args means
// a future edit that adds a stray `console.log(tokenHash)`-style
// diagnostic fails this test immediately, not just in code review.
describe("route.ts: no secret/token logging (AUTH-1E)", () => {
  it("the route source contains no console.* calls at all", () => {
    const source = readFileSync(
      new URL("./route.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/console\.\w+\(/);
  });
});
