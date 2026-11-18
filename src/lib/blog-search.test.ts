import { describe, expect, it } from "vitest";
import { parseBlogSearchQuery } from "./blog-search";

describe("parseBlogSearchQuery", () => {
  it("missing, repeated or blank means no search", () => {
    expect(parseBlogSearchQuery(undefined)).toEqual({ display: "", term: null });
    expect(parseBlogSearchQuery(["a", "b"])).toEqual({ display: "", term: null });
    expect(parseBlogSearchQuery("   ")).toEqual({ display: "", term: null });
  });

  it("keeps the reader's text (spaces tidied) for display, and the words for the search", () => {
    expect(parseBlogSearchQuery("  vetë-botim   çmimi ")).toEqual({ display: "vetë-botim çmimi", term: "vetë-botim çmimi" });
  });

  it("drops LIKE/PostgREST wildcards so text can never widen the match", () => {
    expect(parseBlogSearchQuery("%").term).toBeNull();
    expect(parseBlogSearchQuery("a_b*c\\d%").term).toBe("a b c d");
  });

  it("de-duplicates words (ignoring capitals) and keeps at most 5", () => {
    expect(parseBlogSearchQuery("Libër libër LIBËR").term).toBe("Libër");
    expect(parseBlogSearchQuery("a b c d e f g").term).toBe("a b c d e");
  });

  it("caps the text at 100 characters", () => {
    const { display } = parseBlogSearchQuery("x".repeat(150));
    expect(display).toHaveLength(100);
  });
});

