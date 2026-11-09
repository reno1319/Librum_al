import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import sharp from "sharp";
import { buildReaderContent } from "./epub-reader";
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
