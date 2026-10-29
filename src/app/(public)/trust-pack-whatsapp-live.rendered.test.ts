import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// TRUST PACK (pipeline item 5, 6): the shown state. The number is empty
// in src/lib/contact.ts (Renato 10-24, b), so this file stands in a
// filled one, to prove the Contact link and the Privacy lines appear
// together once it's set.
vi.mock("@/lib/contact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contact")>();
  return {
    ...actual,
    isWhatsappContactLive: () => true,
    whatsappChatHref: () => "https://wa.me/355600000000",
  };
});

const { default: ContactPage } = await import("./kontakt/page");
const { default: PrivacyPage } = await import("./privatesia/page");

const toText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("TRUST PACK 6: WhatsApp contact, once a number is filled in", () => {
  it("Contact shows the chat link in a new tab, without referrer", () => {
    const html = renderToStaticMarkup(ContactPage());
    expect(html).toContain('href="https://wa.me/355600000000" target="_blank" rel="noopener noreferrer"');
    expect(toText(html)).toContain("Na shkruani në WhatsApp (hapet në një skedë të re)");
  });

  it("Privacy names WhatsApp in the processors, messages and retention", () => {
    const text = toText(renderToStaticMarkup(PrivacyPage()));
    expect(text).toContain("WhatsApp (Meta) — nëse na shkruani në WhatsApp, bisedën e trajton WhatsApp, dhe ne shohim numrin tuaj të telefonit dhe emrin tuaj në WhatsApp.");
    expect(text).toContain("emailet dhe mesazhet në WhatsApp që na dërgoni dhe përgjigjet tona.");
    expect(text).toContain("Emailet dhe bisedat në WhatsApp me ne: deri në 2 vjet pas mesazhit tuaj të fundit.");
  });
});
