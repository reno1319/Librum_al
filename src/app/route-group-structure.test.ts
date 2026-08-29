import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { ADMIN_LOGIN_PATH } from "@/lib/admin-safe-redirect";

// ADMIN-1A.5 FINAL PRE-COMMIT ADMIN LAYOUT CORRECTION: structural
// regression guards for the SiteHeader/SiteFooter split between the
// public route group (src/app/(public)/) and everything outside it
// (currently just src/app/admin/**). Source-level scans, not a render
// harness -- same established technique as src/app/error.test.ts and
// src/app/global-error.test.ts (this repo runs vitest in a plain node
// environment with no jsdom/RTL; see those files' own comments).
const appDir = path.join(__dirname);

function read(relativePath: string): string {
  return readFileSync(path.join(appDir, relativePath), "utf8");
}

// Scoped to actual imports/JSX usage, not any mention of the word --
// several of these same files' own comments reference "SiteHeader"/
// "SiteFooter" by name while explaining why they're deliberately absent,
// which a bare substring/word match would misfire on.
function assertNoSiteChrome(source: string): void {
  expect(source).not.toMatch(/from\s*"@\/components\/site-header"/);
  expect(source).not.toMatch(/from\s*"@\/components\/site-footer"/);
  expect(source).not.toMatch(/<SiteHeader\b/);
  expect(source).not.toMatch(/<SiteFooter\b/);
}

describe("Route group structure: public chrome stays out of /admin/*", () => {
  it("the true root layout no longer imports or renders SiteHeader/SiteFooter", () => {
    assertNoSiteChrome(read("layout.tsx"));
  });

  it("the (public) route group's own layout renders both SiteHeader and SiteFooter", () => {
    const source = read("(public)/layout.tsx");
    expect(source).toMatch(/import\s*\{\s*SiteHeader\s*\}\s*from\s*"@\/components\/site-header"/);
    expect(source).toMatch(/import\s*\{\s*SiteFooter\s*\}\s*from\s*"@\/components\/site-footer"/);
    expect(source).toMatch(/<SiteHeader\s*\/>/);
    expect(source).toMatch(/<SiteFooter\s*\/>/);
  });

  it("admin/layout.tsx never imports or renders SiteHeader/SiteFooter", () => {
    assertNoSiteChrome(read("admin/layout.tsx"));
  });

  it("admin/(protected)/layout.tsx never imports or renders SiteHeader/SiteFooter", () => {
    assertNoSiteChrome(read("admin/(protected)/layout.tsx"));
  });

  it("AdminShell never imports or renders SiteHeader/SiteFooter", () => {
    assertNoSiteChrome(read("admin/admin-shell.tsx"));
  });

  it("admin/login/page.tsx never imports or renders SiteHeader/SiteFooter", () => {
    assertNoSiteChrome(read("admin/login/page.tsx"));
  });
});

describe("Route group structure: public routes actually moved, none left behind or duplicated", () => {
  // A representative sample, not an exhaustive list of every one of the
  // ~25 moved folders -- enough to prove the move pattern held (existing
  // page present under (public)/, old ungrouped location gone) without
  // this test itself becoming a second place that has to be kept in
  // sync with every future public route addition.
  const sampleRoutes = [
    "page.tsx",
    "login/page.tsx",
    "dashboard/page.tsx",
    "books/[id]/page.tsx",
    "account/page.tsx",
  ];

  for (const route of sampleRoutes) {
    it(`${route}: present under (public)/, no stray copy at the old ungrouped location`, () => {
      expect(existsSync(path.join(appDir, "(public)", route))).toBe(true);
      expect(existsSync(path.join(appDir, route))).toBe(false);
    });
  }

  it("admin/ was never moved into (public) -- it stays a real top-level segment", () => {
    expect(existsSync(path.join(appDir, "admin", "layout.tsx"))).toBe(true);
    expect(existsSync(path.join(appDir, "(public)", "admin"))).toBe(false);
  });

  it("URL path is unaffected by the group -- links to a moved route still use its ordinary URL, not the (public) folder name", () => {
    // A route group is invisible in the URL by definition (Next.js's
    // own convention -- see route-groups.md), so any code that LINKS to
    // a moved route (as opposed to importing a sibling module from it,
    // which correctly DOES need "(public)" in the import path -- see
    // the very next line below) should never need to know it moved.
    // Spot-checked against SiteHeader's own account/login href, which
    // still reads as the plain "/login" URL confirmed in the build's
    // own route manifest (this pass's own report), never
    // "/(public)/login".
    const siteHeader = readFileSync(
      path.join(appDir, "..", "components", "site-header.tsx"),
      "utf8",
    );
    expect(siteHeader).toMatch(/from\s*"@\/app\/\(public\)\/auth\/actions"/);
    expect(siteHeader).toMatch(/accountHref\s*=\s*user\s*\?\s*"\/account"\s*:\s*"\/login"/);
  });
});

