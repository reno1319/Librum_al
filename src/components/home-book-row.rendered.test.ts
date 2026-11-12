import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeBookRow } from "./home-book-row";

// HOME-ROWS-1 audit M1: the ❮ ❯ buttons switch off with aria-disabled,
// never the disabled attribute (which drops keyboard focus to <body>
// when the row reaches its end).
describe("HomeBookRow arrow buttons", () => {
  it("are marked aria-disabled, not disabled, and stay focusable", () => {
    const html = renderToStaticMarkup(
      createElement(HomeBookRow, {
        id: "row",
        header: "Botuar me Librum",
        label: "Librat",
        showPrice: false,
        books: [{ id: "b1", title: "T", author: null, genre: null, isAdult: false, url: "https://cdn.example/x.png", priceAll: null }],
      }),
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).toContain('aria-disabled="true"');
      expect(b).not.toMatch(/\sdisabled(=|\s|>)/);
      expect(b).toContain("aria-disabled:text-muted");
    }
  });
});
