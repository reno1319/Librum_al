import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BookShelf } from "./book-shelf";

// Patch A: the optional "Shiko të gjitha" link next to a shelf's heading.
const supabase = {
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
} as unknown as Parameters<typeof BookShelf>[0]["supabase"];
const book = {
  id: "b1", title: "Një libër", cover_path: null, genre: "Poezi", price_all: 250, is_adult: false,
  pen: { id: "p1", name: "Një Autor" },
} as unknown as Parameters<typeof BookShelf>[0]["books"][number];

describe("BookShelf seeAllHref", () => {
  it("shows the link only when given", () => {
    const withLink = renderToStaticMarkup(BookShelf({ title: "Rafti", books: [book], supabase, seeAllHref: "/librari?genre=Poezi" }));
    expect(withLink).toMatch(/<a [^>]*href="\/librari\?genre=Poezi"[^>]*>Shiko të gjitha →<\/a>/);
    const without = renderToStaticMarkup(BookShelf({ title: "Rafti", books: [book], supabase }));
    expect(without).not.toContain("Shiko të gjitha");
  });

  it("marks the card's genre label for the book page's scoped size", () => {
    const html = renderToStaticMarkup(BookShelf({ title: "Rafti", books: [book], supabase }));
    expect(html).toMatch(/<span data-card-genre="" class="text-xs uppercase tracking-wide text-muted">Poezi<\/span>/);
  });
});