describe("Route group structure: admin/(protected) boundary (FINAL ROUTING INVARIANT CORRECTION)", () => {
  it("admin/login/page.tsx exists outside (protected) -- not nested under admin/(protected)/login", () => {
    expect(existsSync(path.join(appDir, "admin", "login", "page.tsx"))).toBe(true);
    expect(existsSync(path.join(appDir, "admin", "(protected)", "login"))).toBe(false);
  });

  it("every operational admin page lives under admin/(protected)/, not directly under admin/", () => {
    const protectedRoutes = [
      "page.tsx",
      "reports/page.tsx",
      "reports/[id]/page.tsx",
      "refunds/page.tsx",
      "refunds/[id]/page.tsx",
      "not-found.tsx",
    ];
    for (const route of protectedRoutes) {
      expect(existsSync(path.join(appDir, "admin", "(protected)", route))).toBe(true);
      expect(existsSync(path.join(appDir, "admin", route))).toBe(false);
    }
  });

  it("admin/(protected)/layout.tsx calls requireStaff with the admin.access permission", () => {
    const source = read("admin/(protected)/layout.tsx");
    expect(source).toMatch(/import\s*\{\s*requireStaff\s*\}\s*from\s*"@\/lib\/staff"/);
    expect(source).toMatch(/requireStaff\("admin\.access"\)/);
  });

  it("admin/(protected)/layout.tsx renders AdminShell", () => {
    const source = read("admin/(protected)/layout.tsx");
    expect(source).toMatch(/import\s*\{\s*AdminShell\s*\}\s*from\s*"\.\.\/admin-shell"/);
    expect(source).toMatch(/<AdminShell\b/);
  });

  it("admin root layout.tsx contains no pathname-based authorization exception -- the old bypass mechanism is fully removed", () => {
    // Scoped to actual imports/calls, not bare word mentions -- this
    // file's own comment legitimately names all of these while
    // documenting why they were removed. See src/app/admin/layout.test.ts
    // for the identical, more granular version of this same check.
    const source = read("admin/layout.tsx");
    expect(source).not.toMatch(/import\s*\{[^}]*ADMIN_LOGIN_PATH[^}]*\}/);
    expect(source).not.toMatch(/import\s*\{[^}]*INTERNAL_PATHNAME_HEADER[^}]*\}/);
    expect(source).not.toMatch(/requireStaff\(/);
    expect(source).not.toMatch(/<AdminShell\b/);
  });
});

describe("Route group structure: no redirect loop between requireStaff() and /admin/login", () => {
  it("ADMIN_LOGIN_PATH remains the shared redirect-target constant for staff.ts and staffLogin(), but is no longer needed as a layout authorization exception", () => {
    const staffSource = readFileSync(path.join(appDir, "..", "lib", "staff.ts"), "utf8");
    const actionsSource = read("admin/login/actions.ts");
    const rootLayoutSource = read("admin/layout.tsx");
    const protectedLayoutSource = read("admin/(protected)/layout.tsx");

    // Still legitimately used as a redirect TARGET.
    for (const source of [staffSource, actionsSource]) {
      expect(source).toMatch(
        /import\s*\{[^}]*ADMIN_LOGIN_PATH[^}]*\}\s*from\s*"@\/lib\/admin-safe-redirect"/,
      );
    }

    // No longer IMPORTED (and so cannot be used as a comparison)
    // anywhere in either layout -- the boundary is now which directory
    // a file lives in, not a runtime string check against this
    // constant. (admin/layout.tsx's own comment legitimately names
    // ADMIN_LOGIN_PATH in prose while documenting its removal, so this
    // checks for an import specifically, not a bare mention.)
    expect(rootLayoutSource).not.toMatch(/import\s*\{[^}]*ADMIN_LOGIN_PATH[^}]*\}/);
    expect(protectedLayoutSource).not.toMatch(/import\s*\{[^}]*ADMIN_LOGIN_PATH[^}]*\}/);

    expect(ADMIN_LOGIN_PATH).toBe("/admin/login");
  });

  it("structural proof: requireStaff() only runs for requests already inside admin/(protected)/, which /admin/login is not a part of", () => {
    // admin/(protected)/layout.tsx is the only place requireStaff() is
    // called at the layout level (individual (protected) pages also
    // call it themselves -- unchanged, harmless redundancy -- but never
    // admin/login/**). Since admin/login/page.tsx is a sibling
    // directory, not a descendant of admin/(protected)/, no request to
    // /admin/login ever passes through admin/(protected)/layout.tsx, so
    // requireStaff() never runs for it, so it can never redirect an
    // /admin/login visitor back to /admin/login. This is a fact about
    // the file tree, not a runtime branch that could be wrong.
    const loginPageSource = read("admin/login/page.tsx");
    const loginActionsSource = read("admin/login/actions.ts");
    // Neither file CALLS requireStaff() -- page.tsx's own comment
    // legitimately mentions it by name while explaining that it's NOT
    // this page's security boundary, so the check below is scoped to an
    // actual call/import, not a bare word match.
    expect(loginPageSource).not.toMatch(/import\s*\{[^}]*requireStaff[^}]*\}/);
    expect(loginPageSource).not.toMatch(/requireStaff\(/);
    expect(loginActionsSource).not.toMatch(/requireStaff/);
  });
});
