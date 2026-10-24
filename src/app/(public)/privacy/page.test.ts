import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage, { metadata } from "./page";
import { SELLER_PENDING_TEXT } from "@/lib/seller";

// POLICY PAGES (pipeline item 2): Law 124/2024 notice.
const html = renderToStaticMarkup(PrivacyPage());
const text = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("POLICY PAGES: /privacy", () => {
  it("is titled Privacy Policy", () => {
    expect(metadata.title).toBe("Privacy Policy");
    expect(html).toMatch(/<h1[^>]*>Privacy Policy<\/h1>/);
  });

  it("names the controller, the law and the complaint authority", () => {
    expect(text).toContain("Law No. 124/2024");
    expect(text).toContain(SELLER_PENDING_TEXT);
    expect(text).toContain("Commissioner for the Right to Information and Personal Data Protection");
    expect(html).toContain('href="https://idp.al"');
  });

  it("covers legal bases, processors, transfers, retention, rights and age", () => {
    for (const phrase of [
      "performing our contract with you",
      "To meet legal duties",
      "For our legitimate interests",
      "Supabase",
      "Vercel",
      "Resend",
      "POK",
      "Cloudflare — forwarding emails sent to support@librum.al.",
      "Google (Gmail) — the inbox where we read and answer your emails.",
      "To publish books or receive author payouts, you must be at least 18.",
      "standard contractual clauses",
      "10 years",
      "a record of each time you download a book you bought",
      "IBAN",
      "We reply within one month.",
      "at least 16",
      "within 72 hours",
      "We don't sell your data.",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("keeps exactly one Stripe line until the Stripe removal step", () => {
    expect(text.match(/Stripe/g)).toHaveLength(1);
    expect(text).toContain("Stripe — handled earlier test payments and author payout accounts; we still hold some of those old records, which will be deleted.");
  });

  it("explains the cookieless visit counts (VISITOR STATS, item 6, 3. a)", () => {
    expect(text).toContain(
      "We count page visits with Vercel Web Analytics. It uses no cookies, doesn't follow you across other websites, and doesn't tell us who you are.",
    );
    expect(text).toContain("Vercel — hosting the website and counting anonymous page visits.");
    expect(text).toContain("We don't use advertising or tracking cookies.");
    expect(text).toContain("Last updated: October 2026");
  });

  it("is a lawyer-review draft in the code only, with no blank slots", () => {
    expect(source).toContain("LAWYER-REVIEW DRAFT");
    expect(text).not.toMatch(/\bdraft\b|\[/i);
  });
});
