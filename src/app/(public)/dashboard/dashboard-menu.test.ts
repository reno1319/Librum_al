import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// FIX STEP F2: the rendered dashboard menu: computer/tablet tabs plus
// the phone "Seksioni" control, only one exposed at a time.
let pathname = "/dashboard";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const { DashboardMenu } = await import("./dashboard-menu");
const { DismissableDetails } = await import("@/components/dismissable-details");

function render(path: string): string {
  pathname = path;
  return renderToStaticMarkup(createElement(DashboardMenu));
}

function findElement(node: ReactNode, type: ReactElement["type"]): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

// The opening <a ...> tag of the first link with this text.
function linkTag(html: string, text: string): string {
  const match = html.match(new RegExp(`<a [^>]*>${text}</a>`));
  expect(match, `link "${text}"`).not.toBeNull();
  return match![0];
}

describe("DashboardMenu", () => {
  it("keeps the Dashboard nav label and only the new group words", () => {
    const html = render("/dashboard");
    expect(html).toMatch(/^<nav aria-label="Paneli i autorit">/);
    for (const word of ["Librat", "Paratë", "Promovimi", "Profili", "Seritë", "Shitjet", "Bilanci", "Paketat", "Zbritjet", "Seksioni"]) {
      expect(html).toContain(word);
    }
    expect(html).not.toContain(">Dashboard<");
  });

  it("each group tab links to its first item", () => {
    const html = render("/dashboard/sales");
    const tabs = html.slice(0, html.indexOf("<details"));
    expect(linkTag(tabs, "Librat")).toContain('href="/dashboard"');
    expect(linkTag(tabs, "Paratë")).toContain('href="/dashboard/sales"');
    expect(linkTag(tabs, "Promovimi")).toContain('href="/dashboard/bundles"');
    expect(linkTag(tabs, "Profili")).toContain('href="/dashboard/profile"');
  });

  it("shows the current group's pages on a second line, current marked", () => {
    const html = render("/dashboard/balance");
    const tabs = html.slice(0, html.indexOf("<details"));
    expect(linkTag(tabs, "Paratë")).toContain('aria-current="true"');
    expect(linkTag(tabs, "Bilanci")).toContain('aria-current="page"');
    expect(linkTag(tabs, "Bilanci")).toContain("font-bold");
    expect(linkTag(tabs, "Shitjet")).not.toContain("aria-current");
    expect(tabs).not.toMatch(/>Payouts</);
    expect(tabs).not.toMatch(/>Zbritjet</);
  });

  // PEN-NAMES-1: Profile now has a second page, Pen names.
  it("shows Profili and Pseudonimet on a second line under Profili", () => {
    const html = render("/dashboard/pen-names");
    const tabs = html.slice(0, html.indexOf("<details"));
    expect(tabs.match(/<ul/g)).toHaveLength(2);
    expect(linkTag(tabs, "Pseudonimet")).toContain('aria-current="page"');
    expect(linkTag(tabs, "Pseudonimet")).toContain('href="/dashboard/pen-names"');
  });

  it("an unknown path marks nothing", () => {
    const html = render("/dashboard/unknown");
    expect(html).not.toContain("aria-current");
    expect(html).toContain("Seksioni</span>");
  });

  it("phone control: Seksioni: current item, groups as labelled lists, not headings", () => {
    const html = render("/dashboard/books/new");
    const phone = html.slice(html.indexOf("<details"));
    expect(phone).toMatch(/^<details class="[^"]*md:hidden/);
    expect(phone).toMatch(/Seksioni:<\/span> <span[^>]*>Librat<\/span>/);
    expect(phone).toMatch(/<span aria-hidden="true"[^>]*>▾<\/span>/);
    expect(phone).toContain("min-h-11");
    expect(phone).toContain("[&amp;::-webkit-details-marker]:hidden");
    expect(phone).not.toMatch(/<h[1-6]/);
    expect(phone).not.toContain("<details open");
    for (let i = 0; i < 4; i++) {
      expect(phone).toContain(`<p id="dashboard-menu-group-${i}"`);
      expect(phone).toContain(`<ul aria-labelledby="dashboard-menu-group-${i}">`);
    }
    expect(linkTag(phone, "Librat")).toContain('aria-current="true"');
    expect(linkTag(phone, "Librat")).toContain('href="/dashboard"');
  });

  it("only one variant is exposed at a time", () => {
    const html = render("/dashboard");
    expect(html).toMatch(/<div class="hidden md:block">/);
    expect(html).toMatch(/<details class="[^"]*\bmd:hidden\b/);
  });

  // LEFTOVERS (L1): the <details> is now rendered by DismissableDetails,
  // which carries the key.
  it("the phone control remounts (closes) on client navigation: keyed by the path", () => {
    pathname = "/dashboard/sales";
    const first = findElement(DashboardMenu(), DismissableDetails);
    pathname = "/dashboard/balance";
    const second = findElement(DashboardMenu(), DismissableDetails);
    expect(first?.key).toBe("/dashboard/sales");
    expect(second?.key).toBe("/dashboard/balance");
  });
});

// AUDIT F2-r1 B1: the open Section list must stay under the site
// header's phone menu panel, which comes earlier in the page.
describe("DashboardMenu stacking", () => {
  it("the Seksioni list's z-index is below the header's mobile panel", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const headerSource = readFileSync(
      fileURLToPath(new URL("../../../components/mobile-nav.tsx", import.meta.url)),
      "utf8",
    );
    const headerZ = Number(headerSource.match(/absolute inset-x-0 top-full z-(\d+)/)?.[1]);
    const listZ = Number(render("/dashboard").match(/<div class="absolute[^"]*\bz-(\d+)\b/)?.[1]);
    expect(headerZ).toBeGreaterThan(0);
    expect(listZ).toBeGreaterThan(0);
    expect(listZ).toBeLessThan(headerZ);
  });
});
