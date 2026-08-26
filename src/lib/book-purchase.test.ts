import { describe, expect, it } from "vitest";
import { resolveBookPurchaseState } from "./book-purchase";

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
