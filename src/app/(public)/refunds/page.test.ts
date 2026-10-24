import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RefundsPage, { metadata } from "./page";
import { SELLER_PENDING_TEXT } from "@/lib/seller";

// REFUND POLICY + POLICY PAGES: the page text is Renato's policy
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

describe("REFUND POLICY: /refunds", () => {
  it("is titled Refund Policy", () => {
    expect(metadata.title).toBe("Refund Policy");
    expect(html).toMatch(/<h1[^>]*>Refund Policy<\/h1>/);
  });

  it("states the policy word for word", () => {
    for (const sentence of [
      "This page explains when you can get your money back for an ebook bought on Librum.",
      "Last updated: October 2026",
      "You can cancel a purchase for any reason within 14 days of buying it, as long as you haven't downloaded the book yet.",
      "you lose this right to cancel when you first download it.",
      "A bundle can be cancelled only if none of its books has been downloaded.",
      "At any time, including after you've downloaded it, we refund a purchase if:",
      "the book never appeared in your library, or the download doesn't work;",
      "the file is damaged or can't be opened, and we can't fix it for you;",
      "you were charged twice for the same book, or charged the wrong amount;",
      "someone bought it with your card or account without your permission.",
      "Tell us as soon as you notice the problem.",
      "Apart from these problems, we don't refund a book after you've downloaded it.",
      'and either "I want to cancel" or what went wrong. We reply within 5 working days.',
      "If you cancel within the 14 days, we send your money back within 14 days of your request.",
      "We return the amount you paid, normally to the card you paid with, through our payment provider POK. Your bank decides how long it takes to show on your statement. Your access to the refunded book or bundle may be removed.",
      "You can also dispute a payment with your bank. Opening a dispute doesn't remove your access. If the bank decides against the payment, your access to that book may be removed.",
      SELLER_PENDING_TEXT,
      "Questions about this policy? Write to support@librum.al .",
    ]) {
      expect(text).toContain(sentence);
    }
    expect(html).toContain('href="mailto:support@librum.al"');
    expect(html).toContain('href="/terms"');
  });

  it("no longer refuses every refund after delivery, and shows no blank slots", () => {
    for (const absent of ["Request refund", "after it has been delivered to your library", "[", "NIPT:"]) {
      expect(text).not.toContain(absent);
    }
  });

  it("is marked as a lawyer-review draft in the code only", () => {
    expect(read("src/app/(public)/refunds/page.tsx")).toContain("LAWYER-REVIEW DRAFT");
    expect(text).not.toMatch(/\bdraft\b|lawyer/i);
  });
});

describe("REFUND POLICY: Terms section 9 links the policy", () => {
  it("keeps the money paragraph and links the policy", () => {
    const source = read("src/app/(public)/terms/page.tsx");
    const section9 = source.match(/<section id="section-9"[\s\S]*?<\/section>/)![0];
    expect(section9).toContain("corresponding author proceeds are reversed");
    expect(section9).toContain('<Link href="/refunds" className="text-primary underline">');
    expect(section9).toContain("Refund Policy");
  });
});
