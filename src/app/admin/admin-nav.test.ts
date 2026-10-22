import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ITEMS,
  findCurrentAdminNavItem,
  isAdminNavItemCurrent,
  resolveVisibleAdminNavGroups,
  resolveVisibleAdminNavItems,
} from "./admin-nav";
import type { StaffRole } from "@/lib/types";

// ADMIN-1A.5 "CURRENT ROLE EXPECTATIONS" -- exercised by name, against
// the actual nav config, not a re-derivation of the permission matrix
// itself (already exhaustively covered by
// src/lib/staff-permissions.test.ts). ADMIN-1 (A2 look): the menu is
// grouped (Daily, Catalog, Money, Team), "Dashboard" is now "Today",
// and every item keeps its own permission.
function groupsFor(role: StaffRole) {
  return resolveVisibleAdminNavGroups(role).map((g) => ({ label: g.label, hrefs: g.items.map((i) => i.href) }));
}

describe("ADMIN_NAV_GROUPS", () => {
  it("lists the existing pages in the agreed groups and order", () => {
    expect(ADMIN_NAV_GROUPS.map((g) => ({ label: g.label, items: g.items.map((i) => i.label) }))).toEqual([
      { label: "Daily", items: ["Today", "Book reports", "Refund requests"] },
      { label: "Catalog", items: ["Books", "Librum's choice", "Blog"] },
      { label: "Money", items: ["Finance"] },
      { label: "Team", items: ["Staff", "Audit log"] },
    ]);
  });

  it('renames "Dashboard" to "Today" and keeps no Dashboard entry', () => {
    const labels = ADMIN_NAV_ITEMS.map((i) => i.label);
    expect(labels).toContain("Today");
    expect(labels).not.toContain("Dashboard");
    expect(ADMIN_NAV_ITEMS.find((i) => i.href === "/admin")?.label).toBe("Today");
  });

  it("ADMIN_NAV_ITEMS is the groups' items, flattened in menu order", () => {
    expect(ADMIN_NAV_ITEMS).toEqual(ADMIN_NAV_GROUPS.flatMap((g) => g.items));
  });

  it("every nav item's permission matches its own destination route's real requireStaff() gate", () => {
    // A mismatch here would mean the nav shows a link that its own
    // destination would immediately redirect away from, or hides one a
    // role could actually use.
    const expected: Record<string, string> = {
      "/admin": "admin.access",
      "/admin/reports": "reports.view",
      // ADMIN-2-TAKEDOWN: the books list's own gate.
      "/admin/books": "reports.view",
      "/admin/refunds": "refunds.view",
      "/admin/staff": "staff.view",
      "/admin/audit": "audit.view",
      "/admin/finance": "finance.view",
      "/admin/blog": "blog.view",
      "/admin/librum-choice": "catalog.feature",
    };
    expect(ADMIN_NAV_ITEMS.map((i) => i.href).sort()).toEqual(Object.keys(expected).sort());
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.permission).toBe(expected[item.href]);
    }
  });
});

describe("resolveVisibleAdminNavGroups", () => {
  it("owner sees every group and page", () => {
    expect(groupsFor("owner")).toEqual([
      { label: "Daily", hrefs: ["/admin", "/admin/reports", "/admin/refunds"] },
      { label: "Catalog", hrefs: ["/admin/books", "/admin/librum-choice", "/admin/blog"] },
      { label: "Money", hrefs: ["/admin/finance"] },
      { label: "Team", hrefs: ["/admin/staff", "/admin/audit"] },
    ]);
  });

  it("admin sees every group and page", () => {
    expect(groupsFor("admin")).toEqual(groupsFor("owner"));
  });

  it("editor sees Today and Blog only; Money and Team are hidden", () => {
    expect(groupsFor("editor")).toEqual([
      { label: "Daily", hrefs: ["/admin"] },
      { label: "Catalog", hrefs: ["/admin/blog"] },
    ]);
  });

  // ADMIN-2-TAKEDOWN: Books is gated on reports.view, so a moderator now
  // also sees Catalog, with Books only.
  it("moderator sees Today and Book reports in Daily, and Books in Catalog", () => {
    expect(groupsFor("moderator")).toEqual([
      { label: "Daily", hrefs: ["/admin", "/admin/reports"] },
      { label: "Catalog", hrefs: ["/admin/books"] },
    ]);
  });

  it("support sees Today and Refund requests only, in Daily", () => {
    expect(groupsFor("support")).toEqual([{ label: "Daily", hrefs: ["/admin", "/admin/refunds"] }]);
  });

  it("never returns an empty group", () => {
    for (const role of ["owner", "admin", "editor", "moderator", "support"] as StaffRole[]) {
      for (const group of resolveVisibleAdminNavGroups(role)) {
        expect(group.items.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("resolveVisibleAdminNavItems", () => {
  it("matches the grouped resolver, flattened, for every role", () => {
    for (const role of ["owner", "admin", "editor", "moderator", "support"] as StaffRole[]) {
      expect(resolveVisibleAdminNavItems(role)).toEqual(resolveVisibleAdminNavGroups(role).flatMap((g) => g.items));
    }
  });

  it("editor does not gain any unrelated admin link (reports, books, refunds, staff, audit, finance, Librum's choice)", () => {
    const hrefs = resolveVisibleAdminNavItems("editor").map((i) => i.href);
    for (const unrelated of [
      "/admin/reports",
      "/admin/books",
      "/admin/refunds",
      "/admin/staff",
      "/admin/audit",
      "/admin/finance",
      "/admin/librum-choice",
    ]) {
      expect(hrefs).not.toContain(unrelated);
    }
  });
});

describe("current page", () => {
  it("Today is current on /admin only", () => {
    expect(isAdminNavItemCurrent("/admin", "/admin")).toBe(true);
    expect(isAdminNavItemCurrent("/admin/reports", "/admin")).toBe(false);
  });

  it("other items are current on their own page and its sub-pages, not on a look-alike prefix", () => {
    expect(isAdminNavItemCurrent("/admin/reports", "/admin/reports")).toBe(true);
    expect(isAdminNavItemCurrent("/admin/reports/abc", "/admin/reports")).toBe(true);
    expect(isAdminNavItemCurrent("/admin/reportsx", "/admin/reports")).toBe(false);
  });

  it("findCurrentAdminNavItem returns the matching visible item, or null", () => {
    const groups = resolveVisibleAdminNavGroups("owner");
    expect(findCurrentAdminNavItem("/admin/blog/new", groups)?.label).toBe("Blog");
    expect(findCurrentAdminNavItem("/admin", groups)?.label).toBe("Today");
    expect(findCurrentAdminNavItem("/admin/staff", resolveVisibleAdminNavGroups("editor"))).toBeNull();
  });
});
