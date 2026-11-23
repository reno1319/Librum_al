import { describe, expect, it } from "vitest";
import {
  DASHBOARD_MENU_GROUPS,
  HOUSE_DASHBOARD_MENU_GROUPS,
  dashboardMenuGroups,
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
      ["Librat", ["Librat /dashboard", "Seritë /dashboard/series"]],
      ["Paratë", ["Shitjet /dashboard/sales", "Bilanci /dashboard/balance"]],
      ["Promovimi", ["Paketat /dashboard/bundles", "Zbritjet /dashboard/discounts"]],
      // AUTHOR PROFILI (build 1): pen names live inside Profili.
      ["Profili", ["Profili /dashboard/profile"]],
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
    ["/dashboard", "Librat/Librat"],
    ["/dashboard/", "Librat/Librat"],
    ["/dashboard/books", "Librat/Librat"],
    ["/dashboard/books/new", "Librat/Librat"],
    ["/dashboard/books/abc/edit", "Librat/Librat"],
    ["/dashboard/series", "Librat/Seritë"],
    ["/dashboard/sales", "Paratë/Shitjet"],
    ["/dashboard/balance", "Paratë/Bilanci"],
    ["/dashboard/bundles", "Promovimi/Paketat"],
    ["/dashboard/bundles/abc/edit", "Promovimi/Paketat"],
    ["/dashboard/discounts", "Promovimi/Zbritjet"],
    ["/dashboard/profile", "Profili/Profili"],
  ])("%s -> %s", (pathname, expected) => {
    expect(labels(pathname)).toBe(expected);
  });

  it.each([
    "/dashboard/unknown",
    "/dashboard/booksx",
    "/dashboard/salesx",
    "/dashboard/payouts",
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
    // DC 1: Librat has no second row, so its tab is the page itself.
    expect(current("/dashboard")).toEqual({
      groups: ["page", undefined, undefined, undefined],
      items: ["page", undefined, undefined, undefined, undefined, undefined, undefined],
    });
    expect(current("/dashboard/balance").items[3]).toBe("page");
    expect(current("/dashboard/balance").groups).toEqual([undefined, "true", undefined, undefined]);
    expect(current("/dashboard/series").groups).toEqual(["true", undefined, undefined, undefined]);
    expect(current("/dashboard/books/new").groups).toEqual(["true", undefined, undefined, undefined]);
  });

  it.each(["/dashboard/books", "/dashboard/books/new", "/dashboard/books/abc/edit"])(
    "Librat item is 'true' (not 'page') on %s",
    (pathname) => {
      expect(current(pathname).items[0]).toBe("true");
      expect(current(pathname).groups[0]).toBe("true");
    },
  );

  it("bundle edit marks Paketat 'true'", () => {
    expect(current("/dashboard/bundles/abc/edit").items[4]).toBe("true");
    expect(current("/dashboard/bundles/abc/edit").groups[2]).toBe("true");
  });

  // AUTHOR PROFILI (build 1): Profili is a one-item group again, so its
  // tab is the page itself.
  it("the Profili tab and its item are 'page' on /dashboard/profile", () => {
    expect(current("/dashboard/profile").groups[3]).toBe("page");
    expect(current("/dashboard/profile").items[6]).toBe("page");
  });

  it("an unknown path marks nothing", () => {
    const { groups, items } = current("/dashboard/unknown");
    expect([...groups, ...items].every((v) => v === undefined)).toBe(true);
  });

  it("uses the groups in order", () => {
    expect([books.label, money.label, promotion.label, profile.label]).toEqual([
      "Librat",
      "Paratë",
      "Promovimi",
      "Profili",
    ]);
  });
});

// BUILD 2a-2 (approved picture 7): a publishing house's Profili group
// is Profili | Autorët; nothing else changes.
describe("publishing house menu", () => {
  it("adds Autorët under Profili, keeps every other group as it is", () => {
    expect(HOUSE_DASHBOARD_MENU_GROUPS.map((g) => [g.label, g.items.map((i) => `${i.label} ${i.href}`)])).toEqual([
      ["Librat", ["Librat /dashboard", "Seritë /dashboard/series"]],
      ["Paratë", ["Shitjet /dashboard/sales", "Bilanci /dashboard/balance"]],
      ["Promovimi", ["Paketat /dashboard/bundles", "Zbritjet /dashboard/discounts"]],
      ["Profili", ["Profili /dashboard/profile", "Autorët /dashboard/authors"]],
    ]);
    expect(HOUSE_DASHBOARD_MENU_GROUPS.slice(0, 3)).toEqual(DASHBOARD_MENU_GROUPS.slice(0, 3));
    expect(HOUSE_DASHBOARD_MENU_GROUPS[3].desktopSubRow).toBeUndefined();
  });

  it("picks the menu by account kind", () => {
    expect(dashboardMenuGroups(true)).toBe(HOUSE_DASHBOARD_MENU_GROUPS);
    expect(dashboardMenuGroups(false)).toBe(DASHBOARD_MENU_GROUPS);
  });

  it.each([
    ["/dashboard/profile", "Profili/Profili"],
    ["/dashboard/authors", "Profili/Autorët"],
    ["/dashboard/authors/", "Profili/Autorët"],
  ])("%s -> %s", (pathname, expected) => {
    const match = findDashboardMenuMatch(pathname, HOUSE_DASHBOARD_MENU_GROUPS);
    expect(match ? `${match.group.label}/${match.item.label}` : null).toBe(expected);
  });

  it("the person menu does not know /dashboard/authors", () => {
    expect(findDashboardMenuMatch("/dashboard/authors")).toBeNull();
  });

  it("on Autorët the Profili tab is 'true' and Autorët is the page", () => {
    const match = findDashboardMenuMatch("/dashboard/authors", HOUSE_DASHBOARD_MENU_GROUPS);
    const profile = HOUSE_DASHBOARD_MENU_GROUPS[3];
    expect(groupAriaCurrent(profile, match, "/dashboard/authors")).toBe("true");
    expect(itemAriaCurrent(profile.items[1], match, "/dashboard/authors")).toBe("page");
    expect(itemAriaCurrent(profile.items[0], match, "/dashboard/authors")).toBeUndefined();
  });
});
