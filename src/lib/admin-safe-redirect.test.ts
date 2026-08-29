import { describe, expect, it } from "vitest";
import { resolveSafeAdminPath } from "./admin-safe-redirect";

// ADMIN-1A.5: resolveSafeAdminPath's own accept/reject boundary, on top
// of the already-exhaustively-tested resolveSafeInternalPath
// (src/lib/safe-redirect.test.ts). Every case the task's own "Safe next
// handling" section names explicitly is covered here by name.
describe("resolveSafeAdminPath: accepts only /admin destinations", () => {
  it("bare /admin", () => {
    expect(resolveSafeAdminPath("/admin")).toBe("/admin");
  });

  it("/admin/reports", () => {
    expect(resolveSafeAdminPath("/admin/reports")).toBe("/admin/reports");
  });

  it("/admin/refunds", () => {
    expect(resolveSafeAdminPath("/admin/refunds")).toBe("/admin/refunds");
  });

  it("a nested /admin/refunds/[id] path", () => {
    expect(resolveSafeAdminPath("/admin/refunds/abc-123")).toBe("/admin/refunds/abc-123");
  });

  it("preserves a query string on an /admin/... destination", () => {
    expect(resolveSafeAdminPath("/admin/reports?status=open")).toBe(
      "/admin/reports?status=open",
    );
  });
});

describe("resolveSafeAdminPath: rejects everything not under /admin", () => {
  it("external https URL", () => {
    expect(resolveSafeAdminPath("https://evil.com")).toBeNull();
  });

  it("protocol-relative URL", () => {
    expect(resolveSafeAdminPath("//evil.com")).toBeNull();
  });

  it("a legitimate same-site path that is not under /admin (/dashboard)", () => {
    expect(resolveSafeAdminPath("/dashboard")).toBeNull();
  });

  it("a legitimate same-site path that is not under /admin (/books/...)", () => {
    expect(resolveSafeAdminPath("/books/123")).toBeNull();
  });

  it("a legitimate same-site path that is not under /admin (/auth/...)", () => {
    expect(resolveSafeAdminPath("/auth/callback")).toBeNull();
  });

  it("a path that merely starts with /admin as a prefix of a different segment (/administrator)", () => {
    expect(resolveSafeAdminPath("/administrator")).toBeNull();
  });

  it("empty string", () => {
    expect(resolveSafeAdminPath("")).toBeNull();
  });

  it("null", () => {
    expect(resolveSafeAdminPath(null)).toBeNull();
  });

  it("undefined", () => {
    expect(resolveSafeAdminPath(undefined)).toBeNull();
  });

  it("javascript: scheme", () => {
    expect(resolveSafeAdminPath("javascript:alert(1)")).toBeNull();
  });
});
