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
  genre: "Fiction",
  price_all: 0,
  pen_name_id: undefined,
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
