import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROYALTY_PAID_PRICE_SENTENCE } from "@/lib/royalty";
import { EARNINGS_BEFORE_TAX_NOTE } from "@/lib/earnings-calculator";

// Fitimet redesign (Renato 11-14, picks 1-6 all a, then "d a"): photo-filled
// "%" in the heavy font, income list, 70/50 big numbers, an example table
// above the live calculator, the before-tax line, and the shared band.
vi.mock("next/font/google", () => ({
  Playfair_Display: () => ({ className: "font-hero-letter" }),
  Ultra: () => ({ className: "font-hero-heavy" }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));

const { default: EarningsPage } = await import("./page");

const toText = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("Fitimet redesign", async () => {
  const html = renderToStaticMarkup(await EarningsPage());
  const text = toText(html);

  it("fills a heavy-font % with the hero photo, hidden from screen readers", () => {
    expect(html).toMatch(/<span aria-hidden="true" class="font-hero-heavy [^"]*"[^>]*\/images\/fitimet\/hero\.jpg[^>]*>%<\/span>/);
    expect(html).not.toContain("font-hero-letter");
  });

  it("puts the income list beside the decorative income photo", () => {
    expect(html).toContain('src="/images/fitimet/income.jpg" alt="" aria-hidden="true"');
    expect(text).toContain("Më shumë mënyra për të fituar");
    expect(text).toContain("Shisni librat tuaj edhe në paketa : honorari llogaritet nga çmimi i paketës.");
  });

  it("only promises the «Më njofto» email for pre-orders, not early sales", () => {
    expect(text).toContain("lexuesit që shtypin «Më njofto» marrin një email ditën që libri publikohet.");
    expect(text).not.toMatch(/shisni para (daljes|publikimit)|paguajnë para/i);
  });

  it("shows exact earnings for 99, 199 and 499 lekë", () => {
    expect(text).toContain("Libër 99 lekë Libër 199 lekë Libër 499 lekë");
    expect(text).toContain("Honorari 50% 70% 70%");
    expect(text).toContain("Fitimi juaj 49,50 lekë për shitje 139,30 lekë për shitje 349,30 lekë për shitje");
  });

  it("says under the table that the amounts are before taxes, as the calculator does", () => {
    expect(text).toContain(`${ROYALTY_PAID_PRICE_SENTENCE} ${EARNINGS_BEFORE_TAX_NOTE}`);
    expect(text.split(EARNINGS_BEFORE_TAX_NOTE).length - 1).toBe(2);
  });

  it("keeps payouts unpromised and ends with the shared closing band", () => {
    expect(text).toContain("Librum do ta publikojë këtu mënyrën dhe kohën e pagesave për autorët para pagesës së parë.");
    expect(text).not.toMatch(/\bPOK\b/);
    expect(text).toContain("A jeni gati të botoni?");
  });
});
