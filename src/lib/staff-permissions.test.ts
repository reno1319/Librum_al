import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, roleHasPermission } from "./staff-permissions";
import type { Permission, StaffRole } from "./types";

const ALL_ROLES: StaffRole[] = ["owner", "admin", "editor", "moderator", "support"];
const ALL_PERMISSIONS: Permission[] = [
  "admin.access",
  "reports.view",
  "reports.resolve",
  "refunds.view",
  "refunds.resolve",
  "staff.view",
  "staff.manage",
  "audit.view",
];

// Exhaustive stress test of the full role x permission matrix -- every
// cell is asserted explicitly, both the grants and the denials, so a
// future edit that accidentally widens or narrows a role's permissions
// fails a specific, readable assertion rather than a vague "wrong count"
// check. This table is also the human-readable source of truth this
// suite is checking ROLE_PERMISSIONS against -- keep it in sync
// deliberately, not automatically, if the matrix ever changes.
const EXPECTED: Record<StaffRole, Permission[]> = {
  owner: [
    "admin.access",
    "reports.view",
    "reports.resolve",
    "refunds.view",
    "refunds.resolve",
    "staff.view",
    "staff.manage",
    "audit.view",
  ],
  admin: [
    "admin.access",
    "reports.view",
    "reports.resolve",
    "refunds.view",
    "refunds.resolve",
    "staff.view",
    "audit.view",
  ],
  moderator: ["admin.access", "reports.view", "reports.resolve"],
  support: ["admin.access", "refunds.view"],
  editor: [],
};

describe("ROLE_PERMISSIONS matrix", () => {
  for (const role of ALL_ROLES) {
    describe(`role: ${role}`, () => {
      const granted = new Set(EXPECTED[role]);

      for (const permission of ALL_PERMISSIONS) {
        const expected = granted.has(permission);
        it(`${expected ? "grants" : "denies"} ${permission}`, () => {
          expect(roleHasPermission(role, permission)).toBe(expected);
        });
      }
    });
  }
});

describe("roleHasPermission -- named scenarios from the ADMIN-1A design brief", () => {
  it("moderator can view and resolve reports", () => {
    expect(roleHasPermission("moderator", "reports.view")).toBe(true);
    expect(roleHasPermission("moderator", "reports.resolve")).toBe(true);
  });

  it("moderator cannot view or resolve refunds", () => {
    expect(roleHasPermission("moderator", "refunds.view")).toBe(false);
    expect(roleHasPermission("moderator", "refunds.resolve")).toBe(false);
  });

  it("support can view refunds but cannot resolve them", () => {
    expect(roleHasPermission("support", "refunds.view")).toBe(true);
    expect(roleHasPermission("support", "refunds.resolve")).toBe(false);
  });

  it("support has no reports access (not justified by any current concrete use)", () => {
    expect(roleHasPermission("support", "reports.view")).toBe(false);
    expect(roleHasPermission("support", "reports.resolve")).toBe(false);
  });

  it("staff.manage is restricted to owner only -- not even admin holds it", () => {
    expect(roleHasPermission("owner", "staff.manage")).toBe(true);
    for (const role of ALL_ROLES.filter((r) => r !== "owner")) {
      expect(roleHasPermission(role, "staff.manage")).toBe(false);
    }
  });

  it("editor has zero permissions -- no admin surface exists yet to justify any grant", () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(roleHasPermission("editor", permission)).toBe(false);
    }
    expect(ROLE_PERMISSIONS.editor).toEqual([]);
  });

  it("audit.view is granted to owner and admin only (ADMIN-1C Part B)", () => {
    expect(roleHasPermission("owner", "audit.view")).toBe(true);
    expect(roleHasPermission("admin", "audit.view")).toBe(true);
    for (const role of ["moderator", "support", "editor"] as const) {
      expect(roleHasPermission(role, "audit.view")).toBe(false);
    }
  });

  it("admin has every permission owner has except staff.manage", () => {
    const ownerMinusManage = EXPECTED.owner.filter((p) => p !== "staff.manage");
    for (const permission of ownerMinusManage) {
      expect(roleHasPermission("admin", permission)).toBe(true);
    }
    expect(roleHasPermission("admin", "staff.manage")).toBe(false);
  });

  it("owner holds every defined permission", () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(roleHasPermission("owner", permission)).toBe(true);
    }
  });
});
