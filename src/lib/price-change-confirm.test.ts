import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  PRICE_CHANGE_CONFIRM_FIELD,
  isLivePriceChange,
  isPriceChangeConfirmed,
  priceChangeConfirmText,
} from "./price-change-confirm";
import { PriceChangeConfirm } from "@/components/price-change-confirm";

// LIVE-PRICE-CONFIRM-1: the shared rule and sentence. The Server Actions'
// use of it is tested in dashboard/paid-repricing-guards.test.ts.

describe("isLivePriceChange", () => {
  it.each([
    ["published, paid -> other paid", "published", 199, 299, true],
    ["published, paid -> free", "published", 199, 0, true],
    ["published, no price -> free", "published", null, 0, true],
    ["published, same price", "published", 199, 199, false],
    ["draft, new price", "draft", 199, 299, false],
    ["unknown status", undefined, 199, 299, false],
  ] as const)("%s", (_label, status, current, submitted, expected) => {
    expect(isLivePriceChange({ status, currentPriceAll: current, submittedPriceAll: submitted })).toBe(expected);
  });
});

describe("isPriceChangeConfirmed", () => {
  const form = (value?: string) => {
    const fd = new FormData();
    if (value !== undefined) fd.set(PRICE_CHANGE_CONFIRM_FIELD, value);
    return fd;
  };

  it("accepts only the exact new price", () => {
    expect(isPriceChangeConfirmed(form("299"), 299)).toBe(true);
    expect(isPriceChangeConfirmed(form("0"), 0)).toBe(true);
    expect(isPriceChangeConfirmed(form(), 299)).toBe(false);
    expect(isPriceChangeConfirmed(form("on"), 299)).toBe(false);
    expect(isPriceChangeConfirmed(form("250"), 299)).toBe(false);
    expect(isPriceChangeConfirmed(form("299.0"), 299)).toBe(false);
  });
});

describe("priceChangeConfirmText", () => {
  it("names the old and new price in plain words", () => {
    expect(priceChangeConfirmText(500, 300)).toBe(
      "Po, ndryshojeni çmimin në 300 lekë (deri tani: 500 lekë). Lexuesit e shohin çmimin e ri menjëherë.",
    );
    expect(priceChangeConfirmText(500, 0)).toBe(
      "Po, bëjeni falas (deri tani: 500 lekë). Lexuesit e shohin çmimin e ri menjëherë.",
    );
    expect(priceChangeConfirmText(null, 0)).toBe(
      "Po, bëjeni falas (deri tani: pa çmim). Lexuesit e shohin çmimin e ri menjëherë.",
    );
    // ALBANIAN-9: thousands with a dot, like every other price.
    expect(priceChangeConfirmText(1500, 12000)).toBe(
      "Po, ndryshojeni çmimin në 12.000 lekë (deri tani: 1.500 lekë). Lexuesit e shohin çmimin e ri menjëherë.",
    );
  });
});

describe("PriceChangeConfirm", () => {
  it("renders no tick before the price is changed (server HTML)", () => {
    const html = renderToStaticMarkup(createElement(PriceChangeConfirm, { currentPriceAll: 199 }));
    expect(html).toBe("<div></div>");
  });
});

describe("the Edit pages show the tick only for a live book or bundle", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");

  it("book Edit page", () => {
    const source = read("src/app/(public)/dashboard/books/[id]/edit/page.tsx");
    expect(source).toContain("{isLive && <PriceChangeConfirm currentPriceAll={book.price_all ?? null} />}");
    expect(source).toContain('const isLive = book.status === "published";');
  });

  it("bundle Edit page, which now reads the bundle's status", () => {
    const source = read("src/app/(public)/dashboard/bundles/[id]/edit/page.tsx");
    expect(source).toContain(
      '{bundle.status === "published" && <PriceChangeConfirm currentPriceAll={bundle.price_all ?? null} />}',
    );
    expect(source).toContain('.select("id, author_id, title, description, price_all, pen_name_id, status")');
  });
});
