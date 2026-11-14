import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// K5 (Kolibër list, Renato 11-14): the redesigned Si funksionon page.
vi.mock("next/font/google", () => ({
  Playfair_Display: () => ({ className: "font-hero-letter" }),
  Ultra: () => ({ className: "font-hero-heavy" }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));

const { default: HowItWorksPage } = await import("./page");
const render = async () =>
  renderToStaticMarkup(await HowItWorksPage())
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'");

const root = path.join(__dirname, "..", "..", "..", "..");

describe("K5: Si funksionon", () => {
  it("shows the 70% split with the 499 → 349,30 example and the 50% tier", async () => {
    const html = await render();
    expect(html).toContain("70% nga çdo shitje nga 199 lekë e lart");
    expect(html).toContain(">70%</p>");
    expect(html).toContain("nga 199 lekë");
    expect(html).toContain("50% kur çmimi është nën 199 lekë");
    expect(html).toContain("Për një libër që kushton 499 lekë →");
    expect(html).toContain("ju fitoni 349,30 lekë");
  });

  it("promises the buyer watermark", async () => {
    expect(await render()).toContain(
      "Çdo kopje libri që shkarkohet mban emailin e blerësit, çka lejon gjurmimin e kopjes së shpërndarë.",
    );
  });

  it("says the pre-order email goes only to readers who pressed «Më njofto»", async () => {
    expect(await render()).toContain("Lexuesit që shtypin «Më njofto» marrin një email ditën që libri juaj publikohet.");
  });

  it("signed out: Regjistrohu and Hyr in the hero, own closing band with the author sign-up", async () => {
    const html = await render();
    expect(html).toContain('href="/signup?role=author"');
    expect(html).toContain('href="/login"');
    expect(html).toContain("A jeni gati të botoni?");
    expect(html).not.toContain("Gati për të botuar librin tuaj?");
  });

  it("every photo it uses exists in public/ and is decorative", async () => {
    const html = await render();
    const srcs = [...html.matchAll(/(?:src|href)="(\/images\/si-funksionon\/[^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThanOrEqual(4);
    for (const src of srcs) expect(existsSync(path.join(root, "public", src))).toBe(true);
    expect(html).not.toMatch(/<img(?![^>]*alt="")[^>]*>/);
  });

  it("the hero letter and reader picture are hidden from screen readers", async () => {
    const html = await render();
    expect(html).toMatch(/<span aria-hidden="true" class="font-hero-letter[^"]*"[^>]*>L<\/span>/);
    expect(html).toContain('lang="la"');
  });
});
