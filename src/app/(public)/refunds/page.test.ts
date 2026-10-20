import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RefundsPage, { metadata } from "./page";

// REFUND POLICY: the page text is Renato's policy (refunds only for
// problems, reply within 5 working days, no fixed time limit) and must
// not promise anything the site doesn't do yet.
const html = renderToStaticMarkup(RefundsPage());
const text = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;/g, "'")
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
      "We refund a purchase if:",
      "the book never appeared in your library, or the download doesn't work;",
      "the file is damaged or can't be opened, and we can't fix it for you;",
      "you were charged twice for the same book, or charged the wrong amount;",
      "someone bought it with your card or account without your permission.",
      "Tell us as soon as you notice the problem.",
      "Because ebooks are delivered instantly, we don't otherwise refund a book after it has been delivered to your library.",
      "Write to support@librum.al with the title of the book, the date you bought it, and what went wrong. We reply within 5 working days.",
      "If we approve your refund, we return the amount you paid, normally to the card you paid with, through our payment provider POK. Your bank decides how long it takes to show on your statement. Your access to the refunded book or bundle may be removed.",
      "You can also dispute a payment with your bank. Opening a dispute doesn't remove your access. If the bank decides against the payment, your access to that book may be removed.",
      "Questions about this policy? Write to support@librum.al .",
    ]) {
      expect(text).toContain(sentence);
    }
    expect(html).toContain('href="mailto:support@librum.al"');
  });

  it("promises nothing the site can't do yet", () => {
    for (const absent of ["Request refund", "14 days", "NIPT", "[", "downloads"]) {
      expect(text).not.toContain(absent);
    }
  });
});

describe("REFUND POLICY: Terms section 8 links the policy", () => {
  it("keeps the old paragraph and adds the link", () => {
    const source = read("src/app/(public)/terms/page.tsx");
    const section8 = source.match(/<section id="section-8"[\s\S]*?<\/section>/)![0];
    expect(section8).toContain("doesn&apos;t promise a specific settlement time for a refund");
    expect(section8).toContain('<Link href="/refunds" className="text-primary underline">');
    expect(section8).toContain("Refund Policy");
  });
});
