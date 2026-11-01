import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage, { metadata } from "./page";
import { SELLER_PENDING_TEXT } from "@/lib/seller";
import { POLICY_LAST_UPDATED_LINE, PRIVACY_LAST_UPDATED_LINE } from "@/lib/policy-dates";

// POLICY PAGES (pipeline item 2): Law 124/2024 notice.
const html = renderToStaticMarkup(PrivacyPage());
const text = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("POLICY PAGES: /privatesia", () => {
  it("is titled Politika e privatësisë", () => {
    expect(metadata.title).toBe("Politika e privatësisë");
    expect(html).toMatch(/<h1[^>]*>Politika e privatësisë<\/h1>/);
  });

  it("names the controller, the law and the complaint authority", () => {
    expect(text).toContain("Ligjit nr. 124/2024");
    expect(text).toContain(SELLER_PENDING_TEXT);
    expect(text).toContain("Komisioneri për të Drejtën e Informimit dhe Mbrojtjen e të Dhënave Personale");
    expect(html).toContain('href="https://idp.al"');
  });

  it("covers legal bases, processors, transfers, retention, rights and age", () => {
    for (const phrase of [
      "zbatimi i kontratës sonë me ju",
      "Për të përmbushur detyrimet ligjore",
      "Për interesat tona të ligjshme",
      "Supabase",
      "Vercel",
      "Resend",
      "POK",
      "Cloudflare — përcjellja e emaileve të dërguara te support@librum.al.",
      "Google (Gmail) — kutia postare ku lexojmë emailet tuaja dhe u përgjigjemi.",
      "Për të publikuar libra ose për të marrë pagesa si autor, duhet të jeni të paktën 18 vjeç.",
      "klauzolat standarde kontraktuale",
      "10 vjet",
      "IBAN",
      "Përgjigjemi brenda një muaji.",
      "të paktën 16 vjeç",
      "brenda 72 orëve",
      "Nuk i shesim të dhënat tuaja.",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  // ALBANIAN-14: what the site stores, brought up to date.
  it("says free-book downloads and the file version are logged (DOWNLOADS-1 audit note A)", () => {
    expect(text).toContain(
      "një regjistrim për çdo herë që shkarkoni një libër që keni blerë ose marrë falas (data, ora dhe cili version i skedarit u shkarkua).",
    );
  });

  it("names the Terms record and the 18+ confirmation, with their dates", () => {
    expect(text).toContain("Ruajmë edhe datën kur pranuat Kushtet e përdorimit dhe cilin version të tyre pranuat");
    expect(text).toContain("datën kur konfirmuat se jeni 18 vjeç ose më shumë");
  });

  it("describes bank details without promising that payouts are live", () => {
    expect(text).toContain("i ruajmë për t'i përdorur kur të nisin këto pagesa.");
  });

  it("names the emails about new books from followed authors", () => {
    expect(text).toContain("si dhe për librat e rinj të autorëve që ndiqni.");
    expect(text).toContain("Nuk dërgojmë emaile marketingu");
  });

  it("no longer mentions Stripe (STRIPE REMOVAL, item 10, 5. a)", () => {
    expect(text).not.toMatch(/stripe/i);
  });

  it("explains the cookieless visit counts (VISITOR STATS, item 6, 3. a)", () => {
    expect(text).toContain(
      "Vizitat e faqeve i numërojmë me Vercel Web Analytics. Ky shërbim nuk përdor cookies, nuk ju ndjek në faqe të tjera interneti dhe nuk na tregon kush jeni.",
    );
    expect(text).toContain("Vercel — hostimi i faqes dhe numërimi anonim i vizitave.");
    expect(text).toContain("Nuk përdorim cookies për reklama ose për gjurmim.");
  });

  // BD4 (D13 1b): the visible first page with the buyer's email.
  it("says the email, purchase date and code show on the book's first page, and that a shared copy shows it", () => {
    expect(text).toContain(
      "Librum shton në faqen e parë të librit adresën e emailit të llogarisë së tij, datën e blerjes dhe kodin e blerjes",
    );
    expect(text).toContain("nëse e jepni kopjen tuaj dikujt tjetër, ai e sheh emailin tuaj.");
  });

  // BD4 (Renato 1 Nov, 3. a): Privacy has its own date; Terms and
  // Refunds keep the shared one.
  it("takes its date from its own Privacy line, not the shared Terms/Refunds line", () => {
    expect(text).toContain(PRIVACY_LAST_UPDATED_LINE);
    expect(source).toContain("{PRIVACY_LAST_UPDATED_LINE}");
    expect(source).not.toContain("POLICY_LAST_UPDATED_LINE");
    expect(POLICY_LAST_UPDATED_LINE).toBe("Përditësuar më: 30 tetor 2026");
  });

  it("is a lawyer-review draft in the code only, with no blank slots", () => {
    expect(source).toContain("LAWYER-REVIEW DRAFT");
    expect(text).not.toMatch(/\bdraft\b|\[/i);
  });

  it("has no English left in the page text", () => {
    for (const english of ["Privacy Policy", "Last updated", "What we collect", "Your rights", "Who we share"]) {
      expect(text).not.toContain(english);
    }
  });
});
