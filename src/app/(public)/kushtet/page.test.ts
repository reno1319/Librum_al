import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TermsPage, { metadata } from "./page";
import { SELLER_PENDING_TEXT } from "@/lib/seller";
import { TERMS_LAST_UPDATED_LINE } from "@/lib/policy-dates";

// POLICY PAGES (pipeline item 2): new terms. BD2: the money wording.
const html = renderToStaticMarkup(TermsPage());
const text = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const section = (n: number) =>
  source.match(new RegExp(`<section id="section-${n}"[\\s\\S]*?</section>`))![0];

describe("POLICY PAGES: /kushtet", () => {
  it("is titled Kushtet e përdorimit", () => {
    expect(metadata.title).toBe("Kushtet e përdorimit");
    expect(html).toMatch(/<h1[^>]*>Kushtet e përdorimit<\/h1>/);
  });

  it("covers seller, age, licence, author promises, cancel right, liability and law", () => {
    for (const phrase of [
      SELLER_PENDING_TEXT,
      "Librum është shitësi i çdo libri që blihet në Librum",
      "Duhet të jeni të paktën 16 vjeç për të krijuar një llogari në Librum.",
      "merrni një licencë personale për ta shkarkuar dhe për ta lexuar në pajisjet tuaja",
      "Nuk blini të drejtën e autorit të librit",
      "ju pranoni të mbuloni kostot dhe humbjet e arsyeshme të Librum nga ai pretendim",
      "Mund ta anuloni një blerje për çfarëdo arsye brenda 14 ditëve nga blerja, për sa kohë nuk e keni shkarkuar ende librin.",
      "Një paketë mund të anulohet vetëm nëse asnjë nga librat e saj nuk është shkarkuar.",
      "kufizohet në shumën që paguat për të",
      "rregullohen nga ligji i Republikës së Shqipërisë, dhe mosmarrëveshjet shqyrtohen nga gjykata kompetente në Tiranë",
      "kjo nuk ju heq mbrojtjen e ligjeve të detyrueshme të vendit ku jetoni",
      "Duhet të jeni të paktën 18 vjeç për të publikuar libra në Librum ose për të marrë pagesa si autor.",
      "Kur publikoni një libër, ju premtoni se jeni të paktën 18 vjeç dhe se:",
      "Këto kufizime nuk vlejnë për paratë që Librum i detyrohet një autori sipas Seksioneve 8 dhe 11, ose për një rimbursim të detyruar sipas Seksionit 9.",
      "Nëse një ndryshim jua pakëson të drejtat, ju njoftojmë me email të paktën 15 ditë para se të hyjë në fuqi; ndryshimet e tjera hyjnë në fuqi kur publikohen.",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  // BD2 (Renato 11-01: 2a, 5a, 7b): seller + royalty, 70% from 199 lek,
  // 50% below, on the amount actually paid; no "not launched yet".
  it("says Librum sells and pays a 70%/50% royalty on the amount actually paid", () => {
    expect(text).toContain("Librum ua shet lexuesve, në emrin e vet, librat elektronikë që autorët e pavarur publikojnë në Librum, dhe për çdo shitje i paguan autorit një honorar, siç përshkruhet në Seksionin 8.");
    expect(text).toContain("Për çdo shitje të përfunduar, Librum i paguan autorit një honorar prej 70% të shumës së paguar realisht, kur kjo shumë është 199 lekë ose më shumë, dhe 50% kur është nën 199 lekë.");
    expect(text).toContain("Shuma e paguar realisht është ajo pasi zbatohet çdo kod zbritjeje; për një paketë vlen çmimi i paketës. Pjesa tjetër i mbetet Librum.");
    expect(section(8)).toContain("Pagesat dhe honorari i autorit");
    expect(text).toContain("honorari përkatës i autorit anulohet, dhe rimbursohet edhe pjesa përkatëse e Librum.");
    expect(text).toContain("Librum mund të rikuperojë nga autori jo më shumë se honorarin që autori mbajti realisht nga ai transaksion.");
    expect(section(10)).toContain("ofruesi i pagesave e paguan Librum.");
    expect(text).toContain("Librum ju njofton pa vonesë për pretendimin");
    expect(text).toContain("Librum do ta publikojë mënyrën dhe kohën e pagesave për autorët para pagesës së parë të honorarit.");
  });

  it("no longer says platform fee, 80/20, or not launched yet", () => {
    expect(text).not.toMatch(/tarif[ëa] (e )?platform|tarifës së platform|80%|20%/);
    expect(text).not.toMatch(/nuk kanë nisur|nuk është ende i disponueshëm|testim para nisjes/);
    expect(source).not.toContain("PLATFORM_FEE_PERCENT");
  });

  // ALBANIAN-14: the one fact brought up to date (every book is reviewed).
  it("no longer says Librum doesn't check books", () => {
    expect(text).toContain("Librum e shqyrton çdo libër para se të dalë në Librari, por nuk garanton atë që autorët shkruajnë në librat e tyre.");
  });

  it("no longer promises 30 days' notice", () => {
    expect(text).not.toContain("30 ditë para");
  });

  // BD2 (3a): the Terms have their own date; Refunds keep the shared one.
  it("takes its date from its own line (BD2, 3. a)", () => {
    expect(text).toContain(TERMS_LAST_UPDATED_LINE);
    // BD7 sets the Production release day; until then the build day.
    expect(TERMS_LAST_UPDATED_LINE).toBe("Përditësuar më: 2 nëntor 2026");
    expect(source).not.toContain("POLICY_LAST_UPDATED_LINE");
  });

  it("is a lawyer-review draft in the code only, with no blank slots", () => {
    expect(source).toContain("LAWYER-REVIEW DRAFT");
    expect(text).not.toMatch(/\bdraft\b|\[/i);
  });

  it("has no English left in the page text", () => {
    for (const english of ["Terms of Service", "Last updated", "Contents", "Section", "Librum's role"]) {
      expect(text).not.toContain(english);
    }
  });
});
