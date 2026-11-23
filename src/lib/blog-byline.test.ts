import { describe, expect, it } from "vitest";
import { blogBylineName, blogJsonLdAuthor } from "./blog-byline";

describe("blogBylineName (au2 reversed 2026-11-23)", () => {
  it("shows a typed name on any article", () => {
    expect(blogBylineName({ author_name: "Arben Hoxha", is_editorial: false })).toBe("Arben Hoxha");
    expect(blogBylineName({ author_name: "Arben Hoxha", is_editorial: true })).toBe("Arben Hoxha");
  });
  it("with no name: every article shows Librum, Editorial or not", () => {
    expect(blogBylineName({ author_name: null, is_editorial: true })).toBe("Librum");
    expect(blogBylineName({ author_name: null, is_editorial: false })).toBe("Librum");
    expect(blogBylineName({ is_editorial: false })).toBe("Librum");
    expect(blogBylineName({ author_name: "", is_editorial: false })).toBe("Librum");
    expect(blogBylineName({ author_name: "  ", is_editorial: false })).toBe("Librum");
  });
});

describe("blogJsonLdAuthor (au3)", () => {
  it("a typed name is a Person", () => {
    expect(blogJsonLdAuthor({ author_name: "Arben Hoxha", is_editorial: true })).toEqual({
      "@type": "Person",
      name: "Arben Hoxha",
    });
  });
  it("with no name: Editorial keeps Librum Editorial, others Librum", () => {
    expect(blogJsonLdAuthor({ author_name: null, is_editorial: true })).toEqual({
      "@type": "Organization",
      name: "Librum Editorial",
    });
    expect(blogJsonLdAuthor({ author_name: null, is_editorial: false })).toEqual({
      "@type": "Organization",
      name: "Librum",
    });
    expect(blogJsonLdAuthor({ author_name: "  ", is_editorial: false })).toEqual({
      "@type": "Organization",
      name: "Librum",
    });
  });
});
