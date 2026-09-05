import { describe, expect, it } from "vitest";
import { decideStaffAccess } from "./staff";

// requireStaff() itself is not directly unit-testable in this suite, for
// the exact same reason requireAdmin() wasn't (see src/lib/auth.test.ts):
// it calls src/lib/supabase/server.ts's createClient(), which needs a
// real Next.js request context. decideStaffAccess() is the actual
// authorization decision requireStaff() delegates to -- testing it
// directly covers unauthenticated access, non-staff access, and
// permission-denied access without inventing fake Next.js coverage.
describe("decideStaffAccess", () => {
  it("unauthenticated user -> denied", () => {
    const decision = decideStaffAccess({
      userId: null,
      staffRole: null,
      permission: "admin.access",
    });
    expect(decision).toEqual({ kind: "unauthenticated" });
  });

  it("authenticated, non-staff user (no staff_members row) -> denied, not allowed by default", () => {
    const decision = decideStaffAccess({
      userId: "user-1",
      staffRole: null,
      permission: "admin.access",
    });
    expect(decision).toEqual({ kind: "forbidden" });
  });

  it("staff member whose role lacks the required permission -> denied", () => {
    const decision = decideStaffAccess({
      userId: "user-1",
      staffRole: "moderator",
      permission: "refunds.resolve",
    });
    expect(decision).toEqual({ kind: "forbidden" });
  });

  it("staff member whose role holds the required permission -> allowed", () => {
    const decision = decideStaffAccess({
      userId: "user-1",
      staffRole: "moderator",
      permission: "reports.resolve",
    });
    expect(decision).toEqual({ kind: "allow" });
  });

  it("owner -> allowed for every permission", () => {
    const decision = decideStaffAccess({
      userId: "user-1",
      staffRole: "owner",
      permission: "staff.manage",
    });
    expect(decision).toEqual({ kind: "allow" });
  });

  it("editor -> allowed for admin.access (BLOG-1B: the structural prerequisite to reach /admin/blog)", () => {
    const decision = decideStaffAccess({
      userId: "user-1",
      staffRole: "editor",
      permission: "admin.access",
    });
    expect(decision).toEqual({ kind: "allow" });
  });

  it("editor -> denied for a permission it doesn't hold (reports.view)", () => {
    const decision = decideStaffAccess({
      userId: "user-1",
      staffRole: "editor",
      permission: "reports.view",
    });
    expect(decision).toEqual({ kind: "forbidden" });
  });
});
