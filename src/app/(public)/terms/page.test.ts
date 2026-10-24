import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TermsPage from "./page";
import { SELLER_PENDING_TEXT } from "@/lib/seller";

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

describe("POLICY PAGES: /terms", () => {
  it("covers seller, age, licence, author promises, cancel right, liability and law", () => {
    for (const phrase of [
      SELLER_PENDING_TEXT,
      "Librum is the seller of every book bought on Librum",
      "You must be at least 16 to make a Librum account.",
      "you get a personal licence to download it and read it on your own devices",
      "You don't buy the book's copyright",
      "you agree to cover Librum's reasonable costs and losses from that claim",
      "You can cancel a purchase for any reason within 14 days of buying it, as long as you haven't downloaded the book yet.",
      "A bundle can be cancelled only if none of its books has been downloaded.",
      "limited to the amount you paid for it",
      "governed by the law of the Republic of Albania, and disputes go to the competent court in Tirana",
      "doesn't take away the protection of the mandatory laws of the country where you live",
      "You must be at least 18 to publish books on Librum or receive author payouts.",
      "When you publish a book, you promise that you are at least 18 and that:",
      "These limits don't apply to money Librum owes an author under Sections 8 and 11, or to a refund owed under Section 9.",
      "If a change reduces your rights, we tell you by email at least 15 days before it applies; other changes apply when they're posted.",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("keeps the money sections as before (they change only with the live POK build)", () => {
    expect(section(8)).toContain("Payments and platform fee");
    expect(section(8)).toContain("author receives {AUTHOR_SHARE_PERCENT}% of the amount actually");
    expect(section(10)).toContain("Librum bears the payment");
    expect(section(10)).toContain("remaining economic proceeds the author actually retained from");
    expect(section(11)).toContain("Author payout setup is not currently available.");
  });

  it("no longer promises 30 days' notice", () => {
    expect(text).not.toContain("30 days before");
  });

  it("is a lawyer-review draft in the code only, with no blank slots", () => {
    expect(source).toContain("LAWYER-REVIEW DRAFT");
    expect(text).not.toMatch(/\bdraft\b|\[/i);
  });
});
