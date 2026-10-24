import { describe, expect, it } from "vitest";
import { buildSiteHeaderNav } from "./site-header";

// LAUNCH-1 P2-5: buildSiteHeaderNav is the pure render-state decision
// extracted from SiteHeader, the same "extract a pure decision function,
// unit-test it directly" pattern already used by decideAdminAccess()
// (src/lib/auth.ts) and shouldRedirectForRecovery()/isRecoverySessionActive()
// (src/lib/recovery-session.ts, see that file's own test suite for the
// precedent this mirrors). No React rendering is involved -- this
// codebase has no component-rendering test infrastructure, and none is
// introduced here; SiteHeader itself remains covered indirectly by
// proving its one non-trivial decision is correct.
describe("buildSiteHeaderNav", () => {
  it("logged-out, recovery inactive: ordinary public links, no username, no logout, account link points to /login", () => {
    const nav = buildSiteHeaderNav({
      user: null,
      displayName: null,
      role: null,
      recoveryActive: false,
    });

    expect(nav.primaryLinks.map((l) => l.label)).toEqual([
      "Home",
      "About",
      "How it works",
      "Earnings",
      "Bookstore",
      "Blog",
    ]);
    expect(nav.primaryLinks.some((l) => l.label === "Library")).toBe(false);
    expect(nav.primaryLinks.some((l) => l.label === "Dashboard")).toBe(false);
    expect(nav.headerName).toBeNull();
    expect(nav.showLogout).toBe(false);
    expect(nav.showAccountLink).toBe(true);
    expect(nav.accountHref).toBe("/login");
    expect(nav.accountLabel).toBe("Log in or sign up");
    expect(nav.recoveryLabel).toBeNull();
  });

  it("authenticated reader, recovery inactive: Library present, Dashboard absent, first name shown, Account present, Log out present", () => {
    const nav = buildSiteHeaderNav({
      user: { id: "reader-1" },
      displayName: "Alex Reader",
      role: "reader",
      recoveryActive: false,
    });

    expect(nav.primaryLinks.some((l) => l.href === "/library" && l.label === "Library")).toBe(
      true,
    );
    expect(nav.primaryLinks.some((l) => l.href === "/blog" && l.label === "Blog")).toBe(true);
    expect(nav.primaryLinks.some((l) => l.label === "Dashboard")).toBe(false);
    expect(nav.headerName).not.toBeNull();
    expect(nav.showAccountLink).toBe(true);
    expect(nav.showLogout).toBe(true);
    expect(nav.accountHref).toBe("/account");
    expect(nav.accountLabel).toBe("Account");
    expect(nav.recoveryLabel).toBeNull();
  });

  it("authenticated author, recovery inactive: Dashboard present, Library absent, first name shown, Account present, Log out present", () => {
    const nav = buildSiteHeaderNav({
      user: { id: "author-1" },
      displayName: "Jamie Author",
      role: "author",
      recoveryActive: false,
    });

    expect(
      nav.primaryLinks.some((l) => l.href === "/dashboard" && l.label === "Dashboard"),
    ).toBe(true);
    expect(nav.primaryLinks.some((l) => l.label === "Library")).toBe(false);
    expect(nav.headerName).not.toBeNull();
    expect(nav.showAccountLink).toBe(true);
    expect(nav.showLogout).toBe(true);
    expect(nav.recoveryLabel).toBeNull();
  });

  it("recovery active for an authenticated reader: no Library, no ordinary primary links, no Account, no first name, Log out present, recoveryLabel is exactly 'Password recovery'", () => {
    const nav = buildSiteHeaderNav({
      user: { id: "reader-1" },
      displayName: "Alex Reader",
      role: "reader",
      recoveryActive: true,
    });

    expect(nav.primaryLinks).toEqual([]);
    expect(nav.headerName).toBeNull();
    expect(nav.showAccountLink).toBe(false);
    expect(nav.showLogout).toBe(true);
    expect(nav.recoveryLabel).toBe("Password recovery");
  });

  it("recovery active for an authenticated author: no Dashboard, same recovery-only shape as the reader case", () => {
    const nav = buildSiteHeaderNav({
      user: { id: "author-1" },
      displayName: "Jamie Author",
      role: "author",
      recoveryActive: true,
    });

    expect(nav.primaryLinks).toEqual([]);
    expect(nav.primaryLinks.some((l) => l.label === "Dashboard")).toBe(false);
    expect(nav.headerName).toBeNull();
    expect(nav.showAccountLink).toBe(false);
    expect(nav.showLogout).toBe(true);
    expect(nav.recoveryLabel).toBe("Password recovery");
  });

  it("recovery active overrides user/role state entirely -- even with a fully populated user/profile, ordinary authenticated nav stays suppressed", () => {
    const nav = buildSiteHeaderNav({
      user: { id: "author-1" },
      displayName: "Jamie Author",
      role: "author",
      recoveryActive: true,
    });

    // Not merely "Dashboard is absent" -- primaryLinks is empty entirely,
    // proving the role-based branch never ran at all once recoveryActive
    // is true, not just that its one conditional entry was filtered out.
    expect(nav.primaryLinks).toHaveLength(0);
    expect(nav.headerName).toBeNull();
    expect(nav.showAccountLink).toBe(false);
  });

  it("recovery=false after the marker clears: the ordinary authenticated shape returns for the same user", () => {
    const recovering = buildSiteHeaderNav({
      user: { id: "reader-1" },
      displayName: "Alex Reader",
      role: "reader",
      recoveryActive: true,
    });
    expect(recovering.primaryLinks).toEqual([]);

    const afterRecovery = buildSiteHeaderNav({
      user: { id: "reader-1" },
      displayName: "Alex Reader",
      role: "reader",
      recoveryActive: false,
    });

    expect(afterRecovery.primaryLinks.some((l) => l.label === "Library")).toBe(true);
    expect(afterRecovery.headerName).not.toBeNull();
    expect(afterRecovery.showAccountLink).toBe(true);
    expect(afterRecovery.showLogout).toBe(true);
    expect(afterRecovery.recoveryLabel).toBeNull();
  });
});

