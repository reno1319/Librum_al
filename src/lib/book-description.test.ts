import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX_CHARACTERS,
  DESCRIPTION_TOO_LONG_MESSAGE,
  descriptionFromEditorDom,
  descriptionPlainText,
  descriptionToEditorHtml,
  normalizeDescription,
  parseDescription,
  serializeDescription,
  type EditorNode,
} from "./book-description";

// A tiny stand-in for the browser DOM: only what the reader uses.
function el(tag: string, children: (EditorNode | string)[] = [], style?: string): EditorNode {
  const childNodes = children.map((c) => (typeof c === "string" ? text(c) : c));
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    textContent: childNodes.map((c) => c.textContent ?? "").join(""),
    childNodes,
    getAttribute: (name: string) => (name === "style" ? (style ?? null) : null),
  };
}
function text(value: string): EditorNode {
  return { nodeType: 3, nodeName: "#text", textContent: value, childNodes: [] };
}
function root(children: (EditorNode | string)[]): EditorNode {
  return el("div", children);
}

describe("parseDescription / serializeDescription", () => {
  it("reads paragraphs, line breaks, bullets and numbered items", () => {
    const blocks = parseDescription("Hyrje\nrreshti dy\n\n- një\n- dy\n\n1. a\n2. b\n\nFund");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "bullets", "numbers", "paragraph"]);
    expect(serializeDescription(blocks)).toBe("Hyrje\nrreshti dy\n\n- një\n- dy\n\n1. a\n2. b\n\nFund");
  });

  it("reads bold, italic and both, and writes them back the same way", () => {
    const stored = "Një **fjalë e trashë**, një *e pjerrët* dhe ***të dyja***.";
    const [block] = parseDescription(stored);
    expect(block.kind).toBe("paragraph");
    if (block.kind !== "paragraph") return;
    expect(block.lines[0]).toEqual([
      { text: "Një ", bold: false, italic: false },
      { text: "fjalë e trashë", bold: true, italic: false },
      { text: ", një ", bold: false, italic: false },
      { text: "e pjerrët", bold: false, italic: true },
      { text: " dhe ", bold: false, italic: false },
      { text: "të dyja", bold: true, italic: true },
      { text: ".", bold: false, italic: false },
    ]);
    expect(serializeDescription(parseDescription(stored))).toBe(stored);
  });

  it("ends formatting left open at the end of its line", () => {
    expect(serializeDescription(parseDescription("**pa mbyllur\ntjetër"))).toBe("**pa mbyllur**\ntjetër");
  });

  it("keeps a literal star, backslash, leading dash and leading number as text", () => {
    const blocks = [
      {
        kind: "paragraph" as const,
        lines: [
          [{ text: "5 * 3 = 15 \\ ok", bold: false, italic: false }],
          [{ text: "- jo listë", bold: false, italic: false }],
          [{ text: "1. jo listë", bold: false, italic: false }],
        ],
      },
    ];
    const stored = serializeDescription(blocks);
    expect(stored).toBe("5 \\* 3 = 15 \\\\ ok\n\\- jo listë\n1\\. jo listë");
    expect(parseDescription(stored)).toEqual(blocks);
    expect(descriptionPlainText(stored)).toBe("5 * 3 = 15 \\ ok\n- jo listë\n1. jo listë");
  });

  it("renumbers numbered items and drops empty lines and items", () => {
    expect(serializeDescription(parseDescription("7. a\n9. b\n- \n\n\n\n   \nfund  "))).toBe("1. a\n2. b\n\nfund");
  });

  it("drops control characters and turns CRLF into line breaks", () => {
    expect(serializeDescription(parseDescription("a\r\nb\u0007c\u2028d"))).toBe("a\nbc\nd");
  });

  it("has no syntax for links, images, headings or HTML: they stay plain text", () => {
    const stored = normalizeDescription('# Titull\n[lidhje](https://x.example) ![i](y) <script>alert(1)</script> <b onclick="x">');
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const html = descriptionToEditorHtml(stored.value);
    expect(html).not.toMatch(/<(script|a|img|h1|b)[\s>]/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b onclick=&quot;x&quot;&gt;");
  });
});

describe("normalizeDescription", () => {
  it("stores the canonical form", () => {
    expect(normalizeDescription("  - a\n-   b  \n\n\n**x**  ")).toEqual({ ok: true, value: "- a\n- b\n\n**x**" });
  });

  it("allows empty (a draft) and treats a non-string as empty", () => {
    expect(normalizeDescription("")).toEqual({ ok: true, value: "" });
    expect(normalizeDescription(null)).toEqual({ ok: true, value: "" });
  });

  it("counts visible characters only, up to the limit", () => {
    const full = "a".repeat(DESCRIPTION_MAX_CHARACTERS);
    expect(normalizeDescription(`**${full}**`)).toEqual({ ok: true, value: `**${full}**` });
    expect(normalizeDescription(`${full}b`)).toEqual({ ok: false, message: DESCRIPTION_TOO_LONG_MESSAGE });
    expect(DESCRIPTION_TOO_LONG_MESSAGE).toBe("Përshkrimi mund të ketë deri në 4.000 karaktere.");
  });
});

