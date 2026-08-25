import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

const mockExchangeCodeForSession = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      auth: { exchangeCodeForSession: mockExchangeCodeForSession },
    }),
}));

const { GET, isRecoveryExchange } = await import("./route");

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

describe("GET /auth/callback", () => {
  beforeEach(() => {
    mockExchangeCodeForSession.mockReset();
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

    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("no code at all redirects to /login and never touches the recovery cookie", async () => {
    const response = await GET(new Request("https://librumal.vercel.app/auth/callback"));

    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });
});