// HEADER NAME (Renato 1a 2a 3a): the first name beside the person icon.
describe("buildSiteHeaderNav headerName", () => {
  const base = { role: "author", recoveryActive: false };

  it("is the account name's first word", () => {
    const nav = buildSiteHeaderNav({ ...base, user: { id: "u1", email: "renato@example.com" }, displayName: "Renato Kalemi" });
    expect(nav.headerName).toBe("Renato");
    expect(nav.headerName).not.toBeNull();
  });

  it("is null with no real name, including the email local-part fallback", () => {
    for (const displayName of [null, "", "  ", "nameless+x", "x@y.z"]) {
      const nav = buildSiteHeaderNav({ ...base, user: { id: "u1", email: "nameless+x@example.com" }, displayName });
      expect(nav.headerName).toBeNull();
      expect(nav.headerName).toBeNull();
    }
  });

  it("is null when signed out and during password recovery", () => {
    expect(buildSiteHeaderNav({ ...base, user: null, displayName: "Renato" }).headerName).toBeNull();
    const recovery = buildSiteHeaderNav({ role: "author", recoveryActive: true, user: { id: "u1" }, displayName: "Renato" });
    expect(recovery.headerName).toBeNull();
  });
});

// HEADER NAME: SiteHeader's markup (source guard; this codebase renders
// no server component here): name + icon are one Account link whose
// accessible name starts with the visible "Hello, <name>" (r2), and FIX1's separate
// 1280px-only full name is gone.
describe("SiteHeader name link (source)", () => {
  it("renders the first name inside the Account link and no xl-only name", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./site-header.tsx", import.meta.url)), "utf8");
    expect(source).toContain("aria-label={`Hello, ${nav.headerName}, ${nav.accountLabel}`}");
    expect(source).toContain('<span className="shrink-0 whitespace-pre">Hello, </span>');
    expect(source).toContain('<span className="min-w-0 max-w-[12ch] truncate">{nav.headerName}</span>');
    expect(source).not.toContain("xl:inline");
  });
});
