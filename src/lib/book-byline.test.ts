import { describe, expect, it } from "vitest";
import { BOOK_PEN_NAME_EMBED, resolveBookByline } from "./book-byline";

// PEN-NAMES-1: the byline is the book's pen name, read through the
// public_pen_names view embed -- never an account column.
describe("resolveBookByline", () => {
  it("shows the embedded pen name", () => {
    expect(resolveBookByline({ pen: { id: "p1", name: "Ëngjëll Çela" } })).toBe("Ëngjëll Çela");
  });

  it("a missing embed is null, never an account name", () => {
    expect(resolveBookByline({ pen: null })).toBeNull();
    expect(resolveBookByline({})).toBeNull();
  });

  it("no book: null, never throws", () => {
    expect(resolveBookByline(null)).toBeNull();
    expect(resolveBookByline(undefined)).toBeNull();
  });

  it("the embed reads the view with no author_id", () => {
    expect(BOOK_PEN_NAME_EMBED).toBe("pen:public_pen_names(id, name)");
    expect(BOOK_PEN_NAME_EMBED).not.toMatch(/author/);
  });
});
