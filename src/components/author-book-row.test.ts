import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ADMIN-2-TAKEDOWN (G, M4): the Dashboard row of a book Librum took
// down -- the TAKEN DOWN tag and the notice in place of the draft's
// missing-items list, and "Edit" rather than "Vazhdoni përgatitjen".
vi.mock("@/app/(public)/dashboard/books/actions", () => ({ deleteBook: { bind: () => async () => undefined } }));

const { AuthorBookRow } = await import("./author-book-row");

const BOOK = {
  id: "c3d4e5f6-2222-4222-8222-abcdef222222",
  title: "Kënga e fundit",
  status: "draft" as const,
  price_all: 0,
  genre: "Letërsi artistike",
  published_at: "2026-09-01T10:00:00Z",
};

function render(props: Partial<Parameters<typeof AuthorBookRow>[0]> = {}): string {
  return renderToStaticMarkup(createElement(AuthorBookRow, { book: BOOK, coverUrl: null, missing: ["Cover"], ...props }));
}

describe("AuthorBookRow: a book Librum took down", () => {
  it("shows the tag and the notice instead of the missing list", () => {
    const html = render({
      takedown: {
        takenDownAt: "2026-10-19T10:00:00Z",
        reason: "content_rules",
        message: "This breaks the rules",
        bundleTitles: ["Set A"],
      },
    });
    expect(html).toContain("<span>Hequr nga Libraria</span>");
    expect(html).not.toContain("<span>Draft</span>");
    expect(html).toContain('role="status"');
    expect(html).toMatch(/Hequr nga Libraria më [^<]+\. Arsyeja: Shkel rregullat e përmbajtjes\./);
    expect(html).toContain("This breaks the rules.");
    expect(html).toContain("Hoqëm nga publikimi edhe: Set A.");
    expect(html).toContain("Pyetje? Na shkruani te support@librum.al");
    expect(html).not.toContain("Për t&#x27;u bërë:");
    expect(html).not.toContain("Vazhdoni përgatitjen");
    expect(html).toContain(">Shikoni arsyen<");
  });

  it("is an ordinary draft without one", () => {
    const html = render();
    expect(html).toContain("<span>Draft</span>");
    expect(html).toContain("Për t&#x27;u bërë: Cover");
    expect(html).toContain("Vazhdoni përgatitjen");
    expect(html).not.toContain("Hequr nga Libraria");
  });
});

// Upload notes 3a (Enkelejd 11-06): the shelf line names the file
// format, "EPUB", not "E-libër".
describe("AuthorBookRow: format wording", () => {
  it("says EPUB, never E-libër", () => {
    const html = render({ book: { ...BOOK, status: "published" as const } });
    expect(html).toContain("EPUB · Letërsi artistike · Publikuar më");
    expect(html).not.toContain("E-libër");
  });
});

