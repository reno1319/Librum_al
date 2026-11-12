import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import sharp from "sharp";
import { buildReaderContent, countWords, FRONT_MATTER_FREE_MAX_WORDS, SAMPLE_MAX_WORDS, trimInsideBlock } from "./epub-reader";
import { parseCssClassRules, sanitizeReaderBody, READER_CLASSES, READER_TAGS } from "./reader-content";

// PREVIEW-READER-1: the readers' sample and the author's full preview.

function clean(body: string, css = "") {
  let n = 0;
  return sanitizeReaderBody(body, {
    classRules: parseCssClassRules(css),
    headingCounter: { next: 1 },
    registerImage: (src) => (src.startsWith("ok") ? n++ : null),
  })
    .map((c) => c.html)
    .join("");
}

const xhtml = (body: string, head = "") => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title>${head}</head><body>${body}</body></html>`;

type Doc = { id: string; href: string; body: string; head?: string };

async function epub(opts: {
  docs: Doc[];
  extraManifest?: string;
  files?: Record<string, Buffer | string>;
  nav?: string;
  guide?: string;
  meta?: string;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  const items = opts.docs.map((d) => `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`).join("");
  const navItem = opts.nav ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` : "";
  zip.file(
    "OEBPS/content.opf",
    `<package version="3.0"><metadata>${opts.meta ?? ""}</metadata><manifest>${items}${navItem}${opts.extraManifest ?? ""}</manifest><spine>${opts.docs
      .map((d) => `<itemref idref="${d.id}"/>`)
      .join("")}</spine>${opts.guide ?? ""}</package>`,
  );
  for (const d of opts.docs) zip.file(`OEBPS/${d.href}`, xhtml(d.body, d.head));
  if (opts.nav) zip.file("OEBPS/nav.xhtml", xhtml(opts.nav));
  for (const [p, data] of Object.entries(opts.files ?? {})) zip.file(p, data);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

const para = (word: string, n: number) => `<p>${Array.from({ length: n }, () => word).join(" ")}</p>`;

