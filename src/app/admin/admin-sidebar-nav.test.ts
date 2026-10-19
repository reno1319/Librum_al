import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveVisibleAdminNavGroups } from "./admin-nav";
import type { StaffRole } from "@/lib/types";

// ADMIN-1 (A2 look): the desktop sidebar, rendered to static HTML (no
// DOM in vitest's node environment).
let pathname = "/admin";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const { AdminSidebarNav } = await import("./admin-sidebar-nav");

function render(role: StaffRole, at: string): string {
  pathname = at;
  return renderToStaticMarkup(createElement(AdminSidebarNav, { groups: resolveVisibleAdminNavGroups(role) }));
}

function anchor(html: string, href: string): string {
  return html.match(new RegExp(`<a [^>]*href="${href.replace(/\//g, "\\/")}"[^>]*>`))?.[0] ?? "";
}

function classOf(tag: string): string[] {
  return (tag.match(/class="([^"]+)"/)?.[1] ?? "").split(" ");
}

describe("AdminSidebarNav", () => {
  it("shows a gold uppercase eyebrow per group (darkened gold, never brass text on white)", () => {
    const html = render("owner", "/admin");
    for (const label of ["Daily", "Catalog", "Money", "Team"]) {
      expect(html).toMatch(new RegExp(`class="[^"]*text-\\[#806510\\][^"]*uppercase[^"]*">${label}<`));
    }
    expect(html).not.toContain("text-accent");
  });

  it("the current page is a filled dark-green row; others are not", () => {
    const html = render("owner", "/admin/refunds/r-1");
    const current = anchor(html, "/admin/refunds");
    expect(current).toContain('aria-current="page"');
    expect(classOf(current)).toEqual(expect.arrayContaining(["bg-primary", "text-primary-foreground"]));
    expect(classOf(anchor(html, "/admin"))).not.toContain("bg-primary");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("hides groups with nothing visible for the role", () => {
    const html = render("moderator", "/admin");
    expect(html).toContain(">Daily<");
    for (const label of ["Catalog", "Money", "Team"]) expect(html).not.toContain(`>${label}<`);
  });

  it("every link is at least 44px tall", () => {
    const html = render("owner", "/admin");
    for (const m of html.matchAll(/<a [^>]*class="([^"]+)"/g)) {
      expect(m[1].split(" ")).toContain("min-h-11");
    }
  });
});
