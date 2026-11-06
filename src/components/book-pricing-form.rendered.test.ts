import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

const { BookPricingForm, pricingTodo, pricingTodoNote } = await import("./book-pricing-form");

// BD15 P4: the Pricing tab rendered (first paint; the live preview's
// rules are in src/lib/book-pricing.test.ts).

const BOOK_ID = "c3d4e5f6-2222-4222-8222-abcdef222222";
type Props = Parameters<typeof BookPricingForm>[0];

function render(overrides: Partial<Props> = {}): string {
  const props: Props = {
    action: async () => undefined,
    bookId: BOOK_ID,
    initialPriceAll: null,
    freeOnly: false,
    paidPublishingAvailable: true,
    checkoutAvailable: false,
    approvalValid: false,
    title: "Libri im",
    byline: "Arben Leka",
    missing: [],
    ...overrides,
  };
  return renderToStaticMarkup(createElement(BookPricingForm, props)).replace(/<!-- -->/g, "");
}

const tick = (html: string, name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
const button = (html: string, label: string) => {
  const end = html.indexOf(`${label}</button>`);
  expect(end).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", end), end);
};

describe("BookPricingForm", () => {
  it("both ticks are there and never pre-ticked (Q2 a), the Terms link opens the Terms", () => {
    const html = render({ initialPriceAll: 249 });
    expect(tick(html, "worldwideRights")).toContain('type="checkbox"');
    expect(tick(html, "worldwideRights")).not.toContain("checked");
    expect(tick(html, "acceptAuthorTerms")).not.toContain("checked");
    expect(html).toContain("Kam të drejtat për ta shitur këtë libër në të gjithë botën.");
    // D1: tick 2 is only the Terms; it no longer repeats "kam të drejtat".
    expect(html).toMatch(/Pranoj <a href="\/kushtet"/);
    expect(html).not.toContain("Konfirmoj që kam të drejtat");
    expect(html).toMatch(/<a href="\/kushtet"[^>]*target="_blank"[^>]*>Kushtet e Librum për autorët/);
    expect(html).toContain("Librum shet në të gjithë botën, në një treg të vetëm: librum.al.");
  });

  it("no price yet: neither choice picked, the preview asks for a price", () => {
    const html = render();
    expect(tick(html, "priceMode")).not.toContain("checked");
    expect(html).toContain("Shkruani një çmim për të parë sa merrni.");
    expect(html).not.toContain('name="price"');
  });

  it("a stored paid price: Me pagesë picked, the box filled, the D3 preview with the tax line", () => {
    const html = render({ initialPriceAll: 249 });
    expect(html.match(/<input[^>]*value="paid"[^>]*>/)![0]).toContain('checked=""');
    expect(html.match(/<input[^>]*name="price"[^>]*>/)![0]).toContain('value="249"');
    expect(html).toContain("Minimumi 99 lekë. Një çmim i vetëm, në lekë.");
    expect(html).toMatch(/<dd[^>]*>70%<\/dd>/);
    expect(html).toContain("Përqindja juaj");
    expect(html).toContain("Ju merrni për çdo shitje");
    expect(html).not.toMatch(/Përqindja jote|Ti merr/);
    expect(html).toMatch(/<dd[^>]*>174 lekë<\/dd>/);
    expect(html).not.toContain("174,30");
    expect(html).toContain("Shuma është para tatimit 15% që mbahet në burim.");
    expect(html).toContain("50% për çmime nën 199 lekë, 70% nga 199 lekë e lart.");
  });

  it("below 199 lek: 50%, and what 199 lek would pay", () => {
    const html = render({ initialPriceAll: 99 });
    expect(html).toMatch(/<dd[^>]*>50%<\/dd>/);
    expect(html).toMatch(/<dd[^>]*>49 lekë<\/dd>/);
    expect(html).not.toContain("49,50");
    expect(html).toContain("Me 199 lekë do të merrnit 139 lekë për çdo shitje (70%).");
  });

  it("a stored free price: Falas picked, no price box", () => {
    const html = render({ initialPriceAll: 0 });
    expect(html.match(/<input[^>]*value="free"[^>]*>/)![0]).toContain('checked=""');
    expect(html).not.toContain('name="price"');
    expect(html).toContain("Lexuesit e shkarkojnë falas pasi hyjnë në llogari.");
  });

  it("a public-domain book: Falas only, as a hidden value, with the reason", () => {
    const html = render({ freeOnly: true, initialPriceAll: 500 });
    expect(html).toContain('<input type="hidden" name="priceMode" value="free"/>');
    expect(html).not.toContain('value="paid"');
    expect(html).toContain("Librat e domenit publik në Librum janë vetëm falas.");
  });

  it("paid publishing closed / buying not open yet: the matching line under a paid price", () => {
    expect(render({ initialPriceAll: 249, paidPublishingAvailable: false })).toContain(
      "Publikimi me pagesë nuk ka nisur ende.",
    );
    const opensSoon = render({ initialPriceAll: 249, paidPublishingAvailable: true, checkoutAvailable: false });
    expect(opensSoon).toContain("Blerjet hapen së shpejti.");
    expect(render({ initialPriceAll: 249, checkoutAvailable: true })).not.toContain("Blerjet hapen së shpejti.");
    expect(render({ initialPriceAll: 0, checkoutAvailable: false })).not.toContain("Blerjet hapen së shpejti.");
  });

  it("the send button: Dërgo për shqyrtim, or Publiko when the approval still matches", () => {
    expect(button(render(), "Dërgo për shqyrtim")).toContain('value="send"');
    expect(button(render({ approvalValid: true }), "Publiko")).toContain('value="send"');
    expect(button(render(), "Ruaj draftin")).toContain('value="save"');
  });

  it("BD15 P5a (P4 audit F7): Publiko says a changed byline goes back to review", () => {
    const note = "Nëse emri i autorit brenda librit elektronik duhet përditësuar, libri kalon përsëri në shqyrtim.";
    expect(render({ approvalValid: true })).toContain(note);
    expect(render()).not.toContain(note);
  });

  it("what is missing is listed with links to its tab, and Send is disabled", () => {
    const html = render({
      missing: [
        { tab: "details", label: "Përshkrimi" },
        { tab: "content", label: "Pyetja për AI" },
      ],
    });
    expect(html).toContain(`href="/dashboard/books/${BOOK_ID}/editor?tab=details"`);
    expect(html).toContain(`href="/dashboard/books/${BOOK_ID}/editor?tab=content"`);
    expect(html).toContain("Pyetja për AI</a> <span class=\"text-muted\">(Përmbajtja)</span>");
    expect(button(html, "Dërgo për shqyrtim")).toContain('disabled=""');
    // The two unticked boxes count too (Renato 11-04, a): 2 + 2.
    expect(html).toContain('href="#pricing-worldwide"');
    expect(html).toContain('href="#pricing-terms-tick"');
    expect(html).toContain("Plotësoni 4 gjëra më lart");
  });

  // BD15 P5b-3a (Renato 11-04, Q2 a): a taken-down book's price still
  // saves, but Send is disabled with Librum's reason in place of the
  // to-do count.
  it("a taken-down book: Send disabled with the refusal note, Save still there", () => {
    const html = render({ sendRefusedNote: "Librum e hoqi këtë libër, prandaj nuk mund ta dërgoni tani." });
    expect(button(html, "Dërgo për shqyrtim")).toContain('disabled=""');
    expect(html).toContain("Librum e hoqi këtë libër, prandaj nuk mund ta dërgoni tani.");
    expect(html).not.toContain("Plotësoni 2 gjëra më lart");
    expect(html).toContain('value="save"');
  });

  it("D1: on first paint the two boxes are unticked, so Send is a dashed, disabled button", () => {
    const html = render();
    const send = button(html, "Dërgo për shqyrtim");
    expect(send).toContain('disabled=""');
    expect(send).toContain("border-dashed");
    expect(html).toContain("Plotësoni 2 gjëra më lart");
    expect(html).toContain('id="pricing-worldwide"');
    expect(html).toContain('id="pricing-terms-tick"');
  });

  it("D1: the to-do list counts each unticked box and empties once both are ticked", () => {
    const missing = [{ tab: "content" as const, label: "Ballina" }];
    expect(pricingTodo(BOOK_ID, [], { worldwide: true, terms: true })).toEqual([]);
    expect(pricingTodo(BOOK_ID, [], { worldwide: true, terms: false }).map((t) => t.key)).toEqual(["tick-terms"]);
    expect(pricingTodo(BOOK_ID, [], { worldwide: false, terms: true }).map((t) => t.key)).toEqual(["tick-worldwide"]);
    const all = pricingTodo(BOOK_ID, missing, { worldwide: false, terms: false });
    expect(all.map((t) => t.href)).toEqual([
      `/dashboard/books/${BOOK_ID}/editor?tab=content`,
      "#pricing-worldwide",
      "#pricing-terms-tick",
    ]);
    expect(pricingTodoNote(0)).toBeUndefined();
    expect(pricingTodoNote(1)).toBe("Plotësoni 1 gjë më lart");
    expect(pricingTodoNote(3)).toBe("Plotësoni 3 gjëra më lart");
  });

  it("D1: the back link saves first (a submit button with intent back)", () => {
    const back = button(render(), "Përmbajtja");
    expect(back).toContain('type="submit"');
    expect(back).toContain('value="back"');
  });

  it("audit r1 F1: Enter in a text box saves and stays -- Ruaj draftin is the form's first submit button", () => {
    const html = render({ initialPriceAll: 249 });
    const first = html.match(/<button type="submit"[^>]*>/)![0];
    expect(first).toContain('value="save"');
    expect(html.indexOf('value="back"')).toBeGreaterThan(html.indexOf('value="send"'));
  });

  // Audit r1 F2: no DOM here to click, so the wiring is pinned in the
  // source: each box is controlled by its own state and its onChange
  // sets that state, and the to-do list reads both.
  it("audit r1 F2: each tick is wired to its own state, and the to-do list reads both", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./book-pricing-form.tsx", import.meta.url), "utf8");
    const box = (field: string) => {
      const at = src.indexOf(`name={${field}}`);
      expect(at).toBeGreaterThan(-1);
      return src.slice(src.lastIndexOf("<input", at), src.indexOf("/>", at));
    };
    expect(box("WORLDWIDE_RIGHTS_FIELD")).toContain("checked={worldwide}");
    expect(box("WORLDWIDE_RIGHTS_FIELD")).toContain("onChange={(e) => setWorldwide(e.target.checked)}");
    expect(box("ACCEPT_TERMS_FIELD")).toContain("checked={terms}");
    expect(box("ACCEPT_TERMS_FIELD")).toContain("onChange={(e) => setTerms(e.target.checked)}");
    expect(src).toContain("pricingTodo(bookId, missing, { worldwide, terms })");
    // BD15 P5b-2: a live book with no waiting change has nothing to send.
    // P5b-3a: a taken-down book is never sent (sendRefusedNote).
    expect(src).toContain(
      "const sendBlocked = sendRefusedNote !== null || todo.length > 0 || (live !== null && !live.hasChanges);",
    );
    expect(src).toContain("primaryBlocked={sendBlocked}");
  });

  it("the reader preview shows the title, the pen name and the price", () => {
    const html = render({ initialPriceAll: 1500 });
    expect(html).toContain("Libri im");
    expect(html).toContain("Arben Leka");
    expect(html).toContain('<p class="mt-1.5 font-semibold">1.500 lekë</p>');
  });
});
