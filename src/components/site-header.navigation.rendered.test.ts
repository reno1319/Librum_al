import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// HEADER FIX (Renato 11-27, hd1 a): the (public) layout draws SiteHeader
// once and keeps it while you move between pages, so the header must
// follow the browser's current path, not the page you arrived on.
// Here the SAME header element (as the layout keeps it) is drawn again
// after the path changes, as a move between pages does.
let pathname: string | null = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: () => ({}),
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/recovery-session", () => ({ isRecoverySessionActive: () => false }));
vi.mock("@/app/(public)/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/components/nav-links", () => ({ NavLinks: () => null }));
vi.mock("@/components/mobile-nav", () => ({ MobileNav: () => "MENU-BUTTON" }));
vi.mock("@/components/feedback-button", () => ({ FeedbackButton: () => null }));

const { SiteHeader } = await import("./site-header");

const SHOP = 'role="search"';
const MENU = "MENU-BUTTON";

function headerCount(html: string): number {
  return html.match(/<header\b/g)?.length ?? 0;
}

describe("SiteHeader follows the page you move to", () => {
  let header: ReactElement;
  beforeEach(async () => {
    pathname = "/";
    header = (await SiteHeader()) as ReactElement;
  });

  it("homepage, then Libraria (a tap on the Libraria link): shop header, no menu", () => {
    const home = renderToStaticMarkup(header);
    expect(home).toContain(MENU);
    expect(home).not.toContain(SHOP);
    pathname = "/librari";
    const libraria = renderToStaticMarkup(header);
    expect(libraria).toContain(SHOP);
    expect(libraria).not.toContain(MENU);
    expect(headerCount(libraria)).toBe(1);
  });

  it("Libraria, then the homepage (a tap on the logo) and the Blog: normal header with the menu", () => {
    pathname = "/librari";
    expect(renderToStaticMarkup(header)).toContain(SHOP);
    for (const next of ["/", "/blog"]) {
      pathname = next;
      const html = renderToStaticMarkup(header);
      expect(html).toContain(MENU);
      expect(html).not.toContain(SHOP);
      expect(headerCount(html)).toBe(1);
    }
  });

  it("Libraria's picks page gets the shop header too", () => {
    pathname = "/librari/cfare-po-lexojme";
    const html = renderToStaticMarkup(header);
    expect(html).toContain(SHOP);
    expect(html).not.toContain(MENU);
  });
});
