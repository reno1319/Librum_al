import { describe, expect, it } from "vitest";
import { decodeEntities, marksInChapter, parseChapterXhtml, scopeStylesheet, textOf, type PreviewElement } from "./ebook-preview-html";

const page = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title><style>p{}</style></head><body>\n${body}\n</body></html>`;
const el = (n: unknown) => n as PreviewElement;

describe("parseChapterXhtml", () => {
  it("keeps the ebook's own tags, classes, marks and pictures", () => {
    const nodes = parseChapterXhtml(
      page(`<h1>Kapitulli 1<br/>Mëngjesi</h1><p><span data-p="3"></span>Ai tha &amp; iku.</p><p class="scene-break"><span data-s="5"></span>* * *</p><p><img src="images/img-1.png" alt="Liqeni"/></p>`),
    ).filter((n) => typeof n !== "string");
    expect(nodes.map((n) => el(n).tag)).toEqual(["h1", "p", "p", "p"]);
    expect(el(el(nodes[0]).children[1]).tag).toBe("br");
    expect(el(el(nodes[1]).children[0]).attrs).toEqual({ "data-p": "3" });
    expect(textOf(nodes[1])).toBe("Ai tha & iku.");
    expect(el(nodes[2]).attrs).toEqual({ class: "scene-break" });
    expect(el(el(nodes[3]).children[0]).attrs).toEqual({ src: "images/img-1.png", alt: "Liqeni" });
  });

  it("drops scripts, event handlers, styles, foreign pictures and unknown attributes", () => {
    const nodes = parseChapterXhtml(
      page(`<p onclick="x()" style="color:red" class="evil">A<script>alert(1)</script><iframe src="https://x"></iframe></p><img src="https://evil/x.png"/><img src="javascript:alert(1)"/><span data-p="1 onmouseover=x">B</span><a href="javascript:alert(1)" onclick="y">C</a><svg><script>z</script></svg><div>D</div>`),
    );
    const json = JSON.stringify(nodes);
    expect(json).not.toMatch(/alert|onclick|style|evil|javascript|onmouseover|iframe|svg|https/);
    expect(nodes.map(textOf).join("")).toContain("A");
    expect(nodes.map(textOf).join("")).toContain("D");
    expect(el(nodes.find((n) => typeof n !== "string" && n.tag === "span")).attrs).toEqual({});
  });

  it("survives broken markup without throwing", () => {
    expect(() => parseChapterXhtml(page("<p><em>a</p></em><<<>>&#xFFFFFF;&#0;</b>"))).not.toThrow();
    expect(parseChapterXhtml("no body here")).toEqual([]);
  });
});

describe("helpers", () => {
  it("decodes entities, refusing invalid code points", () => {
    expect(decodeEntities("&lt;a&gt; &#235; &#xE7; &nbsp;&#0;&#xD800;&bogus;")).toBe("<a> ë ç  &bogus;");
  });

  it("finds the Word paragraph numbers in a chapter", () => {
    expect(marksInChapter('<p><span data-p="2"></span>x</p><p class="scene-break"><span data-s="4"></span>').paragraphs).toEqual([2]);
    expect(marksInChapter('<span data-s="4"></span>').sceneBreaks).toEqual([4]);
  });

  it("scopes the ebook stylesheet to the preview box and drops unsafe rules", () => {
    const css = `body { font-family: serif; }\nh1 + p, body > p:first-child { text-indent: 0; }\np { background: url(https://x) }\n@import "x";\nimg { max-width: 100%; }`;
    expect(scopeStylesheet(css, ".box")).toBe(
      ".box { font-family: serif; }\n.box h1 + p, .box > p:first-child { text-indent: 0; }\n.box img { max-width: 100%; }",
    );
  });
});