describe("editor round trip", () => {
  it("fills the editor with escaped HTML of the allowed tags only", () => {
    expect(descriptionToEditorHtml("a & b\nc\n\n- **x**\n\n1. *y*")).toBe(
      "<p>a &amp; b<br>c</p><ul><li><strong>x</strong></li></ul><ol><li><em>y</em></li></ol>",
    );
  });

  it("reads back what the editor shows", () => {
    const dom = root([
      el("p", ["a & b", el("br"), "c"]),
      el("ul", [el("li", [el("strong", ["x"])])]),
      el("ol", [el("li", [el("em", ["y"])])]),
    ]);
    expect(descriptionFromEditorDom(dom)).toBe("a & b\nc\n\n- **x**\n\n1. *y*");
  });

  it("reads browser-made markup: divs, b/i tags, inline styles, nbsp", () => {
    const dom = root([
      "Rreshti i parë",
      el("div", ["i ", el("b", ["dyti"])]),
      el("div", [el("span", ["stil"], "font-weight: 700"), " dhe ", el("span", ["pjerrët"], "font-style: italic")]),
      el("div", [el("br")]),
      el("div", ["tjetër\u00a0paragraf"]),
    ]);
    expect(descriptionFromEditorDom(dom)).toBe("Rreshti i parë\n\ni **dyti**\n\n**stil** dhe *pjerrët*\n\ntjetër paragraf");
  });

  it("keeps only text from a paste: links, images, scripts and headings lose their markup", () => {
    const dom = root([
      el("h1", ["Titull"]),
      el("p", [el("a", ["lidhje"]), " ", el("img"), el("script", ["alert(1)"]), "fund"]),
      el("ul", [el("li", ["a"]), el("ul", [el("li", ["e futur"])]), el("li", ["b"])]),
    ]);
    expect(descriptionFromEditorDom(dom)).toBe("Titull\n\nlidhje fund\n\n- a\n- e futur\n- b");
  });

  it("escapes stars an author typed", () => {
    expect(descriptionFromEditorDom(root([el("p", ["5 * 3"])]))).toBe("5 \\* 3");
  });

  it("round-trips through the editor unchanged", () => {
    const stored = "Hyrje me **të trashë**\n*pjerrët*\n\n- një\n- dy\n\n1. a\n2. b";
    const dom = root([
      el("p", ["Hyrje me ", el("strong", ["të trashë"]), el("br"), el("em", ["pjerrët"])]),
      el("ul", [el("li", ["një"]), el("li", ["dy"])]),
      el("ol", [el("li", ["a"]), el("li", ["b"])]),
    ]);
    expect(descriptionToEditorHtml(stored)).toBe(
      "<p>Hyrje me <strong>të trashë</strong><br><em>pjerrët</em></p><ul><li>një</li><li>dy</li></ul><ol><li>a</li><li>b</li></ol>",
    );
    expect(descriptionFromEditorDom(dom)).toBe(stored);
  });
});

// Audit r1 (F1, F3): markers only where formatting changes; stable.
describe("canonical form is stable", () => {
  it("keeps bold inside italic and italic inside bold", () => {
    const nested = root([el("p", [el("em", ["a", el("strong", ["b"])]), " c"])]);
    const stored = descriptionFromEditorDom(nested);
    expect(stored).toBe("*a**b*** c");
    const [block] = parseDescription(stored);
    expect(block.kind === "paragraph" && block.lines[0]).toEqual([
      { text: "a", bold: false, italic: true },
      { text: "b", bold: true, italic: true },
      { text: " c", bold: false, italic: false },
    ]);
  });

  it("normalize is idempotent on random input", () => {
    const alphabet = ["*", "**", "\\", "-", "- ", "1. ", "12\\.", "\n", "\n\n", " ", "a", "ë", "b", " ", "\u0007"];
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 5000; i++) {
      let input = "";
      const n = Math.floor(rand() * 20);
      for (let j = 0; j < n; j++) input += alphabet[Math.floor(rand() * alphabet.length)];
      const once = normalizeDescription(input);
      if (!once.ok) continue;
      expect(normalizeDescription(once.value)).toEqual(once);
    }
  });

  it("a numbered list longer than 999 items reads back as a list", () => {
    const stored = Array.from({ length: 1001 }, (_, i) => `${i + 1}. x`).join("\n");
    const blocks = parseDescription(stored);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("numbers");
    expect(serializeDescription(blocks)).toBe(stored);
  });
});
