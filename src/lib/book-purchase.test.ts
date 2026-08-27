import { describe, expect, it } from "vitest";
import { resolveBookPurchaseState, resolveShowSample, type BookPurchaseState } from "./book-purchase";

describe("resolveBookPurchaseState", () => {
  // Distinct states, not a single collapsed "anonymous" -- a free book
  // must present "Log in to get this book", never "Log in to buy", so
  // the presentation layer needs the price distinction here, not just
  // the auth distinction.
  it("anonymous + paid resolves to anonymous-paid, not the free variant", () => {
    expect(
      resolveBookPurchaseState({ user: null, isAuthor: false, owned: false, priceCents: 999 }),
    ).toBe("anonymous-paid");
  });

  it("anonymous + free resolves to anonymous-free, not the paid variant", () => {
    expect(
      resolveBookPurchaseState({ user: null, isAuthor: false, owned: false, priceCents: 0 }),
    ).toBe("anonymous-free");
  });

  it("reader, unowned, paid", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: false,
        priceCents: 999,
      }),
    ).toBe("paid-unowned");
  });

  it("reader, unowned, free", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: false,
        priceCents: 0,
      }),
    ).toBe("free-unowned");
  });

  it("reader, owned (regardless of price)", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: true,
        priceCents: 999,
      }),
    ).toBe("owned");
  });

  it("author viewing their own book takes precedence over owned", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "author-1" },
        isAuthor: true,
        owned: true,
        priceCents: 999,
      }),
    ).toBe("author");
  });

  it("author viewing their own free book still resolves to author, not free-unowned", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "author-1" },
        isAuthor: true,
        owned: false,
        priceCents: 0,
      }),
    ).toBe("author");
  });
});

// LIBRUM 2.0 PRODUCT-5 EPUB-SAMPLE-AVAILABILITY CORRECTION: a
// production report investigated a published DOCX-converted book
// showing no Read Sample on Book Detail. Root cause: the report's own
// screenshots were the book's AUTHOR viewing their OWN page, where Read
// Sample has ALWAYS been intentionally omitted (PRODUCT-1's own design
// -- an author already has Download EPUB) -- not a defect in DOCX-
// generated EPUBs, the sample extractor, or any DB field PRODUCT-5
// touches. This was previously an untested inline computation directly
// in Book Detail's Server Component; extracted here (alongside
// resolveBookPurchaseState, the same "extract a pure decision function,
// unit-test it directly" pattern this file already establishes) so the
// exact rule is pinned going forward, for every BookPurchaseState, with
// zero dependency on manuscript origin (DOCX vs. direct EPUB) -- there
// is no such input to this function at all, by construction.
describe("resolveShowSample", () => {
  const shown: BookPurchaseState[] = [
    "anonymous-paid",
    "anonymous-free",
    "free-unowned",
    "paid-unowned",
  ];
  const hidden: BookPurchaseState[] = ["author", "owned"];

  it.each(shown)("shows Read Sample for %s", (state) => {
    expect(resolveShowSample(state)).toBe(true);
  });

  it.each(hidden)(
    "omits Read Sample for %s -- already has full access via Download EPUB",
    (state) => {
      expect(resolveShowSample(state)).toBe(false);
    },
  );
});
