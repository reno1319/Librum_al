import { describe, expect, it } from "vitest";
import { applyFormat, insertImage } from "./markdown-format";

describe("applyFormat", () => {
  it("bold and italic wrap the selection, or a placeholder", () => {
    expect(applyFormat("një fjalë", 4, 9, "bold")).toEqual({ text: "një **fjalë**", selectionStart: 6, selectionEnd: 11 });
    expect(applyFormat("ab", 1, 1, "italic").text).toBe("a*tekst i pjerrët*b");
    expect(applyFormat("një fjalë tjetër", 4, 10, "bold").text).toBe("një **fjalë** tjetër");
  });

  it("headings, lists and quotes prefix every touched line, and toggle off", () => {
    expect(applyFormat("a\nb\nc", 2, 3, "h2").text).toBe("a\n## b\nc");
    expect(applyFormat("a\n## b\nc", 3, 3, "h2").text).toBe("a\nb\nc");
    expect(applyFormat("a\nb", 0, 3, "ul").text).toBe("- a\n- b");
    expect(applyFormat("a\nb", 0, 3, "ol").text).toBe("1. a\n2. b");
    expect(applyFormat("- a\n- b", 0, 7, "quote").text).toBe("> a\n> b");
    expect(applyFormat("## a", 0, 4, "h3").text).toBe("### a");
  });

  it("link wraps the text and selects the address", () => {
    const r = applyFormat("shih këtu", 5, 9, "link");
    expect(r.text).toBe("shih [këtu](https://)");
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe("https://");
  });

  it("out-of-range or reversed selections are clamped", () => {
    expect(applyFormat("abc", 10, -1, "bold").text).toBe("**abc**");
  });
});

describe("insertImage", () => {
  it("puts the image in its own paragraph with the caption as alt and title", () => {
    const r = insertImage("Para.\nPas.", 5, "https://x/blog/inline/a.jpg", ' Tryeza "ime" [1] ');
    expect(r.text).toBe('Para.\n\n![Tryeza "ime" \\[1\\]](https://x/blog/inline/a.jpg "Tryeza \\"ime\\" [1]")\n\nPas.');
  });
  it("no caption, empty text", () => {
    expect(insertImage("", 0, "https://x/a.jpg", "  ").text).toBe("![](https://x/a.jpg)\n");
  });
});
