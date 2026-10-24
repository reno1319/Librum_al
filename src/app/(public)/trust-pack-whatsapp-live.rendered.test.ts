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

const { default: ContactPage } = await import("./contact/page");
const { default: PrivacyPage } = await import("./privacy/page");

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
    expect(toText(html)).toContain("Chat on WhatsApp");
  });

  it("Privacy names WhatsApp in the processors, messages and retention", () => {
    const text = toText(renderToStaticMarkup(PrivacyPage()));
    expect(text).toContain("WhatsApp (Meta) — if you message us on WhatsApp, WhatsApp handles that chat, and we see your phone number and WhatsApp name.");
    expect(text).toContain("the emails and WhatsApp messages you send us and our replies.");
    expect(text).toContain("Emails and WhatsApp chats with us: up to 2 years after your last message.");
  });
});
