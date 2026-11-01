import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookCard } from "./book-card";
import { AuthorBookRow } from "./author-book-row";

// COVERS-1: list covers load as the reader scrolls; the covers seen
// first (home fan, book page, bookstore featured) stay eager.
const BOOK = {
  id: "c3d4e5f6-2222-4222-8222-abcdef222222",
  title: "Kënga e fundit",
  genre: "Letërsi artistike",
  price_all: 0,
  pen_name_id: undefined,
  original_author: null,
};

describe("cover images in lists (COVERS-1)", () => {
  it("BookCard loads its cover lazily", () => {
    const html = renderToStaticMarkup(createElement(BookCard, { book: BOOK, coverUrl: "https://x.test/c/cover.jpg" }));
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it("AuthorBookRow loads its cover lazily", () => {
    const html = renderToStaticMarkup(
      createElement(AuthorBookRow, {
        book: { ...BOOK, status: "published" as const, published_at: "2026-09-01T10:00:00Z" },
        coverUrl: "https://x.test/c/cover.jpg",
        missing: [],
      }),
    );
    expect(html).toContain('loading="lazy"');
  });
});

// BD3 patch 4 (4a): a card shows only the original author, as plain
// text (it has no page); the pen name keeps its link.
describe("BookCard byline (BD3 patch 4)", () => {
  const PEN_ID = "f0000000-0000-4000-8000-000000000001";

  it("an original author is plain text, never a link to the uploader's page", () => {
    const html = renderToStaticMarkup(
      createElement(BookCard, {
        book: { ...BOOK, pen_name_id: PEN_ID, original_author: "Lev Tolstoi" },
        coverUrl: null,
        authorName: "Lev Tolstoi",
      }),
    );
    expect(html).toContain("Lev Tolstoi");
    expect(html).not.toContain(`/autore/${PEN_ID}`);
  });

  it("a pen name byline still links to its page", () => {
    const html = renderToStaticMarkup(
      createElement(BookCard, {
        book: { ...BOOK, pen_name_id: PEN_ID, original_author: null },
        coverUrl: null,
        authorName: "Botime Prova",
      }),
    );
    expect(html).toContain(`href="/autore/${PEN_ID}"`);
  });
});
