import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryBookCard } from "./library-book-card";
import { BookReader, type ReaderData } from "./book-reader";
import { DOWNLOAD_CANCEL_WARNING } from "@/lib/book-downloads";

// Buyer reader (Renato 11-15, pictures r1 approved): every owned book in
// Biblioteka ime has "Lexo" next to "Shkarko EPUB".
const base = {
  bookId: "b1",
  title: "Libër prove",
  coverUrl: null,
  penNameId: null,
  authorName: "Autor Prove",
  isPublished: true,
};

describe("LibraryBookCard: Lexo + Shkarko EPUB", () => {
  it("an owned book shows Lexo and Shkarko EPUB", () => {
    const html = renderToStaticMarkup(createElement(LibraryBookCard, { ...base, downloadable: true }));
    expect(html).toMatch(/<button[^>]*>Lexo<\/button>/);
    expect(html).toContain(">Shkarko EPUB</a>");
    expect(html).toContain('href="/api/books/b1/download"');
    expect(html).not.toContain("Shkarkoni EPUB");
  });

  it("no ownership, no buttons", () => {
    const html = renderToStaticMarkup(createElement(LibraryBookCard, { ...base, downloadable: false }));
    expect(html).not.toContain(">Lexo<");
    expect(html).not.toContain("Shkarko EPUB");
  });

  it("1a: the warning line names reading too", () => {
    const html = renderToStaticMarkup(
      createElement(LibraryBookCard, { ...base, downloadable: true, downloadNote: DOWNLOAD_CANCEL_WARNING }),
    );
    expect(html).toContain("Leximi ose shkarkimi i jep fund të drejtës suaj për ta anuluar këtë blerje.");
  });
});

// K8 (Renato 11-15, pictures r1 with his change): the bar and "N% e
// lexuar" only; no highlight count; nothing before the book is started.
describe("LibraryBookCard: how much is read", () => {
  const render = (progress: number | null) =>
    renderToStaticMarkup(createElement(LibraryBookCard, { ...base, downloadable: true, progress }));
  it("a started book shows the bar and the share read", () => {
    const html = render(0.356);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="36"');
    expect(html).toContain("35% e lexuar");
    expect(html).not.toMatch(/theksim/);
  });
  it("a finished book says Përfunduar", () => {
    expect(render(1)).toContain("Përfunduar");
  });
  it("a book not started (or no place) shows nothing", () => {
    expect(render(null)).not.toContain("progressbar");
    expect(render(0)).not.toContain("progressbar");
  });
});

describe("BookReader in owned mode", () => {
  it("shows 'nga [autori]' with no 'Pjesë falas' and no end-of-sample page", () => {
    const data: ReaderData = {
      title: "Libër prove",
      author: "Autor Prove",
      mode: "owned",
      html: "<section class=\"lb-sec\"><p>Tekst.</p></section>",
      toc: [],
      approximatePercent: 100,
    };
    const html = renderToStaticMarkup(
      createElement(BookReader, { data, coverUrl: null, onClose: () => {}, endAction: null, positionKey: "librum-reader-place:b1" }),
    );
    expect(html).toContain("nga Autor Prove");
    expect(html).not.toContain("Pjesë falas");
    expect(html).not.toContain("Pamja paraprake");
  });

  it("K8: no bookmark ribbon until the buyer's marks have loaded (never for the sample)", () => {
    const data: ReaderData = { title: "L", author: null, mode: "owned", html: "<p>T.</p>", toc: [], approximatePercent: 100 };
    const html = renderToStaticMarkup(
      createElement(BookReader, { data, coverUrl: null, onClose: () => {}, endAction: null, positionKey: "k", marksBookId: "b1" }),
    );
    expect(html).not.toContain("faqerojtës");
    expect(html).toContain('aria-label="Përmbajtja"');
  });
});
