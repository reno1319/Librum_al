import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// TRUST PACK (pipeline item 5, Renato 10-24): reader help page, reply
// promise, WhatsApp contact + Privacy line, team slot, share link.
// Help and About read the visitor (closing band), so they render
// against a signed-out Supabase client, as in small-fixes-wiring.test.ts.
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));

const { default: ReadingHelpPage, metadata: readingMetadata, SEND_TO_KINDLE_HREF } = await import("./help/reading/page");
const { default: ContactPage } = await import("./contact/page");
const { default: PrivacyPage } = await import("./privacy/page");
const { default: HelpPage } = await import("./help/page");
const { default: AboutPage } = await import("./about/page");
const { SiteFooter } = await import("@/components/site-footer");

const toText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const root = path.join(__dirname, "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("TRUST PACK 1-2: How to read your book", () => {
  const html = renderToStaticMarkup(ReadingHelpPage());
  const text = toText(html);

  it("is its own page with one h1", () => {
    expect(readingMetadata.title).toBe("Si ta lexoni librin tuaj");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Si ta lexoni librin tuaj<\/h1>/);
  });

  it("covers iPhone, Android, computer and Kindle with the named apps", () => {
    for (const phrase of ["iPhone ose iPad", "Telefon ose tablet Android", "Kompjuter", "Kindle", "Apple Books", "Google Play Books", "Thorium Reader", "Send to Kindle", "pa DRM", 'Prekni "Shkarkoni EPUB"']) {
      expect(text).toContain(phrase);
    }
    for (const id of ["iphone", "android", "computer", "kindle"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
  });

  it("links Amazon's Send to Kindle page and Thorium in a new tab, without referrer", () => {
    expect(SEND_TO_KINDLE_HREF).toBe("https://www.amazon.com/sendtokindle");
    for (const href of [SEND_TO_KINDLE_HREF, "https://thorium.edrlab.org/"]) {
      expect(html).toContain(`href="${href}" target="_blank" rel="noopener noreferrer"`);
    }
    // T54: both new-tab links say so to screen readers.
    expect(html.match(/<span class="sr-only"> \(hapet në një skedë të re\)<\/span><\/a>/g)).toHaveLength(2);
  });

  it("says where downloads are and repeats the 14-day rule with a Refund Policy link", () => {
    expect(html).toContain('href="/library"');
    expect(text).toContain("brenda 14 ditëve, për sa kohë nuk e keni shkarkuar ende librin");
    expect(text).toContain("Shkarkimi i parë e mbyll këtë të drejtë.");
    expect(html).toContain('href="/refunds"');
  });

  it("ends with the support email and the reply promise", () => {
    expect(html).toContain('href="mailto:support@librum.al"');
    expect(text).toContain("Përgjigjemi brenda 3 ditëve të punës.");
  });
});

describe("TRUST PACK 1: links to the reader help page", () => {
  it("Help has an answer that links to it, and the reply promise at the bottom", async () => {
    const html = renderToStaticMarkup(await HelpPage());
    const text = toText(html);
    expect(text).toContain("Si ta hap një libër që kam shkarkuar?");
    expect(html).toContain('href="/help/reading"');
    expect(text).toContain("Si ta lexoni librin tuaj, hap pas hapi");
    expect(text).toContain("Na kontaktoni . Përgjigjemi brenda 3 ditëve të punës.");
  });

  // ALBANIAN-13 (Renato's a): the answers written before book review
  // existed now name it.
  it("Help says a book needs Librum's approval, and that a new cover or file waits for it", async () => {
    const text = toText(renderToStaticMarkup(await HelpPage()));
    expect(text).toContain("Një libër shfaqet në Librari pasi e dërgoni për shqyrtim, Librum e miraton dhe libri ka një çmim.");
    expect(text).toContain("Nëse ndryshoni kopertinën ose skedarin e librit, libri del nga Libraria derisa Librum ta miratojë.");
  });

  it("the Library and the book page's owned panel link to it", () => {
    expect(read("src/app/(public)/library/page.tsx")).toContain('href="/help/reading"');
    const book = read("src/app/(public)/books/[id]/page.tsx");
    const owned = book.slice(book.indexOf('if (state === "owned")'), book.indexOf("ALL-WIRING-2: a book with no authored"));
    expect(owned).toContain('href="/help/reading"');
  });
});

describe("TRUST PACK 5-6: Contact, footer and Privacy", () => {
  it("Contact shows the email and the promise, and no WhatsApp link while the number is empty", () => {
    const html = renderToStaticMarkup(ContactPage());
    expect(html).toContain('href="mailto:support@librum.al"');
    expect(toText(html)).toContain("Përgjigjemi brenda 3 ditëve të punës.");
    expect(html).not.toContain("wa.me");
    expect(html).not.toContain("WhatsApp");
  });

  it("the footer shows the promise under the email", () => {
    const html = renderToStaticMarkup(SiteFooter());
    expect(html).toContain('href="mailto:support@librum.al"');
    expect(toText(html)).toContain("Përgjigjemi brenda 3 ditëve të punës.");
  });

  // ALBANIAN-13 (SQ-4 audit N8): each footer link group is a named nav,
  // and the partner link says it opens a new tab.
  it("the footer names its link groups and marks the partner link as a new tab", () => {
    const html = renderToStaticMarkup(SiteFooter());
    expect(html.match(/<nav aria-label="[^"]+"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<nav aria-label="Ligjore"');
    expect(toText(html)).toContain("Boto me L&K ↗ (hapet në një skedë të re)");
  });

  it("Privacy doesn't mention WhatsApp while the number is empty", () => {
    const text = toText(renderToStaticMarkup(PrivacyPage()));
    expect(text).not.toContain("WhatsApp");
    expect(text).toContain("the emails you send us and our replies.");
    expect(text).toContain("Emails with us: up to 2 years after your last message.");
  });

  it("the Contact link and the Privacy lines come from the same value", () => {
    expect(read("src/app/(public)/contact/page.tsx")).toContain("whatsappChatHref()");
    const privacy = read("src/app/(public)/privacy/page.tsx");
    expect(privacy.match(/isWhatsappContactLive\(\)/g)).toHaveLength(3);
  });
});

describe("TRUST PACK 6: share on WhatsApp", () => {
  const book = read("src/app/(public)/books/[id]/page.tsx");

  it("is a plain link built by bookWhatsappShareHref, with no WhatsApp script", () => {
    expect(book).toContain("bookWhatsappShareHref(book, bookByline)");
    expect(book).toMatch(/href=\{whatsappShareHref\}\s+target="_blank"\s+rel="noopener noreferrer"/);
    expect(book).toContain("Ndajeni në WhatsApp");
    expect(book).not.toMatch(/<script|next\/script/);
  });
});

describe("TRUST PACK 3-4: Who we are", () => {
  it("doesn't render on About while the team list is empty", async () => {
    const html = renderToStaticMarkup(await AboutPage());
    expect(html).not.toContain("Kush jemi");
    expect(html).not.toContain('id="team-heading"');
  });
});

// ALBANIAN-13 (Renato's a): About no longer says books go live without
// approval; it says Librum checks every book.
describe("About: the review is described truthfully", () => {
  it("says Librum checks every book before it reaches the Bookstore", async () => {
    const text = toText(renderToStaticMarkup(await AboutPage()));
    expect(text).toContain("Librum kontrollon çdo libër para se të dalë në Librari.");
    expect(text).not.toMatch(/pa pritur|pa miratim/);
  });
});
