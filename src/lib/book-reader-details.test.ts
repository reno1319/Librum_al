import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  bookCategories,
  bundleIsAdult,
  categoriesLabel,
  descriptionSnippet,
  editionValue,
  isYoungReaderBook,
  readingAgeValue,
} from "./book-reader-details";
import { BookCard } from "@/components/book-card";
import { BookDescriptionView } from "@/components/book-description-view";

describe("BD15 P8 reader details", () => {
  it("bookCategories keeps saved order, drops blanks and repeats, falls back to genre", () => {
    expect(bookCategories({ categories: ["Fantazi", "Romancë", "Fantazi", ""], genre: "Fantazi" })).toEqual(["Fantazi", "Romancë"]);
    expect(bookCategories({ categories: null, genre: "Poezi" })).toEqual(["Poezi"]);
    expect(bookCategories({ categories: [], genre: null })).toEqual([]);
    expect(categoriesLabel(1)).toBe("Zhanri");
    expect(categoriesLabel(3)).toBe("Zhanret");
  });

  it("isYoungReaderBook is true for either young-reader category in any position", () => {
    expect(isYoungReaderBook({ categories: ["Fantazi", "Për të rinj"] })).toBe(true);
    expect(isYoungReaderBook({ categories: null, genre: "Për fëmijë" })).toBe(true);
    expect(isYoungReaderBook({ categories: ["Fantazi"] })).toBe(false);
  });

  it("readingAgeValue: N+ vjeç, nothing for 18+ books or no age", () => {
    expect(readingAgeValue({ reading_age_min: 12, is_adult: false })).toBe("12+ vjeç");
    expect(readingAgeValue({ reading_age_min: 18, is_adult: true })).toBeNull();
    expect(readingAgeValue({ reading_age_min: null })).toBeNull();
  });

  it("editionValue: the number, else the old text, else nothing", () => {
    expect(editionValue({ edition_number: 3, edition: "x" })).toBe("3");
    expect(editionValue({ edition_number: null, edition: "  Botim i dytë " })).toBe("Botim i dytë");
    expect(editionValue({ edition_number: null, edition: " " })).toBeNull();
    expect(editionValue({ edition_number: 0, edition: null })).toBeNull();
  });

  it("bundleIsAdult counts only published, readable members", () => {
    expect(bundleIsAdult([{ books: { status: "published", is_adult: true } }])).toBe(true);
    expect(bundleIsAdult([{ books: { status: "draft", is_adult: true } }, { books: null }])).toBe(false);
    expect(bundleIsAdult([{ books: { status: "published", is_adult: false } }])).toBe(false);
    expect(bundleIsAdult(null)).toBe(false);
  });

  it("descriptionSnippet is the plain text on one line", () => {
    expect(descriptionSnippet("A **b** *c*\nd\n\n1. e\n2. f")).toBe("A b c d 1. e 2. f");
    expect(descriptionSnippet(null)).toBe("");
  });
});

describe("BD15 P8: BookCard 18+ tag (Q1 a)", () => {
  const BOOK = { id: "b", title: "T", genre: "Fantazi", price_all: 0, pen_name_id: undefined, original_author: null };
  it("an 18+ book's card carries the tag, with words for screen readers", () => {
    const html = renderToStaticMarkup(createElement(BookCard, { book: { ...BOOK, is_adult: true }, coverUrl: null }));
    expect(html).toContain('aria-hidden="true">18+</span>');
    expect(html).toContain("Për të rritur");
  });
  it("other cards have none", () => {
    expect(renderToStaticMarkup(createElement(BookCard, { book: { ...BOOK, is_adult: false }, coverUrl: null }))).not.toContain("18+");
    expect(renderToStaticMarkup(createElement(BookCard, { book: BOOK, coverUrl: null }))).not.toContain("18+");
  });
});

describe("BD15 P8: BookDescriptionView", () => {
  it("draws lists and line breaks, escapes everything else, and draws nothing for an empty text", () => {
    const html = renderToStaticMarkup(createElement(BookDescriptionView, { stored: "a\nb <img src=x>\n\n1. one\n2. two" }));
    expect(html).toBe('<div><p class="mt-3 first:mt-0">a<br/>b &lt;img src=x&gt;</p><ol class="mt-3 list-decimal pl-6 first:mt-0"><li>one</li><li>two</li></ol></div>');
    expect(renderToStaticMarkup(createElement(BookDescriptionView, { stored: "  \n\n " }))).toBe("");
  });
});
