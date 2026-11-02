import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ROYALTY_DISCOUNT_NOTE,
  ROYALTY_HEADLINE_CAPTION,
  ROYALTY_PAID_PRICE_SENTENCE,
  ROYALTY_RULE_SENTENCE,
  ROYALTY_TIERS_LINE,
} from "@/lib/royalty";

// BD2 (Renato 11-01: 1a 2a 4a 5a 6a 7b): the public money wording is
// "Librum sells, the author gets a royalty": 70% from 199 lek, 50% below,
// 99 lek minimum. No "platform fee", no 80/20, no "not launched yet".
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));

const { default: EarningsPage, metadata: earningsMetadata } = await import("./fitimet/page");
const { default: AboutPage } = await import("./rreth-nesh/page");
const { default: HowItWorksPage } = await import("./si-funksionon/page");
const { default: HelpPage } = await import("./ndihme/page");

const toText = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const root = path.join(__dirname, "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const OLD_MONEY = /tarif[ëa] (e )?platform|tarifës së platform|tarifë fikse|80%|20%|komision/i;
const NOT_LAUNCHED = /nuk (janë aktivizuar|kanë nisur|ka nisur) ende|testim,? para nisjes|Librum përfundon sistemet/;

const pages = {
  "/fitimet": async () => toText(renderToStaticMarkup(await EarningsPage())),
  "/rreth-nesh": async () => toText(renderToStaticMarkup(await AboutPage())),
  "/si-funksionon": async () => toText(renderToStaticMarkup(await HowItWorksPage())),
  "/ndihme": async () => toText(renderToStaticMarkup(await HelpPage())),
};

describe("BD2: the public money pages", () => {
  for (const [route, render] of Object.entries(pages)) {
    it(`${route} states the royalty rule and never the old wording`, async () => {
      const text = await render();
      expect(text).toContain(ROYALTY_RULE_SENTENCE);
      expect(text).not.toMatch(OLD_MONEY);
      expect(text).not.toMatch(NOT_LAUNCHED);
    });
  }

  it("/fitimet shows 70% with its caption, the paid-price rule and Librum's share", async () => {
    const text = await pages["/fitimet"]();
    expect(text).toContain("70% Pjesa e autorit " + ROYALTY_HEADLINE_CAPTION);
    expect(text).toContain(ROYALTY_PAID_PRICE_SENTENCE);
    expect(text).toContain("Librum mban pjesën tjetër (30%, ose 50% nën 199 lekë) dhe nuk ju zbret asgjë tjetër.");
    expect(text).toContain("Çmimin e librit e vendosni ju: falas, ose nga 99 deri në 100.000 lekë.");
    expect(text).toContain("Çfarë mbulon pjesa e Librum");
    expect(String(earningsMetadata.description)).not.toMatch(OLD_MONEY);
  });

  it("/fitimet's calculator quotes the 70% tier for its default 990 lek", async () => {
    const text = await pages["/fitimet"]();
    expect(text).toContain("Pjesa e Librum (30%)");
    expect(text).toContain("Honorari i vlerësuar i autorit (70%)");
    expect(text).toContain(ROYALTY_TIERS_LINE);
  });

  it("/si-funksionon also says the paid-price rule", async () => {
    expect(await pages["/si-funksionon"]()).toContain(ROYALTY_PAID_PRICE_SENTENCE);
  });

  it("the home page source uses the shared sentences and no fee constant", () => {
    const home = read("src/app/(public)/page.tsx");
    expect(home).toContain("{ROYALTY_RULE_SENTENCE}");
    expect(home).toContain("{ROYALTY_HEADLINE_CAPTION}");
    expect(home).toContain("`${authorShare}% për autorin, nga ${STANDARD_ROYALTY_FROM_ALL} lekë`");
    expect(home).not.toContain("PLATFORM_FEE_PERCENT");
    expect(home).not.toMatch(NOT_LAUNCHED);
    expect(home).not.toMatch(/tarifë platforme/);
  });
});

describe("BD2: the author dashboard (6a)", () => {
  it("the price step, the edit page and the Discounts page use the royalty lines", () => {
    const wizard = read("src/app/(public)/dashboard/books/new/upload-wizard.tsx");
    const edit = read("src/app/(public)/dashboard/books/[id]/edit/page.tsx");
    const discounts = read("src/app/(public)/dashboard/discounts/page.tsx");
    expect(wizard).toContain("{ROYALTY_TIERS_LINE}");
    expect(wizard).toContain("Pjesa e Librum ({100 - royaltyPercent}%)");
    expect(wizard).toContain("Honorari juaj për çdo shitje ({royaltyPercent}%)");
    expect(edit).toContain("{ROYALTY_TIERS_LINE}");
    expect(discounts).toContain("${ROYALTY_DISCOUNT_NOTE}");
    for (const source of [wizard, edit]) {
      expect(source).not.toContain("PLATFORM_FEE_PERCENT");
      expect(source).not.toMatch(/tarif[ëa] (e )?platform/);
    }
    expect(ROYALTY_DISCOUNT_NOTE).toContain("50%");
  });

  // 7b keeps the CONDITIONAL state messages: they show only while paid
  // publishing is switched off and explain why a paid book can't publish.
  it("keeps the conditional 'paid publishing is off' messages", () => {
    expect(read("src/app/(public)/dashboard/books/new/upload-wizard.tsx")).toContain("readiness.paidPublishingBlocked && (");
    expect(read("src/app/(public)/dashboard/page.tsx")).toContain('attention.kind === "paid-publishing-unavailable" && (');
  });
});