function attributesIn(html: string): string[] {
  return [...html.matchAll(/<[a-z0-9]+((?:\s+[a-z-]+="[^"]*")*)\s*>/gi)].flatMap((m) =>
    [...m[1].matchAll(/([a-z-]+)="/gi)].map((a) => a[1]),
  );
}

describe("reader cleaner: hostile markup", () => {
  it("escapes a broken tag hidden in text (no live onerror)", () => {
    const out = clean('<p>hi <img src=x onerror=alert(1)// <b>x</b></p>');
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("&lt;img src=x onerror=alert(1)//");
  });

  // SX1 audit N1, moved to the live reader: a slash right after the tag
  // name ("<svg/onload=...>") is not a tag the cleaner accepts, so it
  // must come out as plain text, never as a live element.
  it("escapes slash-after-name tags (<svg/onload>, <p/onclick>, <img/src/onerror>)", () => {
    expect(clean("<p>a <svg/onload=alert(1)> b</p>")).toBe("<p>a &lt;svg/onload=alert(1)&gt; b</p>");
    expect(clean("<p/onclick=alert(1)>x</p>")).toBe("<p>&lt;p/onclick=alert(1)&gt;x</p>");
    expect(clean("<p>a</p><svg/onload=alert(1)><p>b</p>")).toBe("<p>a</p><p>&lt;svg/onload=alert(1)&gt;</p><p>b</p>");
    const out = clean("<p>x <img/src=x/onerror=alert(1)> y</p>");
    expect(out).not.toMatch(/<img|<svg|onerror=alert\(1\)>/);
    expect(out).toBe("<p>x &lt;img/src=x/onerror=alert(1)&gt; y</p>");
  });

  it("drops scripts, svg, iframes, forms with their content", () => {
    const out = clean(
      '<p>a</p><script>bad()</script><svg><script>x</script><image href="http://e/x"/></svg><iframe src="http://e">t</iframe><form><input value="z"/></form><p>b</p>',
    );
    expect(out).toBe("<p>a</p><p>b</p>");
  });

  it("never copies the book's own attributes: only class (ours), id (ours), alt and src (token)", () => {
    const out = clean(
      '<p class="center evil" style="color:red;text-align:center" onclick="x()" id="their-id" data-x="1">t</p><a href="javascript:alert(1)">link</a><span title="t" class="foo">s</span>',
    );
    for (const name of attributesIn(out)) expect(["class", "id", "alt", "src"]).toContain(name);
    expect(out).not.toMatch(/onclick|javascript|their-id|evil|color/);
    expect(out).toContain('<p class="lb-c">t</p>');
    expect(out).toContain("link");
  });

  it("emits only known tags and our own classes", () => {
    const out = clean('<section class="x"><p class="right">r</p><blink>b</blink><marquee>m</marquee><table><tr><td>c</td></tr></table></section>');
    for (const m of out.matchAll(/<\/?([a-z0-9]+)/gi)) expect(READER_TAGS.has(m[1].toLowerCase())).toBe(true);
    for (const m of out.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(" ")) expect((READER_CLASSES as readonly string[]).includes(c)).toBe(true);
    }
  });

  it("images only through the token; remote or unknown sources are dropped", () => {
    const out = clean('<p><img src="ok.png" alt="a &quot;q&quot; &lt;b&gt;"/><img src="http://evil/x.png"/></p>');
    expect(out).toMatch(/^<p><img alt="a &quot;q&quot; &lt;b&gt;" src="\u0000LBIMG:0\u0000"><\/p>$/);
  });

  it("text cannot forge an image token", () => {
    const out = clean("<p>a\u0000LBIMG:0\u0000b</p>");
    expect(out).toBe("<p>aLBIMG:0b</p>");
  });
});

describe("reader cleaner: layout", () => {
  it("reads simple CSS classes into our layout classes, ignoring complex selectors", () => {
    const css = `.ctr{text-align:center} p.it, .x .y {font-style:italic} div > .no {font-weight:bold} .ni{text-indent:0} .sc{font-variant:small-caps} .brk{page-break-before:always}`;
    expect(clean('<p class="ctr">a</p><p class="it">b</p><p class="no">c</p><p class="ni sc">d</p><p class="brk">e</p>', css)).toBe(
      '<p class="lb-c">a</p><p class="lb-i">b</p><p>c</p><p class="lb-ni lb-sc">d</p><p class="lb-pb">e</p>',
    );
  });

  it("maps Librum's own converter classes", () => {
    expect(clean('<p class="scene-break">*</p><p class="verse-stanza">v</p><p class="epigraph">e</p>')).toBe(
      '<p class="lb-scene">*</p><p class="lb-verse lb-stanza">v</p><p class="lb-epi">e</p>',
    );
  });

  it("gives h1/h2 their own ids for the Contents list", () => {
    expect(clean('<h1 id="x">One</h1><h2>Two</h2><h3>Three</h3>')).toBe('<h1 id="lb-h-1">One</h1><h2 id="lb-h-2">Two</h2><h3>Three</h3>');
  });

  it("keeps layout of an unwrapped container on a neutral div", () => {
    expect(clean('<section style="text-align:center"><p>a</p></section>')).toBe('<div class="lb-c"><p>a</p></div>');
  });
});

// SC1: a chapter wrapped in one container stays ONE chunk with the same
// html as before, and lists where it may be cut (its inner blocks).
describe("reader cleaner: block boundaries inside big containers", () => {
  const run = (body: string) =>
    sanitizeReaderBody(body, { classRules: parseCssClassRules(".calibre1 { page-break-before: always }"), headingCounter: { next: 1 }, registerImage: () => null });
  // What the chunk would be if cut after part i.
  const cuts = (body: string) => {
    const [chunk] = run(body);
    return (chunk.parts ?? []).map((p) => chunk.html.slice(0, p.end) + p.close);
  };

  it("chunk html is unchanged; parts are prefixes with the wrappers closed", () => {
    const body = '<div class="calibre1"><h1>T</h1><p>a</p><p>b</p></div>';
    const chunks = run(body);
    expect(chunks.map((c) => c.html)).toEqual(['<div class="lb-pb"><h1 id="lb-h-1">T</h1><p>a</p><p>b</p></div>']);
    expect(cuts(body)).toEqual([
      '<div class="lb-pb"><h1 id="lb-h-1">T</h1></div>',
      '<div class="lb-pb"><h1 id="lb-h-1">T</h1><p>a</p></div>',
      '<div class="lb-pb"><h1 id="lb-h-1">T</h1><p>a</p><p>b</p></div>',
    ]);
    expect(chunks[0].parts!.map((p) => [p.text, p.heading])).toEqual([["T", true], ["a", false], ["b", false]]);
  });

  it("nested plain containers: boundaries reach the inner blocks, every wrapper is closed", () => {
    expect(cuts("<section><div><p>a</p><p>b</p></div></section>")).toEqual(["<div><p>a</p></div>", "<div><p>a</p><p>b</p></div>"]);
  });

  it("loose text before a block belongs to that block's part", () => {
    const [chunk] = run("<div>intro <em>x</em><p>a</p><p>b</p> </div>");
    expect(chunk.html).toBe("<div>intro <em>x</em><p>a</p><p>b</p> </div>");
    expect(chunk.parts!.map((p) => p.text)).toEqual(["intro xa", "b"]);
    expect(chunk.text).toBe("intro xab ");
  });

  it("blocks that are not plain containers are not looked into (a blockquote, a list)", () => {
    expect(cuts("<div><blockquote><p>a</p><p>b</p></blockquote><ul><li>x</li><li>y</li></ul></div>")).toEqual([
      "<div><blockquote><p>a</p><p>b</p></blockquote></div>",
      "<div><blockquote><p>a</p><p>b</p></blockquote><ul><li>x</li><li>y</li></ul></div>",
    ]);
    expect(run("<blockquote><div><p>a</p><p>b</p></div></blockquote>")[0].parts).toBeUndefined();
  });

  it("a container with one block, or none, has no parts", () => {
    expect(run("<div><p>a</p></div>")[0].parts).toBeUndefined();
    expect(run("<div> </div><p>a</p>").map((c) => c.html)).toEqual(["<p>a</p>"]);
  });

  it("the chunks' html is byte-identical to a cleaner without boundaries", () => {
    const body = '<div class="calibre1"><h2>Ch</h2><p>a <b>b</b></p><div><p>c</p><br/>d</div><p>e</p></div><p>f</p>';
    expect(run(body).map((c) => c.html).join("")).toBe(
      '<div class="lb-pb"><h2 id="lb-h-1">Ch</h2><p>a <b>b</b></p><div><p>c</p><br>d</div><p>e</p></div><p>f</p>',
    );
  });
});

// Audit F1: a tag still open at the end of a document kept its text.
describe("reader cleaner: tags left open at the end", () => {
  it("keeps the text of an unclosed <p>", () => {
    expect(clean("<p>hello")).toBe("<p>hello</p>");
    expect(clean("<p>a</p><p>b")).toBe("<p>a</p><p>b</p>");
  });

  it("closes nested unclosed tags innermost first", () => {
    expect(clean('<section style="text-align:center"><p>a</p><p>b')).toBe('<div class="lb-c"><p>a</p><p>b</p></div>');
    expect(clean("<section><p>x <em>y")).toBe("<p>x <em>y</em></p>");
  });

  it("an unclosed dropped tag still drops its content", () => {
    expect(clean("<p>a</p><script>bad()")).toBe("<p>a</p>");
    expect(clean("<p>a</p><svg><text>b")).toBe("<p>a</p>");
    expect(clean("<p>a <script>bad()")).toBe("<p>a </p>");
  });

  it("text in an unclosed tag stays escaped", () => {
    const out = clean("<p>hi <img src=x onerror=alert(1)//");
    expect(out).toBe("<p>hi &lt;img src=x onerror=alert(1)//</p>");
  });
});

describe("buildReaderContent: the sample cut", () => {
  const chapters = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    href: `c${i}.xhtml`,
    body: `<h1>Kapitulli ${i + 1}</h1>${para(`w${i}`, 200)}`,
  }));

  it("sends about 10% and nothing after the cut: no text, no chapter title", async () => {
    const r = await buildReaderContent(await epub({ docs: chapters }), "sample");
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.html).toContain("w0");
    expect(r.html).not.toContain("w1 ");
    expect(r.html).not.toContain("Kapitulli 2");
    expect(r.toc.map((t) => t.label)).toEqual(["Kapitulli 1"]);
    expect(r.approximatePercent).toBe(10);
  });

  it("full mode sends the whole book with a marker where the sample ends", async () => {
    const r = await buildReaderContent(await epub({ docs: chapters }), "full");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toContain("w9");
    expect(r.html.split('id="lb-sample-end"').length).toBe(2);
    expect(r.html.indexOf("lb-sample-end")).toBeLessThan(r.html.indexOf("w1"));
    expect(r.toc).toHaveLength(10);
  });

  it("front matter before the bodymatter landmark is free up to 3% of the book", async () => {
    const front = { id: "f", href: "f.xhtml", body: para("front", 20) };
    const docs = [front, ...chapters];
    const nav = `<nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="c0.xhtml">Start</a></li></ol></nav>`;
    const r = await buildReaderContent(await epub({ docs, nav }), "sample");
    if (!r.available) throw new Error("unavailable");
    // Front matter shown, and the text sample is still a full ~10%.
    expect(r.html).toContain("front");
    expect(r.html).toContain("w0");
  });

  it("a long introduction beyond the 3% cap counts toward the sample", async () => {
    const intro = { id: "f", href: "f.xhtml", body: para("intro", 2000) };
    const docs = [intro, ...chapters];
    const guide = `<guide><reference type="text" href="c0.xhtml"/></guide>`;
    const r = await buildReaderContent(await epub({ docs, guide }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toContain("intro");
    expect(r.html).not.toContain("w0");
  });

  // SC1: 10%, but never more than SAMPLE_MAX_WORDS (~30 printed pages).
  // 20 chapters x 20 paragraphs x 100 words = 40,000 words: 10% would be
  // 4,000, under the cap. 20 x 50 x 100 = 100,000: 10% would be 10,000.
  const book = (chapterCount: number, parasPerChapter: number) =>
    Array.from({ length: chapterCount }, (_, i) => ({
      id: `c${i}`,
      href: `c${i}.xhtml`,
      body: `<h1>Kapitulli ${i + 1}</h1>${Array.from({ length: parasPerChapter }, (_, j) => para(`k${String(i).padStart(2, "0")}p${String(j).padStart(2, "0")}`, 100)).join("")}`,
    }));
  const wordsIn = (html: string) => countWords(html.replace(/<[^>]*>/g, " ").replace(/Kapitulli \d+/g, ""));

  it("a long book's sample stops at the word cap, with the real smaller %", async () => {
    const r = await buildReaderContent(await epub({ docs: book(20, 50) }), "sample");
    if (!r.available) throw new Error("unavailable");
    const sent = wordsIn(r.html);
    expect(sent).toBe(SAMPLE_MAX_WORDS); // 75 whole paragraphs, cut at a paragraph end
    expect(r.html).toContain("k01p24 ");
    expect(r.html).not.toContain("k01p25");
    expect(r.html).not.toContain("Kapitulli 3");
    expect(r.approximatePercent).toBe(8); // 7,500 of 100,000 words, rounded
  });

  it("a short book is unchanged: still ~10%", async () => {
    const r = await buildReaderContent(await epub({ docs: book(20, 20) }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(wordsIn(r.html)).toBe(4000);
    expect(r.approximatePercent).toBe(10);
  });

  it("full mode puts the 'sample ends here' mark at the capped point", async () => {
    const r = await buildReaderContent(await epub({ docs: book(20, 50) }), "full");
    if (!r.available) throw new Error("unavailable");
    const before = r.html.slice(0, r.html.indexOf('<div class="lb-sample-end"'));
    expect(wordsIn(before)).toBe(SAMPLE_MAX_WORDS);
    expect(r.html).toContain("k19p49");
    expect(r.approximatePercent).toBe(8);
  });

  it("front matter stays free under the word cap (up to 3% of the book's words)", async () => {
    const front = { id: "f", href: "f.xhtml", body: para("front", 500) };
    const docs = [front, ...book(20, 50)];
    const guide = `<guide><reference type="text" href="c0.xhtml"/></guide>`;
    const r = await buildReaderContent(await epub({ docs, guide }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toContain("front");
    expect(wordsIn(r.html)).toBe(500 + SAMPLE_MAX_WORDS);
  });

  it("a long introduction is free only up to ~5 pages; the rest counts toward the 30", async () => {
    const intro = { id: "f", href: "f.xhtml", body: Array.from({ length: 30 }, (_, j) => para(`intro${j}`, 100)).join("") };
    const docs = [intro, ...book(20, 50)];
    const guide = `<guide><reference type="text" href="c0.xhtml"/></guide>`;
    const r = await buildReaderContent(await epub({ docs, guide }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(FRONT_MATTER_FREE_MAX_WORDS).toBe(1250);
    // Word target 7,500 + 1,250 = 8,750: 3,000 intro + 5,800 of the story
    // (stops at the first paragraph that reaches it; titles are 2 words each).
    expect(wordsIn(r.html)).toBe(8800);
    expect(r.html).toContain("k01p07 ");
    expect(r.html).not.toContain("k01p08");
  });

  it("the cap also holds when each chapter is one big container (Calibre style)", async () => {
    const wrapped = book(20, 50).map((d) => ({ ...d, body: `<div class="calibre">${d.body}</div>` }));
    const r = await buildReaderContent(await epub({ docs: wrapped }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(wordsIn(r.html)).toBe(SAMPLE_MAX_WORDS);
    expect(r.html).not.toContain("k01p25");
    expect(r.html).not.toContain("Kapitulli 3");
    // Audit B1/B2: each chapter keeps ONE wrapper (paragraph indents and
    // page-break classes stay as before); only the last one is trimmed.
    expect(r.html.match(/<div\b/g)).toHaveLength(2);
  });

  it("before the cut, a wrapped book's output is byte-identical to the full book's", async () => {
    const wrapped = book(20, 50).map((d) => ({ ...d, body: `<div style="page-break-before:always">${d.body}</div>` }));
    const bytes = await epub({ docs: wrapped });
    const sample = await buildReaderContent(bytes, "sample");
    const full = await buildReaderContent(bytes, "full");
    if (!sample.available || !full.available) throw new Error("unavailable");
    const marker = '<div class="lb-sample-end" id="lb-sample-end"></div>';
    const at = full.html.indexOf(marker);
    // Sample = full html up to the marker, then the trimmed chapter's
    // wrapper and its section are closed. Nothing else differs.
    expect(sample.html).toBe(`${full.html.slice(0, at)}</div></section>`);
    // The full book is the untouched chunks plus the marker, once.
    expect(full.html.split(marker)).toHaveLength(2);
    expect(full.html.replace(marker, "")).toBe(
      book(20, 50).map((d, i) => `<section class="lb-sec"><div class="lb-pb">${d.body.replace("<h1>", `<h1 id="lb-h-${i + 1}">`)}</div></section>`).join(""),
    );
  });

  it("a chapter title inside a wrapper is never the sample's last line", async () => {
    // Chapter 1 = title (2 words) + 7,497 words, so the cap is first
    // reached by chapter 2's (wrapped) title: the sample must step back.
    const ch1 = `<div><h1>Kapitulli 1</h1>${Array.from({ length: 74 }, (_, j) => para(`a${String(j).padStart(2, "0")}`, 100)).join("")}${para("last", 97)}</div>`;
    const rest = book(20, 50).slice(1).map((d) => ({ ...d, body: `<div>${d.body}</div>` }));
    const docs = [{ id: "c0", href: "c0.xhtml", body: ch1 }, ...rest];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toContain("last");
    expect(r.html).not.toContain("Kapitulli 2");
    expect(r.html).not.toContain("k01p00");
  });

  it("countWords: letters or digits make a word; entities are not words", () => {
    expect(countWords("Një  fjalë, 2 — p&#235;r &amp; tjetër")).toBe(5);
    expect(countWords("   ")).toBe(0);
  });

  it("refuses non-EPUB bytes", async () => {
    expect(await buildReaderContent(Buffer.from("not a zip"), "sample")).toEqual({ available: false });
  });
});

describe("buildReaderContent: pictures", () => {
  it("inlines in-sample pictures as re-encoded data: URIs; the cover and past-the-cut pictures are left out", async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c00" } }).png().toBuffer();
    const docs = [
      { id: "cv", href: "cover.xhtml", body: '<img src="cover.png" alt="cover"/>' },
      { id: "a", href: "a.xhtml", body: `<p><img src="img/in.png" alt="inside"/></p>${para("a", 100)}` },
      { id: "b", href: "b.xhtml", body: `${para("b", 2000)}<p><img src="img/out.png" alt="outside"/></p>` },
    ];
    const extraManifest =
      '<item id="cimg" href="cover.png" media-type="image/png" properties="cover-image"/>' +
      '<item id="i1" href="img/in.png" media-type="image/png"/>' +
      '<item id="i2" href="img/out.png" media-type="image/png"/>';
    const r = await buildReaderContent(
      await epub({ docs, extraManifest, files: { "OEBPS/cover.png": png, "OEBPS/img/in.png": png, "OEBPS/img/out.png": png } }),
      "sample",
    );
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toMatch(/<img alt="inside" src="data:image\/webp;base64,[A-Za-z0-9+/=]+">/);
    expect(r.html).not.toContain("outside");
    expect(r.html).not.toContain('alt="cover"');
    expect(r.html).not.toMatch(/\.png|\u0000/);
  });

  it("drops a picture whose bytes are not a real raster image", async () => {
    const docs = [{ id: "a", href: "a.xhtml", body: `<p><img src="x.png" alt="fake"/></p>${para("a", 50)}` }];
    const r = await buildReaderContent(
      await epub({ docs, extraManifest: '<item id="x" href="x.png" media-type="image/png"/>', files: { "OEBPS/x.png": "<svg onload=alert(1)>" } }),
      "full",
    );
    if (!r.available) throw new Error("unavailable");
    expect(r.html).not.toContain("<img");
  });
});

// SC2: one giant block (a single paragraph, list, table, br-only text) is
// cut inside, at a natural stop, instead of being sent whole.
describe("buildReaderContent: one giant block", () => {
  // n sentences of 10 words each: "s0001w1 ... s0001w9 s0001end."
  const sentences = (n: number, tag = "s") =>
    Array.from({ length: n }, (_, i) => {
      const id = `${tag}${String(i).padStart(4, "0")}`;
      return `${Array.from({ length: 9 }, (_, w) => `${id}w${w}`).join(" ")} ${id}end.`;
    }).join(" ");
  const textWords = (html: string) => countWords(html.replace(/<[^>]*>/g, " "));
  const marker = '<div class="lb-sample-end" id="lb-sample-end"></div>';

  function wellFormed(html: string) {
    const stack: string[] = [];
    for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g)) {
      if (["br", "hr", "img"].includes(m[2])) continue;
      if (m[1]) expect(stack.pop()).toBe(m[2]);
      else stack.push(m[2]);
    }
    expect(stack).toEqual([]);
  }

  it("a whole book in ONE paragraph stops at the word cap, at a sentence end", async () => {
    const docs = [{ id: "a", href: "a.xhtml", body: `<h1>Titulli</h1><p>${sentences(10000)}</p>` }]; // 100,000 words
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    // 7,500 words = sentence 0749 is the last one, whole; "Titulli" is 1.
    expect(textWords(r.html)).toBe(SAMPLE_MAX_WORDS + 1);
    expect(r.html).toMatch(/s0749end\.<\/p><\/section>$/);
    expect(r.html).not.toContain("s0750");
    expect(r.approximatePercent).toBe(8); // ~7,500 of 100,000 words
    wellFormed(r.html);
  });

  it("a short story in one paragraph is held to ~10%", async () => {
    const docs = [{ id: "a", href: "a.xhtml", body: `<p class="x">${sentences(300)}</p>` }]; // 3,000 words
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    const sent = textWords(r.html);
    expect(sent).toBeGreaterThanOrEqual(300);
    expect(sent).toBeLessThanOrEqual(310); // stops at the end of the sentence that reaches 10%
    expect(r.html).toMatch(/end\.<\/p><\/section>$/);
    expect(r.approximatePercent).toBe(10);
  });

  it("a block that runs at most ~1 page past the limit is still sent whole (normal books unchanged)", async () => {
    const docs = [{ id: "a", href: "a.xhtml", body: `${para("a", 7400)}${para("b", 300)}${para("c", 100000)}` }];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(textWords(r.html)).toBe(7700); // the 300-word paragraph, whole
    expect(r.html).not.toContain(">c ");
  });

  it("a giant list is cut after a whole item; every tag is closed", async () => {
    const items = Array.from({ length: 10000 }, (_, i) => `<li><em>item${i}</em> ${Array.from({ length: 9 }, () => "fjale").join(" ")}</li>`).join("");
    const docs = [{ id: "a", href: "a.xhtml", body: `<blockquote><ul>${items}</ul></blockquote>` }];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toMatch(/fjale<\/li><\/ul><\/blockquote><\/section>$/);
    expect(r.html).toContain("item749<");
    expect(r.html).not.toContain("item750<");
    wellFormed(r.html);
  });

  it("a giant table is cut after a whole row", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `<tr><td>row${i} a b c d</td><td>e f g h i</td></tr>`).join("");
    const docs = [{ id: "a", href: "a.xhtml", body: `<table><tbody>${rows}</tbody></table>` }];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toMatch(/<\/td><\/tr><\/tbody><\/table><\/section>$/);
    expect(r.html).not.toContain("row999");
    wellFormed(r.html);
  });

  it("a poem held together by <br> ends on a whole line and keeps its layout class", async () => {
    // Lines with no full stops: the stop must be a line break.
    // 7 words a line: the 7,500th word falls mid-line (line 1071).
    const lines = Array.from({ length: 20000 }, (_, i) => `varg${i} a b c d e f,`).join("<br/>");
    const docs = [{ id: "a", href: "a.xhtml", body: `<p class="verse-stanza">${lines}</p>` }];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toMatch(/^<section class="lb-sec"><p class="lb-verse lb-stanza">varg0 /);
    expect(r.html).toMatch(/<br>varg1071 a b c d e f,<\/p><\/section>$/);
  });

  it("with no sentence end or line break within a page, it stops at a whole word", async () => {
    const docs = [{ id: "a", href: "a.xhtml", body: `<p>${Array.from({ length: 100000 }, (_, i) => `f${i}`).join(" ")}</p>` }];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(textWords(r.html)).toBe(SAMPLE_MAX_WORDS);
    expect(r.html).toMatch(/ f7499<\/p><\/section>$/);
  });

  it("a giant paragraph inside a Calibre wrapper is cut inside it too", async () => {
    const docs = [{ id: "a", href: "a.xhtml", body: `<div class="calibre"><h1>T</h1><p>${sentences(50, "x")}</p><p>${sentences(10000)}</p></div>` }];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(textWords(r.html)).toBe(SAMPLE_MAX_WORDS + 1);
    expect(r.html).toMatch(/s0699end\.<\/p><\/div><\/section>$/); // 500 + 7,000 words
    expect(r.html).not.toContain("s0700");
    wellFormed(r.html);
  });

  it("full mode: the marker sits at the same point, outside the paragraph; removing it gives the book back", async () => {
    const body = `<h1>Titulli</h1><p class="verse"><em>${sentences(2000)}</em></p>`;
    const bytes = await epub({ docs: [{ id: "a", href: "a.xhtml", body }] });
    const sample = await buildReaderContent(bytes, "sample");
    const full = await buildReaderContent(bytes, "full");
    if (!sample.available || !full.available) throw new Error("unavailable");
    expect(full.html.split(marker)).toHaveLength(2);
    const at = full.html.indexOf(marker);
    // Up to the marker = the sample minus its closing section tag.
    expect(`${full.html.slice(0, at)}</section>`).toBe(sample.html);
    expect(full.html.slice(at - "</em></p>".length, at)).toBe("</em></p>");
    // Close + marker + reopen removed = the untouched book.
    const untouched = full.html.replace(`</em></p>${marker}<p class="lb-verse lb-ni"><em>`, "");
    expect(untouched).toBe(`<section class="lb-sec"><h1 id="lb-h-1">Titulli</h1><p class="lb-verse"><em>${sentences(2000)}</em></p></section>`);
    expect(full.toc).toEqual([{ id: "lb-h-1", label: "Titulli" }]);
    wellFormed(full.html);
  });

  it("full mode in a page-break wrapper: the reopened wrapper keeps its layout but starts no new page", async () => {
    const body = `<div style="page-break-before:always" class="verse-stanza"><h2>K</h2><p>${sentences(10000)}</p></div>`;
    const full = await buildReaderContent(await epub({ docs: [{ id: "a", href: "a.xhtml", body }] }), "full");
    if (!full.available) throw new Error("unavailable");
    expect(full.html).toContain(`</p></div>${marker}<div class="lb-verse lb-stanza"><p class="lb-ni">`);
    expect(full.html.match(/lb-pb/g)).toHaveLength(1);
    expect(full.html.match(/id="lb-h-/g)).toHaveLength(1);
  });

  it("pictures inside the giant block but past the cut are not sent", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#0c0" } }).png().toBuffer();
    const body = `<div>${sentences(100)}<img src="in.png" alt="inside"/>${sentences(1900, "t")}<img src="out.png" alt="outside"/>${sentences(50, "u")}</div>`;
    const extraManifest = '<item id="i1" href="in.png" media-type="image/png"/><item id="i2" href="out.png" media-type="image/png"/>';
    const r = await buildReaderContent(
      await epub({ docs: [{ id: "a", href: "a.xhtml", body }], extraManifest, files: { "OEBPS/in.png": png, "OEBPS/out.png": png } }),
      "sample",
    );
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toMatch(/<img alt="inside" src="data:image\/webp;base64,/);
    expect(r.html).not.toContain("outside");
    expect(r.html).not.toContain("u0000");
    expect(r.html).not.toMatch(/\u0000|LBIMG/);
  });

  // SC2b: spaces written as entities.
  it("words joined only by &#160; / &nbsp; / &#xA0; / &#8239; are still cut inside, never inside an entity", async () => {
    const seps = ["&#160;", "&nbsp;", "&#xA0;", "&#8239;"];
    const words = Array.from({ length: 100000 }, (_, i) => `f${i}`);
    const joined = words.map((w, i) => (i ? seps[i % seps.length] : "") + w).join("");
    const docs = [{ id: "a", href: "a.xhtml", body: `<p>${joined}</p>` }];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toMatch(/f7499<\/p><\/section>$/);
    expect(r.html).not.toContain("f7500");
    wellFormed(r.html);
  });

  it("a sentence end followed by &#160; is a stop; the ~1 page gate counts &#160;-joined words", async () => {
    const nb = (n: number, w: string) => Array.from({ length: n }, () => w).join("&#160;");
    const giant = `<p>${nb(7500, "a")}&#160;b c fund.&#160;${nb(100000, "z")}</p>`;
    const r = await buildReaderContent(await epub({ docs: [{ id: "a", href: "a.xhtml", body: giant }] }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toMatch(/a&#160;b c fund\.<\/p><\/section>$/);

    // A 300-word &#160;-joined block: 200 words past the limit is sent
    // whole (null), 260 past is cut.
    const html = `<p>${nb(300, "b")}</p>`;
    expect(trimInsideBlock(html, 0, html.length, 1_000_000, 100)).toBeNull();
    expect(trimInsideBlock(html, 0, html.length, 1_000_000, 40)?.cut).toBe(3 + 39 * "b&#160;".length + 1);
  });

  it("full mode: a poem cut before a <br> does not start a blank line after the marker", async () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `varg${i} a b c d e f,`).join("<br/>");
    const full = await buildReaderContent(await epub({ docs: [{ id: "a", href: "a.xhtml", body: `<p>${lines}</p>` }] }), "full");
    if (!full.available) throw new Error("unavailable");
    expect(full.html).toContain(`varg1071 a b c d e f,</p>${marker}<p class="lb-ni">varg1072 `);
    expect(full.html.split("<br>")).toHaveLength(20000 - 1); // one <br> dropped, at the marker
  });

  // Audit N3: three guards no test held.
  it("pictures past the cut in the same block are not even read", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#0c0" } }).png().toBuffer();
    const body = `<div>${sentences(100)}<img src="in.png" alt="inside"/>${sentences(1900, "t")}<img src="out.png" alt="outside"/>${sentences(50, "u")}</div>`;
    const extraManifest = '<item id="i1" href="in.png" media-type="image/png"/><item id="i2" href="out.png" media-type="image/png"/>';
    const bytes = await epub({ docs: [{ id: "a", href: "a.xhtml", body }], extraManifest, files: { "OEBPS/in.png": png, "OEBPS/out.png": png } });
    // Every zip entry shares one prototype: record which pictures are
    // read as bytes.
    const entryProto = Object.getPrototypeOf((await JSZip.loadAsync(bytes)).file("OEBPS/in.png")!);
    const original = entryProto.async;
    const read: string[] = [];
    const spy = vi.spyOn(entryProto, "async").mockImplementation(function (this: { name: string }, type: unknown) {
      if (type === "nodebuffer") read.push(this.name);
      return original.call(this, type);
    });
    try {
      const r = await buildReaderContent(bytes, "sample");
      if (!r.available) throw new Error("unavailable");
      expect(read).toContain("OEBPS/in.png");
      expect(read).not.toContain("OEBPS/out.png");
    } finally {
      spy.mockRestore();
    }
  });

  it("a number like 3.5 is not a sentence end", async () => {
    const f = (from: number, n: number) => Array.from({ length: n }, (_, i) => `f${from + i}`).join(" ");
    const docs = [{ id: "a", href: "a.xhtml", body: `<p>${f(0, 7500)} v3.5 b c fund. ${f(7500, 100000)}</p>` }];
    const r = await buildReaderContent(await epub({ docs }), "sample");
    if (!r.available) throw new Error("unavailable");
    expect(r.html).toMatch(/ v3\.5 b c fund\.<\/p><\/section>$/);
  });

  it("a limit exactly at the start of a text run maps into that run, after its tag", () => {
    const html = `<p>one<em> ${Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ")}</em></p>`;
    const t = trimInsideBlock(html, 0, html.length, 1_000_000, 1);
    expect(t?.cut).toBe(html.indexOf("<em>") + "<em>".length);
    expect(t?.close).toBe("</em></p>");
  });
});
