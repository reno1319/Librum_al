import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RefundsPage, { metadata } from "./page";
import { SELLER_PENDING_TEXT } from "@/lib/seller";
import { POLICY_LAST_UPDATED_LINE } from "@/lib/policy-dates";

// REFUND POLICY + POLICY PAGES (Albanian since ALBANIAN-14): the page text is Renato's policy
// (problem refunds with no time limit, reply within 5 working days) plus
// the 14-day cancel right until the first download (10-24, 1. a, 3. a).
const html = renderToStaticMarkup(RefundsPage());
const text = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

const root = path.join(__dirname, "..", "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("REFUND POLICY: /rimbursimet", () => {
  it("is titled Politika e rimbursimit", () => {
    expect(metadata.title).toBe("Politika e rimbursimit");
    expect(html).toMatch(/<h1[^>]*>Politika e rimbursimit<\/h1>/);
  });

  it("states the policy sentence for sentence", () => {
    for (const sentence of [
      "Kjo faqe shpjegon kur mund t'i merrni paratë mbrapsht për një libër elektronik të blerë në Librum.",
      POLICY_LAST_UPDATED_LINE,
      "Mund ta anuloni një blerje për çfarëdo arsye brenda 14 ditëve nga blerja, për sa kohë nuk e keni shkarkuar ende librin.",
      "e humbni këtë të drejtë anulimi kur e shkarkoni për herë të parë.",
      "Një paketë mund të anulohet vetëm nëse asnjë nga librat e saj nuk është shkarkuar.",
      "Në çdo kohë, edhe pasi ta keni shkarkuar librin, jua rimbursojmë blerjen nëse:",
      "libri nuk u shfaq kurrë në bibliotekën tuaj, ose shkarkimi nuk funksionon;",
      "skedari është i dëmtuar ose nuk hapet, dhe nuk mund t'jua rregullojmë;",
      "u tarifuat dy herë për të njëjtin libër, ose u tarifuat me shumë të gabuar;",
      "dikush e bleu me kartën ose me llogarinë tuaj pa lejen tuaj.",
      "Na tregoni sapo ta vini re problemin.",
      "Përveç këtyre problemeve, nuk e rimbursojmë një libër pasi ta keni shkarkuar.",
      'dhe ose "Dua ta anuloj" ose çfarë shkoi keq. Përgjigjemi brenda 5 ditëve të punës.',
      "Nëse anuloni brenda 14 ditëve, jua kthejmë paratë brenda 14 ditëve nga kërkesa juaj.",
      "Ju kthejmë shumën që paguat, zakonisht në kartën me të cilën paguat, përmes ofruesit tonë të pagesave POK. Sa kohë duhet që shuma të shfaqet në pasqyrën tuaj e vendos banka juaj. Aksesi juaj te libri ose paketa e rimbursuar mund të hiqet.",
      "Mund ta kundërshtoni një pagesë edhe te banka juaj. Hapja e një kundërshtimi nuk jua heq aksesin. Nëse banka vendos kundër pagesës, aksesi juaj te ai libër mund të hiqet.",
      SELLER_PENDING_TEXT,
      "Keni pyetje për këtë politikë? Na shkruani te support@librum.al .",
    ]) {
      expect(text).toContain(sentence);
    }
    expect(html).toContain('href="mailto:support@librum.al"');
    expect(html).toContain('href="/kushtet"');
  });

  it("no longer refuses every refund after delivery, and shows no blank slots", () => {
    for (const absent of ["Request refund", "Kërkoni rimbursim", "[", "NIPT:"]) {
      expect(text).not.toContain(absent);
    }
  });

  it("is marked as a lawyer-review draft in the code only", () => {
    expect(read("src/app/(public)/rimbursimet/page.tsx")).toContain("LAWYER-REVIEW DRAFT");
    expect(text).not.toMatch(/\bdraft\b|lawyer/i);
  });

  it("has no English left in the page text", () => {
    for (const english of ["Refund Policy", "Last updated", "Cancel within", "How to ask", "Contact"]) {
      expect(text).not.toContain(english);
    }
  });
});

describe("REFUND POLICY: Terms section 9 links the policy", () => {
  it("keeps the money paragraph and links the policy", () => {
    const source = read("src/app/(public)/kushtet/page.tsx");
    const section9 = source.match(/<section id="section-9"[\s\S]*?<\/section>/)![0];
    expect(section9).toContain("honorari përkatës i autorit anulohet");
    expect(section9).toContain('<Link href="/rimbursimet" className="text-primary underline">');
    expect(section9).toContain("Politikën e rimbursimit");
  });
});
