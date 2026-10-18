import { describe, expect, it } from "vitest";
import { resolveBookByline } from "./book-byline";

describe("resolveBookByline", () => {
  const profile = { display_name: "Renato Kalemi", public_author_name: "Arben Leka" };

  it("a book with a pen name shows the pen name, not the author's public name", () => {
    expect(resolveBookByline({ pen_name: "Ëngjëll Çela" }, profile)).toBe("Ëngjëll Çela");
  });

  it("a null pen name falls back to the author's public name", () => {
    expect(resolveBookByline({ pen_name: null }, profile)).toBe("Arben Leka");
  });

  it("a row read before the migration (no pen_name key) behaves like null", () => {
    expect(resolveBookByline({}, profile)).toBe("Arben Leka");
  });

  it("falls back through public_author_name to display_name, as today", () => {
    expect(
      resolveBookByline({ pen_name: null }, { display_name: "Renato Kalemi", public_author_name: null }),
    ).toBe("Renato Kalemi");
  });

  it("a view-shaped profile (no display_name) never recovers a private name", () => {
    expect(resolveBookByline({ pen_name: null }, { public_author_name: null })).toBeNull();
  });

  it("the pen name wins even when no profile was loaded", () => {
    expect(resolveBookByline({ pen_name: "Jo Pen" }, null)).toBe("Jo Pen");
  });

  it("no book and no profile: null, never throws", () => {
    expect(resolveBookByline(null, undefined)).toBeNull();
  });
});