// ADMIN-3-REVIEW (F, 4a): the IN REVIEW tag (no timing promise, no
// "Vazhdoni përgatitjen"), and the send-back notice while it is the newest
// review. The takedown notice keeps priority.
describe("AuthorBookRow: In review and sent back (ADMIN-3)", () => {
  const SENT_BACK = { sentBackAt: "2026-10-19T10:00:00Z", reason: "broken_file", message: "The file does not open" };
  const TAKEDOWN = { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Proof please", bundleTitles: [] };

  it("in review: the IN REVIEW tag instead of DRAFT, no missing list, no Vazhdoni përgatitjen", () => {
    const html = render({ review: { inReview: true, sentBack: null } });
    expect(html).toContain("<span>Në shqyrtim</span>");
    expect(html).not.toContain("<span>Draft</span>");
    expect(html).not.toContain("Për t&#x27;u bërë:");
    expect(html).not.toContain("Vazhdoni përgatitjen");
    expect(html).not.toMatch(/\b(hours?|days?|within|soon)\b/i);
  });

  it("sent back: the notice, in reading order, and the fix button (BD15 P6)", () => {
    const html = render({ review: { inReview: false, sentBack: SENT_BACK } });
    expect(html).toContain("<span>Kthyer për ndryshime</span>");
    expect(html).toMatch(/Librum jua ktheu këtë libër për ndryshime më [^<]+\. Arsyeja: Skedar i gabuar ose i dëmtuar\./);
    const order = ["Librum jua ktheu këtë libër", "The file does not open.", "Rregullojeni dhe dërgojeni përsëri për shqyrtim.", "Pyetje? Na shkruani te support@librum.al"];
    const at = order.map((text) => html.indexOf(text));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain(">Rregullojeni dhe ridërgojeni<");
    expect(html).not.toContain("Për t&#x27;u bërë:");
  });

  it("a takedown replaces both", () => {
    for (const review of [{ inReview: true, sentBack: null }, { inReview: false, sentBack: SENT_BACK }]) {
      const html = render({ takedown: TAKEDOWN, review });
      expect(html).toContain("<span>Hequr nga Libraria</span>");
      expect(html).not.toContain("<span>Në shqyrtim</span>");
      expect(html).not.toContain("Librum jua ktheu këtë libër");
    }
  });

  // BD15 P6: a live book's send back shows only while the changes it
  // was about still wait (the page decides, state "live_sent_back").
  it("a live book without that state shows no send-back notice", () => {
    const html = render({ book: { ...BOOK, status: "published" }, review: { inReview: false, sentBack: SENT_BACK } });
    expect(html).toContain("<span>Publikuar</span>");
    expect(html).not.toContain("Librum jua ktheu");
  });

  it("a live book whose changes wait for review: its own state and the read-only button", () => {
    const html = render({ book: { ...BOOK, status: "published" }, review: { inReview: true, sentBack: null } });
    expect(html).toContain("<span>Publikuar, ndryshimet në shqyrtim</span>");
    expect(html).toContain(">Shikoni çfarë dërguat<");
    expect(html).not.toContain(">Ndryshoni të dhënat<");
  });

  it("a live book whose changes were sent back: the live notice and the fix button", () => {
    const html = render({
      book: { ...BOOK, status: "published" },
      review: { inReview: false, sentBack: SENT_BACK },
      state: "live_sent_back",
    });
    expect(html).toContain("<span>Publikuar, ndryshimet u kthyen</span>");
    expect(html).toContain("Librum jua ktheu ndryshimet më");
    expect(html).toContain("Rregullojini dhe dërgojini përsëri për shqyrtim.");
    expect(html).toContain(">Rregulloni ndryshimet<");
    expect(html).toContain(">Hidhni poshtë ndryshimet<");
    // Audit r1 N1: the discard button is in the live-edit notice at the
    // top of the Details tab, so the link has no #veprime anchor.
    expect(html).toMatch(new RegExp(`href="/dashboard/books/${BOOK.id}/editor\\?tab=details"[^>]*>Hidhni poshtë ndryshimet<`));
  });

  it("the notice escapes Librum's message", () => {
    const html = render({ review: { inReview: false, sentBack: { ...SENT_BACK, message: "<b>x</b>" } } });
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

// PHONE PASS (D3, D4 / Renato 4a 5a): Edit (or Vazhdoni përgatitjen) plus a
// "···" menu on every row; the menu's items, by book state.
describe("AuthorBookRow: the ··· menu (PHONE PASS)", () => {
  const LIVE = { ...BOOK, status: "published" as const, price_all: 499 };
  const editBase = `/dashboard/books/${BOOK.id}/edit`;
  // BD15 P5b-3a: the old edit page is retired; every book opens the editor.
  const editor = `/dashboard/books/${BOOK.id}/editor?tab=`;

  it("a live book: its book page plus ···, the edit items and Unpublish, no Delete (P6, Q3 a)", () => {
    const html = render({ book: LIVE, missing: [] });
    expect(html).toMatch(new RegExp(`href="/libra/${BOOK.id}"[^>]*>Shikoni faqen e librit<`));
    expect(html).toContain(`aria-label="Më shumë veprime për ${BOOK.title}"`);
    expect(html).toContain(">···<");
    expect(html).not.toContain(">Më shumë veprime<");
    for (const [label, href] of [
      ["Ndryshoni të dhënat", `${editor}details`],
      ["Ndryshoni dorëshkrimin ose ballinën", `${editor}content`],
      ["Ndryshoni çmimin", `${editor}pricing`],
      ["Hiqeni nga shitja", `${editor}details#veprime`],
    ]) {
      expect(html).toContain(`href="${href}"`);
      expect(html).toContain(`>${label}<`);
    }
    expect(html).not.toContain(">Fshini<");
    expect(html).not.toContain(">Shikojeni në Librari<");
    expect(html).not.toContain(`href="${editBase}"`);
    expect(html).not.toContain(`href="${editBase}#`);
  });

  it("a live book's page appears once, as the main button, not again in the menu", () => {
    const html = render({ book: LIVE, missing: [] });
    expect(html.split(`href="/libra/${BOOK.id}"`).length - 1).toBe(1);
    expect(html.indexOf(`href="/libra/${BOOK.id}"`)).toBeLessThan(html.indexOf("<summary"));
  });

  it("a live book with waiting changes keeps Shikojeni në Librari in the menu", () => {
    const html = render({ book: LIVE, missing: [], state: "live_changes" });
    expect(html).toContain(">Vazhdoni ndryshimet<");
    expect(html).toContain(">Shikojeni në Librari<");
    expect(html).toContain("Lexuesit shohin ende versionin e vjetër");
  });

  // BD15 P5a (P4 audit F8): a plain draft opens the editor, each menu
  // item on its own tab; a book in review is read-only.
  it("a plain draft: the button and the three edit items open the editor's tabs", () => {
    const html = render();
    expect(html).toContain(`href="${editor}details"`);
    expect(html).toContain(`href="${editor}content"`);
    expect(html).toContain(`href="${editor}pricing"`);
    expect(html).not.toContain(`href="${editBase}"`);
    expect(html).not.toContain(`href="${editBase}#`);
  });

  it("in review: Shikoni çfarë dërguat (the editor, read-only) and no edit items", () => {
    const html = render({ review: { inReview: true, sentBack: null } });
    expect(html).toContain(`href="${editor}details"`);
    expect(html).toContain(">Shikoni çfarë dërguat<");
    for (const label of ["Ndryshoni të dhënat", "Ndryshoni dorëshkrimin ose ballinën", "Ndryshoni çmimin"]) {
      expect(html).not.toContain(`>${label}<`);
    }
  });

  // BD15 P5b-3a (Renato 11-04, Q2 a): a taken-down book is edited in the
  // editor like a draft.
  it("a taken-down draft opens the editor's tabs", () => {
    const html = render({
      takedown: { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Proof please", bundleTitles: [] },
    });
    expect(html).toContain(`href="${editor}content"`);
    expect(html).not.toContain(`href="${editBase}"`);
    expect(html).not.toContain(`href="${editBase}#`);
  });

  it("audit r1 N2: a taken-down book has no Fshini and no delete form", () => {
    const html = render({
      takedown: { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Proof please", bundleTitles: [] },
    });
    expect(html).not.toContain(">Fshini<");
    expect(html.match(/<form/g)).toBeNull();
  });

  it("a draft: Vazhdoni përgatitjen plus ···, no View or Unpublish, Delete kept", () => {
    const html = render();
    expect(html).toContain("Vazhdoni përgatitjen");
    expect(html).toContain(`aria-label="Më shumë veprime për ${BOOK.title}"`);
    expect(html).toContain(">Ndryshoni të dhënat<");
    expect(html).not.toContain("Shikojeni në Librari");
    expect(html).not.toContain(">Hiqeni nga shitja<");
    expect(html).toContain(">Fshini<");
  });

  // PREVIEW-1 (A5, Renato 6a): every book that isn't live has Preview,
  // a link to its own page inside the menu; a live book has View instead.
  it.each<[string, Partial<Parameters<typeof AuthorBookRow>[0]>]>([
    ["a draft", {}],
    ["a book in review", { review: { inReview: true, sentBack: null } }],
    [
      "a sent-back book",
      {
        review: {
          inReview: false,
          sentBack: { sentBackAt: "2026-10-19T10:00:00Z", reason: "broken_file", message: "The file does not open" },
        },
      },
    ],
    [
      "a taken-down book",
      { takedown: { takenDownAt: "2026-10-19T10:00:00Z", reason: "content_rules", message: "x", bundleTitles: [] } },
    ],
  ])("%s: Preview links to the book's own page, once, inside the menu", (_label, props) => {
    const html = render(props);
    expect(html).toMatch(new RegExp(`href="/libra/${BOOK.id}"[^>]*>Shikoni librin para botimit<`));
    expect(html.split(`href="/libra/${BOOK.id}"`).length - 1).toBe(1);
    expect(html.indexOf(`href="/libra/${BOOK.id}"`)).toBeGreaterThan(html.indexOf("<summary"));
    expect(html).not.toContain("Shikojeni në Librari");
  });

  it("a live book has no Preview", () => {
    const html = render({ book: { ...BOOK, status: "published" as const, price_all: 499 }, missing: [] });
    expect(html).not.toContain(">Shikoni librin para botimit<");
  });

  it("a draft keeps no Unpublish and keeps Delete", () => {
    const html = render();
    expect(html).not.toContain(">Hiqeni nga shitja<");
    expect(html).toContain(">Fshini<");
  });

  it("Unpublish is only a link to the editor, never a form of its own (and a live book has no Delete form)", () => {
    const html = render({ book: LIVE, missing: [] });
    expect(html.match(/<form/g)).toBeNull();
    expect(render().match(/<form/g)?.length).toBe(1);
  });

  it("the menu is a floating panel inside a <details>, the summary 44px square", () => {
    const html = render({ book: LIVE, missing: [] });
    expect(html).toMatch(/<div class="relative flex w-full[^"]*sm:w-auto"/);
    expect(html).toMatch(/<details class="sm:relative"><summary[^>]*\bsize-11\b/);
    expect(html).toMatch(/<div class="absolute left-0 top-full z-10[^"]*sm:right-0/);
  });

  it("r2 (audit N3): the row menu asks DismissableDetails to close when focus leaves it", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./author-book-row.tsx", import.meta.url)), "utf8");
    expect(source).toContain('<DismissableDetails className="sm:relative" closeOnFocusOut>');
  });
});

// BD15 P6: series line, price before one is set, the download item.
describe("AuthorBookRow: the bookshelf card (BD15 P6)", () => {
  it("shows the series and position when the page passes them", () => {
    expect(render({ book: { ...BOOK, series_position: 3 }, seriesTitle: "Kronikat" })).toContain(">Kronikat · Libri 3<");
    expect(render({ book: { ...BOOK, series_position: 3 } })).toContain(">Libri 3<");
    expect(render()).not.toContain("Libri ");
  });

  it("a book with no price yet says Pa çmim ende", () => {
    expect(render({ book: { ...BOOK, price_all: null } })).toContain("Pa çmim ende");
  });

  it("offers the author's own file as a plain download link only when there is one", () => {
    const withFile = render({ book: { ...BOOK, file_path: "x/y.epub" } });
    expect(withFile).toMatch(new RegExp(`<a href="/api/books/${BOOK.id}/download"[^>]*>Shkarkoni skedarin tuaj</a>`));
    expect(render()).not.toContain("Shkarkoni skedarin tuaj");
  });

  it("the status dot is decorative", () => {
    expect(render()).toMatch(/<span aria-hidden="true" class="size-2 shrink-0 rounded-full [^"]*"><\/span><span>Draft<\/span>/);
  });
});
