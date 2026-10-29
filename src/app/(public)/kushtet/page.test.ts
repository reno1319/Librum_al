import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TermsPage, { metadata } from "./page";
import { SELLER_PENDING_TEXT } from "@/lib/seller";
import { POLICY_LAST_UPDATED_LINE } from "@/lib/policy-dates";

// POLICY PAGES (pipeline item 2): new terms, money wording untouched.
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

  it("translates the money sections sentence for sentence (they change only with the live POK build)", () => {
    expect(section(8)).toContain("Pagesat dhe tarifa e platformës");
    expect(section(8)).toContain("{AUTHOR_SHARE_PERCENT}% të shumës së paguar realisht");
    expect(section(8)).toContain("{PLATFORM_FEE_PERCENT}% si tarifë të platformës.");
    expect(section(10)).toContain("ofruesi i pagesave e paguan Librum.");
    expect(section(10)).toContain("ardhurat që autori mbajti realisht nga ai transaksion.");
    expect(section(10)).toContain("Librum mund të rikuperojë nga autori jo më shumë se të");
    expect(text).toContain("Librum ju njofton pa vonesë për pretendimin");
    expect(section(11)).toContain("Konfigurimi i pagesave për autorët nuk është ende i");
  });

  // ALBANIAN-14: the one fact brought up to date (every book is reviewed).
  it("no longer says Librum doesn't check books", () => {
    expect(text).toContain("Librum e shqyrton çdo libër para se të dalë në Librari, por nuk garanton atë që autorët shkruajnë në librat e tyre.");
  });

  it("no longer promises 30 days' notice", () => {
    expect(text).not.toContain("30 ditë para");
  });

  it("takes its date from the one shared line (ALBANIAN-14, 3. b)", () => {
    expect(text).toContain(POLICY_LAST_UPDATED_LINE);
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
