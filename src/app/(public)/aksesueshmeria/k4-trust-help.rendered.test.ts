import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// K4 (Kolibër list, Renato 11-14: 2a, 3 ok): the accessibility page, its
// footer link, and the Help answer for a paid book that doesn't show up.
// Help reads the visitor (closing band), so it renders signed out, as in
// trust-pack.rendered.test.ts.
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));

const { default: AccessibilityPage, metadata } = await import("./page");
const { default: HelpPage } = await import("../ndihme/page");
const { SiteFooter } = await import("@/components/site-footer");

const toText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("K4: /aksesueshmeria", () => {
  const html = renderToStaticMarkup(AccessibilityPage());
  const text = toText(html);

  it("is titled Aksesueshmëria", () => {
    expect(metadata.title).toBe("Aksesueshmëria");
    expect(html).toMatch(/<h1[^>]*>Aksesueshmëria<\/h1>/);
  });

  it("says plainly that the site is not yet checked against WCAG 2.2 AA", () => {
    expect(text).toContain("Synojmë standardin WCAG 2.2 në nivelin AA, por faqja nuk është kontrolluar ende e plotë kundrejt tij.");
    expect(text).not.toMatch(/përputhet plotësisht|plotësisht në përputhje/);
  });

  it("gives the support address as a mail link", () => {
    expect(html).toContain('href="mailto:support@librum.al"');
    expect(text).toContain("Tregoni faqen, pajisjen dhe programin që përdorni.");
  });

  it("is linked from the footer", () => {
    expect(renderToStaticMarkup(SiteFooter())).toContain('href="/aksesueshmeria"');
  });
});

describe("K4: Help answer for a paid book that doesn't show up", () => {
  it("sits in Blerja dhe leximi, says not to pay again, and links to the library", async () => {
    const html = renderToStaticMarkup(await HelpPage());
    const text = toText(html);
    const buying = text.slice(text.indexOf("Si ta hap një libër që kam shkarkuar?"), text.indexOf("Cilën deklaratë të të drejtave duhet të zgjedh?"));
    expect(buying).toContain("Pagova, por libri nuk më shfaqet. Çfarë të bëj?");
    expect(buying).toContain("Mos paguani përsëri.");
    expect(buying).toContain("ose jua shtojmë librin, ose jua kthejmë paratë.");
    expect(html).toContain('href="/library"');
    expect(text).toContain("Hapni Bibliotekën time");
  });
});
