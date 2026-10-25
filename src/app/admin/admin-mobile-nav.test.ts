import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import path from "path";
import { resolveVisibleAdminNavGroups } from "./admin-nav";
import type { StaffRole } from "@/lib/types";

// ADMIN-1 (A2 look): the phone "Section ▾" control. vitest runs in
// `node` with no DOM, so the component is rendered to static HTML (the
// same HTML a phone gets before JavaScript loads) and asserted on that.
// The outside-tap and Escape closing is DismissableDetails' own
// attachDismiss, tested in src/components/dismissable-details.test.ts.
let pathname = "/admin";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const { AdminMobileNav } = await import("./admin-mobile-nav");

function render(role: StaffRole, at: string): string {
  pathname = at;
  return renderToStaticMarkup(
    createElement(AdminMobileNav, { groups: resolveVisibleAdminNavGroups(role), logoutAction: vi.fn() }),
  );
}

function anchor(html: string, href: string): string {
  return html.match(new RegExp(`<a [^>]*href="${href.replace(/\//g, "\\/")}"[^>]*>`))?.[0] ?? "";
}

describe("AdminMobileNav (phone Section control)", () => {
  it("is a closed native <details> without JavaScript, hidden from md up", () => {
    const html = render("owner", "/admin");
    expect(html).toMatch(/<nav aria-label="Admin" class="md:hidden">/);
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("<summary");
  });

  it("names the current page in the summary", () => {
    expect(render("owner", "/admin")).toMatch(/Section:<\/span> <span class="font-bold text-primary">Today<\/span>/);
    expect(render("owner", "/admin/reports/abc")).toMatch(/<span class="font-bold text-primary">Book reports<\/span>/);
  });

  it("lists the owner's groups in order, with every page", () => {
    const html = render("owner", "/admin");
    const order = ["Daily", "Today", "Book reports", "Refund requests", "Catalog", "Featured picks", "Blog", "Money", "Finance", "Team", "Staff", "Audit log", "Log out"];
    let last = -1;
    for (const text of order) {
      const at = html.indexOf(`>${text}<`, last + 1);
      expect(at, text).toBeGreaterThan(last);
      last = at;
    }
  });

  it("editor: Daily (Today) and Catalog (Blog) only, then Log out", () => {
    const html = render("editor", "/admin/blog");
    expect(html).toContain(">Daily<");
    expect(html).toContain(">Catalog<");
    expect(html).not.toContain(">Money<");
    expect(html).not.toContain(">Team<");
    expect(html).not.toContain(">Featured picks<");
    expect(anchor(html, "/admin/blog")).toContain('aria-current="page"');
    expect(html).toContain(">Log out<");
  });

  it("moderator and support see only their own queue", () => {
    const moderator = render("moderator", "/admin");
    expect(moderator).toContain('href="/admin/reports"');
    expect(moderator).not.toContain('href="/admin/refunds"');
    const support = render("support", "/admin");
    expect(support).toContain('href="/admin/refunds"');
    expect(support).not.toContain('href="/admin/reports"');
  });

  it("marks exactly one current page", () => {
    const html = render("owner", "/admin/audit");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(anchor(html, "/admin/audit")).toContain('aria-current="page"');
  });

  it("keeps Log out reachable as a form submit", () => {
    const html = render("support", "/admin");
    expect(html).toMatch(/<form[^>]*>\s*<button type="submit"[^>]*>Log out<\/button><\/form>/);
  });

  it("touch targets are at least 44px and the text is 16px", () => {
    const html = render("owner", "/admin");
    const summary = html.match(/<summary class="([^"]+)"/)?.[1] ?? "";
    expect(summary.split(" ")).toEqual(expect.arrayContaining(["min-h-12", "text-base"]));
    const linkClasses = [...html.matchAll(/<a [^>]*class="([^"]+)"/g)].map((m) => m[1]);
    expect(linkClasses.length).toBeGreaterThan(0);
    for (const cls of linkClasses) {
      expect(cls.split(" ")).toEqual(expect.arrayContaining(["min-h-11", "text-base"]));
    }
  });

  it("remounts on navigation so the menu is closed on the new page (source guard)", () => {
    const source = readFileSync(path.join(__dirname, "admin-mobile-nav.tsx"), "utf8");
    expect(source).toMatch(/<DismissableDetails key=\{pathname\}/);
    expect(source).toContain('from "@/components/dismissable-details"');
    expect(source).not.toMatch(/from\s+"[^"]*dashboard-menu/);
  });
});
