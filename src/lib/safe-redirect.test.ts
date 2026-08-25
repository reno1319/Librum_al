import { describe, expect, it } from "vitest";
import { resolveSafeInternalPath } from "./safe-redirect";

// LAUNCH-1 P1: the only thing under test here is resolveSafeInternalPath's
// own accept/reject boundary -- pure function, no Next.js/Supabase mocking
// needed, same "extract a pure decision function, unit-test it directly"
// pattern already used elsewhere in this codebase (decideAdminAccess,
// buildSiteHeaderNav, detectCoverImageKind).

describe("resolveSafeInternalPath: accepts legitimate same-site destinations", () => {
  it("root path", () => {
    expect(resolveSafeInternalPath("/")).toBe("/");
  });

  it("simple internal path", () => {
    expect(resolveSafeInternalPath("/books/123")).toBe("/books/123");
  });

  it("path with a query string", () => {
    expect(resolveSafeInternalPath("/library?tab=recent")).toBe("/library?tab=recent");
  });

  it("path with both a query string and a fragment survive together, unmodified", () => {
    expect(resolveSafeInternalPath("/books/123?from=checkout#details")).toBe(
      "/books/123?from=checkout#details",
    );
  });

  it("another plain internal destination", () => {
    expect(resolveSafeInternalPath("/dashboard/payouts")).toBe("/dashboard/payouts");
  });

  it("a normalized same-origin path (dot-segment) remains same-origin and internal", () => {
    expect(resolveSafeInternalPath("/./library")).toBe("/library");
  });

  it("percent-encoded slashes in the path are preserved as path content, not treated as host separators, and stay same-origin", () => {
    const result = resolveSafeInternalPath("/%2F%2Fevil.com");
    expect(result).not.toBeNull();
    expect(result).toBe("/%2F%2Fevil.com");
  });

  it("percent-encoded backslashes in the path are preserved as path content and stay same-origin", () => {
    const result = resolveSafeInternalPath("/%5C%5Cevil.com");
    expect(result).not.toBeNull();
    expect(result).toBe("/%5C%5Cevil.com");
  });

  it("percent-encoded dot-segment (%2e%2e) normalizes within the internal path, never escapes the origin", () => {
    const result = resolveSafeInternalPath("/%2e%2e/account");
    expect(result).not.toBeNull();
    expect(result).toBe("/account");
  });

  it("a doubled internal path separator stays internal", () => {
    const result = resolveSafeInternalPath("/books//123");
    expect(result).not.toBeNull();
    expect(result).toBe("/books//123");
  });
});

describe("resolveSafeInternalPath: rejects everything that could leave the site", () => {
  it("protocol-relative URL", () => {
    expect(resolveSafeInternalPath("//evil.com/phish")).toBeNull();
  });

  it("backslash-host form -- WHATWG URL parsing treats a leading '/\\' as a network-path reference for special schemes, so this must be rejected by origin comparison, not merely accepted for 'starting with /'", () => {
    expect(resolveSafeInternalPath("/\\evil.com/phish")).toBeNull();
  });

  it("full external https URL", () => {
    expect(resolveSafeInternalPath("https://evil.com/phish")).toBeNull();
  });

  it("full external http URL", () => {
    expect(resolveSafeInternalPath("http://evil.com")).toBeNull();
  });

  it("javascript: scheme", () => {
    expect(resolveSafeInternalPath("javascript:alert(1)")).toBeNull();
  });

  it("data: scheme", () => {
    expect(resolveSafeInternalPath("data:text/html,test")).toBeNull();
  });

  it("bare host-shaped string with no leading slash", () => {
    expect(resolveSafeInternalPath("evil.com/foo")).toBeNull();
  });

  it("bare backslash-host with no leading slash", () => {
    expect(resolveSafeInternalPath("\\evil.com")).toBeNull();
  });

  it("empty string", () => {
    expect(resolveSafeInternalPath("")).toBeNull();
  });

  it("whitespace-only input", () => {
    expect(resolveSafeInternalPath("   ")).toBeNull();
  });

  it("null", () => {
    expect(resolveSafeInternalPath(null)).toBeNull();
  });

  it("undefined", () => {
    expect(resolveSafeInternalPath(undefined)).toBeNull();
  });

  it("triple-slash form", () => {
    expect(resolveSafeInternalPath("///evil.com")).toBeNull();
  });

  it("mixed backslash/slash network-path form", () => {
    expect(resolveSafeInternalPath("\\/evil.com")).toBeNull();
  });
});
