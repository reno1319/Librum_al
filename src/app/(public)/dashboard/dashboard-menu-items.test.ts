import { describe, expect, it } from "vitest";
import {
  DASHBOARD_MENU_GROUPS,
  findDashboardMenuMatch,
  groupAriaCurrent,
  isAtOrBelow,
  itemAriaCurrent,
} from "./dashboard-menu-items";

// FIX STEP F2: path -> group/item mapping for the dashboard menu.
function labels(pathname: string) {
  const match = findDashboardMenuMatch(pathname);
  return match ? `${match.group.label}/${match.item.label}` : null;
}

describe("dashboard menu groups", () => {
  it("has Renato's four groups and the existing page names", () => {
    expect(DASHBOARD_MENU_GROUPS.map((g) => [g.label, g.items.map((i) => `${i.label} ${i.href}`)])).toEqual([
      ["Books", ["Books /dashboard", "Series /dashboard/series"]],
      ["Money", ["Sales /dashboard/sales", "Financial balance /dashboard/balance", "Payouts /dashboard/payouts"]],
      ["Promotion", ["Bundles /dashboard/bundles", "Discounts /dashboard/discounts"]],
      ["Profile", ["Profile /dashboard/profile"]],
    ]);
  });

  it("has no separate Dashboard item and no item for /dashboard/books", () => {
    const items = DASHBOARD_MENU_GROUPS.flatMap((g) => g.items);
    expect(items.map((i) => i.label)).not.toContain("Dashboard");
    expect(items.map((i) => i.href)).not.toContain("/dashboard/books");
  });
});

describe("findDashboardMenuMatch", () => {
  it.each([
    ["/dashboard", "Books/Books"],
    ["/dashboard/", "Books/Books"],
    ["/dashboard/books", "Books/Books"],
    ["/dashboard/books/new", "Books/Books"],
    ["/dashboard/books/abc/edit", "Books/Books"],
    ["/dashboard/series", "Books/Series"],
    ["/dashboard/sales", "Money/Sales"],
    ["/dashboard/balance", "Money/Financial balance"],
    ["/dashboard/payouts", "Money/Payouts"],
    ["/dashboard/bundles", "Promotion/Bundles"],
    ["/dashboard/bundles/abc/edit", "Promotion/Bundles"],
    ["/dashboard/discounts", "Promotion/Discounts"],
    ["/dashboard/profile", "Profile/Profile"],
  ])("%s -> %s", (pathname, expected) => {
    expect(labels(pathname)).toBe(expected);
  });

  it.each([
    "/dashboard/unknown",
    "/dashboard/booksx",
    "/dashboard/salesx",
    "/dashboard-other",
    "/dashboardx",
    "/account",
    "/",
    "",
  ])("marks nothing for %s", (pathname) => {
    expect(findDashboardMenuMatch(pathname)).toBeNull();
  });
});

describe("isAtOrBelow", () => {
  it("matches on path-segment boundaries only", () => {
    expect(isAtOrBelow("/dashboard/books", "/dashboard/books")).toBe(true);
    expect(isAtOrBelow("/dashboard/books/x", "/dashboard/books")).toBe(true);
    expect(isAtOrBelow("/dashboard/booksx", "/dashboard/books")).toBe(false);
  });
});

describe("aria-current", () => {
  const [books, money, promotion, profile] = DASHBOARD_MENU_GROUPS;
  const current = (pathname: string) => {
    const match = findDashboardMenuMatch(pathname);
    return {
      groups: DASHBOARD_MENU_GROUPS.map((g) => groupAriaCurrent(g, match, pathname)),
      items: DASHBOARD_MENU_GROUPS.flatMap((g) => g.items).map((i) => itemAriaCurrent(i, match, pathname)),
    };
  };

  it("an item is 'page' only on its own page, the group 'true'", () => {
    expect(current("/dashboard")).toEqual({
      groups: ["true", undefined, undefined, undefined],
      items: ["page", undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    });
    expect(current("/dashboard/balance").items[3]).toBe("page");
    expect(current("/dashboard/balance").groups).toEqual([undefined, "true", undefined, undefined]);
  });

  it.each(["/dashboard/books", "/dashboard/books/new", "/dashboard/books/abc/edit"])(
    "Books item is 'true' (not 'page') on %s",
    (pathname) => {
      expect(current(pathname).items[0]).toBe("true");
      expect(current(pathname).groups[0]).toBe("true");
    },
  );

  it("bundle edit marks Bundles 'true'", () => {
    expect(current("/dashboard/bundles/abc/edit").items[5]).toBe("true");
    expect(current("/dashboard/bundles/abc/edit").groups[2]).toBe("true");
  });

  it("the single-item Profile tab is 'page'", () => {
    expect(current("/dashboard/profile").groups[3]).toBe("page");
  });

  it("an unknown path marks nothing", () => {
    const { groups, items } = current("/dashboard/unknown");
    expect([...groups, ...items].every((v) => v === undefined)).toBe(true);
  });

  it("uses the groups in order", () => {
    expect([books.label, money.label, promotion.label, profile.label]).toEqual([
      "Books",
      "Money",
      "Promotion",
      "Profile",
    ]);
  });
});
