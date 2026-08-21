import { describe, expect, it } from "vitest";
import { decideAdminAccess } from "./auth";

// requireAdmin() itself is not directly unit-testable in this suite:
// it calls src/lib/supabase/server.ts's createClient(), which reads
// Next.js's request-scoped cookies() -- that machinery only exists
// inside an actual Next.js request/render context, not in a plain
// Vitest/Node environment, and mocking it away would just end up
// re-testing this same decision logic through a much heavier,
// less-honest harness. decideAdminAccess() is the actual authorization
// decision requireAdmin() delegates to (same extraction technique
// already used for the bundle-checkout link-back decision in
// src/app/bundles/[id]/link-back.ts) -- testing it directly covers the
// exact four cases that matter, without inventing fake Next.js coverage.
describe("decideAdminAccess", () => {
  it("unauthenticated user -> denied", () => {
    const decision = decideAdminAccess({ userId: null, profileRole: undefined });
    expect(decision).toEqual({ kind: "unauthenticated" });
  });

  it("authenticated reader -> denied", () => {
    const decision = decideAdminAccess({ userId: "user-1", profileRole: "reader" });
    expect(decision).toEqual({ kind: "forbidden" });
  });

  it("authenticated author -> denied", () => {
    const decision = decideAdminAccess({ userId: "user-1", profileRole: "author" });
    expect(decision).toEqual({ kind: "forbidden" });
  });

  it("authenticated admin -> allowed", () => {
    const decision = decideAdminAccess({ userId: "user-1", profileRole: "admin" });
    expect(decision).toEqual({ kind: "allow" });
  });

  it("authenticated user with no profile row -> denied, not allowed by default", () => {
    const decision = decideAdminAccess({ userId: "user-1", profileRole: null });
    expect(decision).toEqual({ kind: "forbidden" });
  });
});
