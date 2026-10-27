import { describe, expect, it, vi } from "vitest";
import { SECURITY_HEADER_RULES } from "./security-headers";

vi.mock("@/lib/supabase/env-guard", () => ({ assertSupabaseEnvSafeForExecution: () => {} }));

const { default: nextConfig } = await import("../../next.config");

function headersFor(source: string): Record<string, string> {
  const rule = SECURITY_HEADER_RULES.find((r) => r.source === source);
  expect(rule).toBeDefined();
  return Object.fromEntries(rule!.headers.map((h) => [h.key, h.value]));
}

describe("B4 security headers", () => {
  it("next.config sends exactly these rules", async () => {
    expect(await nextConfig.headers!()).toEqual(SECURITY_HEADER_RULES);
  });

  it("next.config does not send x-powered-by (COVERS-1)", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("the first rule covers every path and blocks framing, sniffing and unused features", () => {
    expect(SECURITY_HEADER_RULES[0]?.source).toBe("/:path*");
    expect(headersFor("/:path*")).toEqual({
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    });
  });

  it("the site-wide CSP carries nothing but frame-ancestors", () => {
    expect(headersFor("/:path*")["Content-Security-Policy"]).not.toContain(";");
  });

  it.each(["/login", "/payments/:path*", "/auth/:path*"])(
    "%s sends no referrer to other sites, and comes after the site-wide rule",
    (source) => {
      expect(headersFor(source)).toEqual({ "Referrer-Policy": "same-origin" });
      expect(SECURITY_HEADER_RULES.findIndex((r) => r.source === source)).toBeGreaterThan(0);
    },
  );

  // "no-referrer" makes browsers send Origin: null on a form POST, which
  // the Server Action origin check refuses (the login form would break).
  it("never uses no-referrer anywhere", () => {
    const values = SECURITY_HEADER_RULES.flatMap((r) => r.headers.map((h) => h.value));
    expect(values).not.toContain("no-referrer");
  });
});
