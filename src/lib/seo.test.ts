import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bookPagePath,
  buildBookJsonLd,
  bundlePagePath,
  serializeJsonLd,
  seriesPagePath,
  siteOriginOrNull,
} from "@/lib/seo";

const ORIGIN = "https://librum.al";
const BOOK: Parameters<typeof buildBookJsonLd>[0] = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Kronikë në gur",
  subtitle: null,
  description: "Një roman.",
  isbn: "978-3-16-148410-0",
  language: "sq",
  publisher: null,
  genre: "Letërsi artistike",
  published_at: "2026-09-02T10:00:00Z",
  price_all: 499,
};
const PEN = { id: "00000000-0000-4000-8000-0000000000aa", name: "Ana Shkrimtarja" };

function build(overrides: Partial<typeof BOOK> = {}, opts: { paidCheckoutOn?: boolean; pen?: typeof PEN | null } = {}) {
  return buildBookJsonLd(
    { ...BOOK, ...overrides },
    {
      origin: ORIGIN,
      coverUrl: "https://cdn.example/cover.png",
      pen: opts.pen === undefined ? PEN : opts.pen,
      paidCheckoutOn: opts.paidCheckoutOn ?? false,
    },
  );
}

describe("page paths", () => {
  it("are the Albanian addresses", () => {
    expect(bookPagePath("b1")).toBe("/libra/b1");
    expect(seriesPagePath("s1")).toBe("/seri/s1");
    expect(bundlePagePath("p1")).toBe("/paketa/p1");
  });
});

describe("buildBookJsonLd", () => {
  it("describes the e-book at its /libra/<id> address", () => {
    const data = build();
    expect(data["@type"]).toBe("Book");
    expect(data.url).toBe(`${ORIGIN}/libra/${BOOK.id}`);
    expect(data.name).toBe("Kronikë në gur");
    expect(data.bookFormat).toBe("https://schema.org/EBook");
    expect(data.inLanguage).toBe("sq");
    expect(data.isbn).toBe("9783161484100");
    expect(data.image).toBe("https://cdn.example/cover.png");
    expect(data.datePublished).toBe("2026-09-02");
  });

  it("names the pen name and links to its /autore/<pen name id> page", () => {
    expect(build().author).toEqual({
      "@type": "Person",
      name: "Ana Shkrimtarja",
      url: `${ORIGIN}/autore/${PEN.id}`,
    });
  });

  it("has no author when the book has no public pen name", () => {
    expect(build({}, { pen: null })).not.toHaveProperty("author");
  });

  it("has no price while paid checkout is off (1a)", () => {
    expect(build()).not.toHaveProperty("offers");
  });

  it("has the lek price once paid checkout is on", () => {
    expect(build({}, { paidCheckoutOn: true }).offers).toEqual({
      "@type": "Offer",
      url: `${ORIGIN}/libra/${BOOK.id}`,
      price: 499,
      priceCurrency: "ALL",
      availability: "https://schema.org/InStock",
    });
  });

  it("never has a price for a free or unpriced book", () => {
    expect(build({ price_all: 0 }, { paidCheckoutOn: true })).not.toHaveProperty("offers");
    expect(build({ price_all: null }, { paidCheckoutOn: true })).not.toHaveProperty("offers");
  });

  it("leaves out empty fields, an invalid ISBN and an unknown language code", () => {
    const data = build({ description: "", isbn: "12345", language: "xx", genre: null, published_at: null });
    for (const key of ["description", "isbn", "inLanguage", "genre", "datePublished"]) {
      expect(data).not.toHaveProperty(key);
    }
  });
});

describe("serializeJsonLd", () => {
  it("can't close the script tag, whatever the author typed", () => {
    const json = serializeJsonLd(build({ title: '</script><script>alert(1)</script> & "x"\u2028' }));
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    expect(json).not.toContain("&");
    expect(json).not.toContain("\u2028");
    expect(JSON.parse(json).name).toBe('</script><script>alert(1)</script> & "x"\u2028');
  });
});

describe("siteOriginOrNull", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured origin", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librum.al/");
    expect(siteOriginOrNull()).toBe("https://librum.al");
  });

  it("returns null instead of throwing when the origin can't be resolved", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    expect(siteOriginOrNull()).toBeNull();
  });
});
