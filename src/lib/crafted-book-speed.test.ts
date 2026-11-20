import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildReaderContent } from "./epub-reader";
import { sanitizeReaderBody } from "./reader-content";
import { __internal as sample, countEpubWords } from "./epub-sample";
import { sanitizeFragment } from "./docx-converter";

// Reader speed r2 (20 Nov 2026): book files built on purpose, each of
// which held one request for seconds or minutes before (times measured
// on the old code, this container). Each must now take well under the
// limit below, and still give the same kind of result.

const LIMIT_MS = 3000;
const MB = 1_990_000;

function timed<T>(f: () => T): { ms: number; value: T } {
  const t = performance.now();
  const value = f();
  return { ms: performance.now() - t, value };
}

async function timedAsync<T>(f: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await f();
  return { ms: performance.now() - t, value };
}

const ctx = (images = false) => ({ classRules: new Map(), registerImage: () => (images ? 0 : null), headingCounter: { next: 1 } });
const fill = (start: string, unit: string, end = "") => {
  let s = start;
  while (s.length < MB) s += unit;
  return s + end;
};

describe("reader: crafted chapters", () => {
  it.each([
    // 4.8 s: 63 nested boxes around 240,000 tiny paragraphs.
    ["nested boxes, tiny paragraphs", fill("<div>".repeat(63), "<p>x</p>", "</div>".repeat(63)), false],
    // 2.7 s: boxes that never close.
    ["never-closed boxes", fill("", "<div><p>x</p>"), false],
    // 12.5 s: 63 nested boxes full of pictures.
    ["nested boxes, pictures", fill(`${"<div>".repeat(63)}<p>`, "<img src='a.jpg'/>"), true],
    // 18 s for 5 KB: a tag with a long run of spaces and no `>`.
    ["unclosed tag full of spaces", `<p>a</p><a${" ".repeat(MB)}<p>b</p>`, false],
    ["closed tag full of spaces", `<p>a</p><a x${" ".repeat(MB)}y>b</a>`, false],
    // 14.6 s for 400 KB.
    ["unclosed <?", `<p>a</p>${"<?".repeat(MB / 2)}`, false],
    ["unclosed CDATA", `<p>a</p>${"<![CDATA[".repeat(MB / 9)}`, false],
  ])("%s", (_name, body, images) => {
    const { ms, value } = timed(() => sanitizeReaderBody(body as string, ctx(images as boolean)));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(value.length).toBeGreaterThan(0);
  });

  it("an unclosed <? is still shown as text, as before", () => {
    const html = sanitizeReaderBody("<p>a <? b</p>", ctx())
      .map((c) => c.html)
      .join("");
    expect(html).toBe("<p>a &lt;? b</p>");
  });
});

async function epubWith(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    files.container ??
      `<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    files.opf ??
      `<package version="3.0"><metadata></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
  );
  zip.file("OEBPS/c1.xhtml", files.c1 ?? `<html><head><title>x</title></head><body><p>Fjala e parë.</p></body></html>`);
  if (files.nav) zip.file("OEBPS/nav.xhtml", files.nav);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

describe("whole book: crafted files", () => {
  it.each([
    // 10 s for 0.5 MB: many <body> with no </body>.
    ["many <body>", { c1: `<html><head></head>${"<body>".repeat(MB / 6)}<p>Fjala.</p></html>` }],
    ["many <head>", { c1: `<html>${"<head>".repeat(MB / 6)}<body><p>Fjala.</p></body></html>` }],
    ["style rules with no braces", { c1: `<html><head><style>${"a".repeat(400_000)}</style></head><body><p>Fjala.</p></body></html>` }],
    ["many <link> with no >", { c1: `<html><head>${"<link".repeat(MB / 5)}</head><body><p>Fjala.</p></body></html>` }],
    // r2 (audit F1): ONE long tag; 1 MB took 26 s (cover meta) and 41 s
    // (landmarks) per open before.
    [
      "one long cover <meta> tag",
      {
        opf: `<package version="3.0"><metadata><meta${' name="cover"'.repeat(1_000_000 / 13)}</metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
      },
    ],
    [
      "one long landmarks <nav> tag",
      {
        opf: `<package version="3.0"><metadata></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c1"/></spine></package>`,
        nav: `<html><body><nav epub:type="${"landmarks ".repeat(100_000)}</nav></body></html>`,
      },
    ],
  ])("reader: %s", async (_name, files) => {
    const bytes = await epubWith(files);
    const { ms, value } = await timedAsync(() => buildReaderContent(bytes, "full"));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(value.available).toBe(true);
  });

  it("page count: an unclosed tag full of spaces", async () => {
    const bytes = await epubWith({ c1: `<html><head></head><body><p>Fjala e parë.</p><a${" ".repeat(MB)}</body></html>` });
    const { ms, value } = await timedAsync(() => countEpubWords(bytes));
    expect(ms).toBeLessThan(LIMIT_MS);
    // "<a" itself still counts as a word, as before.
    expect(value).toBe(4);
  });
});

describe("page count: deep nesting", () => {
  it("300,000 boxes that never close", () => {
    const { ms, value } = timed(() => sample.sanitizeBodyIntoChunks(`<span>${"<div>x".repeat(300_000)}</span>`));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(value[0].text.length).toBe(300_000);
  });
});

describe("Word upload: a link address full of spaces", () => {
  it("stays fast", () => {
    const html = `<p><a href="https://example.test/${" ".repeat(MB)}x">link</a></p>`;
    const { ms, value } = timed(() => sanitizeFragment(html, () => null, () => {}));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(value).toContain("link");
  });
});
