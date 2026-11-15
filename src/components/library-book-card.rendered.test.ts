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
});
