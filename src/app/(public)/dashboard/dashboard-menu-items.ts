// FIX STEP F2: the dashboard menu, grouped (Renato's answers): Books,
// Money, Promotion, Profile; Bundles under Promotion; "Books" opens
// /dashboard (the bookshelf) and the old separate "Dashboard" item is
// gone. Every item keeps its page's existing name.
// AUTHOR PAGES REDESIGN (Q11 a, Q13): the Stripe "Payouts" page is
// gone; /dashboard/payouts redirects to Financial balance
// (next.config.ts).

export type DashboardMenuItem = {
  href: string;
  label: string;
  // Extra paths that count as this item (segment-boundary prefixes).
  alsoMatches?: string[];
  // Whether paths below href (href/...) count as this item.
  nested?: boolean;
};

export type DashboardMenuGroup = {
  label: string;
  items: DashboardMenuItem[];
};

export const DASHBOARD_MENU_GROUPS: DashboardMenuGroup[] = [
  {
    label: "Books",
    items: [
      // /dashboard itself only; /dashboard/books ("All books", Add a
      // book, book edit) has no item of its own and counts as Books.
      { href: "/dashboard", label: "Books", alsoMatches: ["/dashboard/books"] },
      { href: "/dashboard/series", label: "Series", nested: true },
    ],
  },
  {
    label: "Money",
    items: [
      { href: "/dashboard/sales", label: "Sales", nested: true },
      { href: "/dashboard/balance", label: "Financial balance", nested: true },
    ],
  },
  {
    label: "Promotion",
    items: [
      { href: "/dashboard/bundles", label: "Bundles", nested: true },
      { href: "/dashboard/discounts", label: "Discounts", nested: true },
    ],
  },
  {
    label: "Profile",
    // PEN-NAMES-1: each pen name's own name, bio, photo and links.
    items: [
      { href: "/dashboard/profile", label: "Profile", nested: true },
      { href: "/dashboard/pen-names", label: "Pen names", nested: true },
    ],
  },
];

// True when `pathname` is `base` or lies below it on a path-segment
// boundary: /dashboard/books matches /dashboard/books/x, never
// /dashboard/booksx.
export function isAtOrBelow(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

function itemMatches(item: DashboardMenuItem, pathname: string): boolean {
  if (item.nested ? isAtOrBelow(pathname, item.href) : pathname === item.href) {
    return true;
  }
  return (item.alsoMatches ?? []).some((base) => isAtOrBelow(pathname, base));
}

// A trailing slash is the same page.
function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export type DashboardMenuMatch = {
  group: DashboardMenuGroup;
  item: DashboardMenuItem;
};

// The group and item the current page belongs to; null for a path the
// menu doesn't know (then nothing is marked).
export function findDashboardMenuMatch(pathname: string): DashboardMenuMatch | null {
  const path = normalize(pathname);
  for (const group of DASHBOARD_MENU_GROUPS) {
    for (const item of group.items) {
      if (itemMatches(item, path)) {
        return { group, item };
      }
    }
  }
  return null;
}

// aria-current for an item: "page" only when the path is the item's
// own page, "true" on a page beneath it (Add a book, book edit, bundle
// edit, /dashboard/books).
export function itemAriaCurrent(
  item: DashboardMenuItem,
  match: DashboardMenuMatch | null,
  pathname: string,
): "page" | "true" | undefined {
  if (match?.item !== item) return undefined;
  return normalize(pathname) === item.href ? "page" : "true";
}

// aria-current for a group tab: "true", except a single-item group,
// whose tab is that page itself (PEN-NAMES-1: Profile now has two items).
export function groupAriaCurrent(
  group: DashboardMenuGroup,
  match: DashboardMenuMatch | null,
  pathname: string,
): "page" | "true" | undefined {
  if (match?.group !== group) return undefined;
  if (group.items.length === 1) return itemAriaCurrent(group.items[0], match, pathname);
  return "true";
}
