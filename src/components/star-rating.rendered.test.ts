import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { StarRating } from "./star-rating";

// LC2 (Renato 11-25): the book page's stars are gold, the same colours
// as the Libraria cards' Stars (store-book-card.tsx).
describe("StarRating", () => {
  it("draws the filled stars gold and the rest in the cards' empty colour", () => {
    const html = renderToStaticMarkup(createElement(StarRating, { rating: 4 }));
    expect(html).toContain('<span class="text-[#d99a00]">★★★★</span>');
    expect(html).toContain('<span class="text-[#d8d0be]">★</span>');
    expect(html).not.toContain("text-primary");
    expect(html).toContain('aria-label="4 nga 5 yje"');
  });
});
