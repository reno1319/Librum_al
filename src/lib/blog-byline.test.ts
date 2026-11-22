import { describe, expect, it } from "vitest";
import { blogBylineName, blogJsonLdAuthor } from "./blog-byline";

describe("blogBylineName (au2 a)", () => {
  it("shows a typed name on any article", () => {
    expect(blogBylineName({ author_name: "Arben Hoxha", is_editorial: false })).toBe("Arben Hoxha");
    expect(blogBylineName({ author_name: "Arben Hoxha", is_editorial: true })).toBe("Arben Hoxha");
  });
  it("with no name: Editorial shows Librum, others none", () => {
    expect(blogBylineName({ author_name: null, is_editorial: true })).toBe("Librum");
    expect(blogBylineName({ author_name: null, is_editorial: false })).toBeNull();
    expect(blogBylineName({ is_editorial: false })).toBeNull();
    expect(blogBylineName({ author_name: "  ", is_editorial: false })).toBeNull();
  });
});

describe("blogJsonLdAuthor (au3)", () => {
  it("a typed name is a Person", () => {
    expect(blogJsonLdAuthor({ author_name: "Arben Hoxha", is_editorial: true })).toEqual({
      "@type": "Person",
      name: "Arben Hoxha",
    });
  });
  it("with no name: Editorial keeps Librum Editorial, others none", () => {
    expect(blogJsonLdAuthor({ author_name: null, is_editorial: true })).toEqual({
      "@type": "Organization",
      name: "Librum Editorial",
    });
    expect(blogJsonLdAuthor({ author_name: null, is_editorial: false })).toBeNull();
  });
});
