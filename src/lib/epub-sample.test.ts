import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { countEpubWords, __internal } from "./epub-sample";

const { sanitizeBodyIntoChunks } = __internal;

function sanitizedHtml(bodyInner: string): string {
  return sanitizeBodyIntoChunks(bodyInner)
    .map((c) => c.html)
    .join("");
}

// LIBRUM 2.0 PRODUCT-1: every fixture here is a real EPUB built with
// JSZip and read back through the function under test -- same "write
// with JSZip, read with the function under test" discipline
// epub-validation.test.ts already established for this codebase's other
// EPUB-parsing code.

function containerXmlFor(opfPath: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function xhtmlDoc(bodyInner: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter</title></head>
<body>${bodyInner}</body>
</html>`;
}

type Doc = { id: string; href: string; mediaType?: string; body: string; linear?: "yes" | "no" };

function opfFor(docs: Doc[], navId?: string) {
  const manifestItems = docs
    .map(
      (d) =>
        `<item id="${d.id}" href="${d.href}" media-type="${d.mediaType ?? "application/xhtml+xml"}"${d.id === navId ? ' properties="nav"' : ""}/>`,
    )
    .join("\n    ");
  const spineRefs = docs
    .map((d) => `<itemref idref="${d.id}"${d.linear === "no" ? ' linear="no"' : ""}/>`)
    .join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineRefs}
  </spine>
</package>`;
}

async function buildEpub({
  docs,
  opfDir = "OEBPS",
  opfXml,
  navId,
  omitContainer = false,
  omitOpf = false,
  omitManifest = false,
  omitSpine = false,
}: {
  docs?: Doc[];
  opfDir?: string;
  opfXml?: string;
  navId?: string;
  omitContainer?: boolean;
  omitOpf?: boolean;
  omitManifest?: boolean;
  omitSpine?: boolean;
} = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  const opfPath = `${opfDir}/content.opf`;
  if (!omitContainer) {
    zip.file("META-INF/container.xml", containerXmlFor(opfPath), { compression: "DEFLATE" });
  }

  let finalOpf = opfXml;
  if (finalOpf === undefined && !omitOpf) {
    finalOpf = opfFor(docs ?? [], navId);
    if (omitManifest) finalOpf = finalOpf.replace(/<manifest>[\s\S]*?<\/manifest>/, "");
    if (omitSpine) finalOpf = finalOpf.replace(/<spine>[\s\S]*?<\/spine>/, "");
  }
  if (finalOpf !== undefined) {
    zip.file(opfPath, finalOpf, { compression: "DEFLATE" });
  }

  for (const doc of docs ?? []) {
    zip.file(`${opfDir}/${doc.href}`, xhtmlDoc(doc.body), { compression: "DEFLATE" });
  }

  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

// G2 (PV1 item 3, Renato 11-24 "s1 b"): the old sample builder
// (extractEpubSample) is removed; the reader (epub-reader.ts) makes the
// sample now. What stays here is the spine reader behind countEpubWords
// (the page estimate) and the sanitizer tests below.
const OPF_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>`;

describe("countEpubWords: which spine documents count", () => {
  it("counts every linear spine document", async () => {
    const bytes = await buildEpub({
      docs: [
        { id: "c1", href: "c1.xhtml", body: "<p>" + "one ".repeat(200) + "</p>" },
        { id: "c2", href: "c2.xhtml", body: "<p>" + "two ".repeat(200) + "</p>" },
      ],
    });
    expect(await countEpubWords(bytes)).toBe(400);
  });

  it("skips the EPUB3 navigation document even if present in spine", async () => {
    const bytes = await buildEpub({
      navId: "nav",
      docs: [
        { id: "nav", href: "nav.xhtml", body: "<p>nav nav nav</p>" },
        { id: "c1", href: "c1.xhtml", body: "<p>" + "real ".repeat(30) + "</p>" },
      ],
    });
    expect(await countEpubWords(bytes)).toBe(30);
  });

  it('skips linear="no" spine items', async () => {
    const bytes = await buildEpub({
      docs: [
        { id: "c1", href: "c1.xhtml", body: "<p>" + "main ".repeat(30) + "</p>" },
        { id: "extra", href: "extra.xhtml", body: "<p>extra extra</p>", linear: "no" },
      ],
    });
    expect(await countEpubWords(bytes)).toBe(30);
  });

  it("does not double-count a spine item referenced twice", async () => {
    const opfXml = `${OPF_HEAD}
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/><itemref idref="c1"/></spine>
</package>`;
    const bytes = await buildEpub({ opfXml, docs: [{ id: "c1", href: "c1.xhtml", body: "<p>" + "solo ".repeat(50) + "</p>" }] });
    expect(await countEpubWords(bytes)).toBe(50);
  });

  it("skips a spine item whose manifest href doesn't exist in the archive, rather than crashing", async () => {
    const opfXml = `${OPF_HEAD}
  <manifest>
    <item id="ghost" href="does-not-exist.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ghost"/><itemref idref="c1"/></spine>
</package>`;
    const bytes = await buildEpub({ opfXml, docs: [{ id: "c1", href: "c1.xhtml", body: "<p>" + "real ".repeat(50) + "</p>" }] });
    expect(await countEpubWords(bytes)).toBe(50);
  });

  it("never counts script content", async () => {
    const bytes = await buildEpub({ docs: [{ id: "c1", href: "c1.xhtml", body: "<p>one two</p><script>alert(1) bad words</script>" }] });
    expect(await countEpubWords(bytes)).toBe(2);
  });
});

describe("countEpubWords: malformed EPUB / missing structure gives null", () => {
  it.each([
    ["arbitrary non-ZIP bytes", async () => Buffer.from("not a zip at all")],
    ["no META-INF/container.xml", async () => buildEpub({ omitContainer: true, docs: [{ id: "c1", href: "c1.xhtml", body: "<p>x</p>" }] })],
    ["the OPF the container points to is absent", async () => buildEpub({ omitOpf: true })],
    ["an OPF with no manifest", async () => buildEpub({ docs: [{ id: "c1", href: "c1.xhtml", body: "<p>x</p>" }], omitManifest: true })],
    ["an OPF with no spine", async () => buildEpub({ docs: [{ id: "c1", href: "c1.xhtml", body: "<p>x</p>" }], omitSpine: true })],
  ])("%s", async (_label, make) => {
    expect(await countEpubWords(await make())).toBeNull();
  });

  it("an EPUB whose spine documents hold no readable text counts 0 words", async () => {
    const bytes = await buildEpub({ docs: [{ id: "c1", href: "c1.xhtml", body: "" }, { id: "c2", href: "c2.xhtml", body: "   \n  " }] });
    expect(await countEpubWords(bytes)).toBe(0);
  });
});

// EPUB-VALIDATION-1B: the same preflight as validateEpubStructure() runs
// before any entry is decompressed.
describe("countEpubWords: resource limits (EPUB-VALIDATION-1B)", () => {
  it("an otherwise valid EPUB with one entry over the per-entry size limit is refused before decompression", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", containerXmlFor("OEBPS/content.opf"), { compression: "DEFLATE" });
    zip.file("OEBPS/content.opf", opfFor([{ id: "c1", href: "c1.xhtml", body: "" }]), { compression: "DEFLATE" });
    zip.file("OEBPS/c1.xhtml", xhtmlDoc("<p>" + "real ".repeat(50) + "</p>"), { compression: "DEFLATE" });
    zip.file("OEBPS/unused-bomb.bin", Buffer.alloc(51 * 1024 * 1024, 0), { compression: "DEFLATE", compressionOptions: { level: 9 } });
    const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    expect(await countEpubWords(bytes)).toBeNull();
  });

  it("an archive with more entries than the preflight limit is refused, not thrown", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", containerXmlFor("OEBPS/content.opf"), { compression: "DEFLATE" });
    zip.file("OEBPS/content.opf", opfFor([{ id: "c1", href: "c1.xhtml", body: "" }]), { compression: "DEFLATE" });
    zip.file("OEBPS/c1.xhtml", xhtmlDoc("<p>x</p>"), { compression: "DEFLATE" });
    for (let i = 0; i < 5001; i++) zip.file(`OEBPS/filler-${i}.txt`, "x");
    const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    await expect(countEpubWords(bytes)).resolves.toBeNull();
  });
});

describe("sanitizeBodyIntoChunks: hostile/malformed markup", () => {
  // A literal '>' inside a quoted attribute value desyncs the tag-
  // boundary match (documented limitation -- attrs can't itself contain
  // '>', so the regex terminates the tag early at that character). This
  // DOES leak the rest of the malformed attribute text -- including the
  // literal substring 'onclick="evil()"' -- but only ever as inert TEXT
  // CONTENT between real tags, never as a live attribute on any emitted
  // tag: the sanitizer only ever constructs its OWN tags from a fixed
  // template (`<${tag}>`, always bare), so nothing from the input is
  // ever spliced inside a NEW tag's own `<...>` syntax. A browser
  // parsing this component's actual output would render 'onclick=' as
  // visible page text, never register it as an event handler -- HTML
  // text nodes cannot retroactively attach an attribute to a tag. The
  // real, checkable invariant is therefore "no tag in the output ever
  // carries an attribute," not "the substring never appears anywhere."
  it("a literal '>' inside a quoted attribute value desyncs the tag boundary but never produces a live attribute on any emitted tag", () => {
    const html = sanitizedHtml(`<p title="a > b" onclick="evil()">safe text ${"word ".repeat(10)}</p>`);
    // No tag anywhere in the output carries any attribute at all.
    expect(html).not.toMatch(/<[a-zA-Z][^>]*=/);
    // And no real, executable element name reaches the output either.
    expect(html).not.toMatch(/<script/i);
  });

  it("unclosed inner tags are safely auto-closed by an ancestor's close tag, content preserved", () => {
    const html = sanitizedHtml(`<p>Hello <strong>world</p>`);
    expect(html).toBe("<p>Hello <strong>world</strong></p>");
  });

  it("a tag left open for the rest of the document is dropped entirely rather than guessed at, never leaking its content", () => {
    const html = sanitizedHtml(`<p>Hello <strong>world`);
    expect(html).toBe("");
  });

  it("mixed-case dangerous tags are still recognized and dropped (SCRIPT, ScRiPt, Script)", () => {
    for (const variant of ["SCRIPT", "ScRiPt", "Script", "sCRIPT"]) {
      const html = sanitizedHtml(
        `<p>Safe ${"word ".repeat(10)}</p><${variant}>alert(document.cookie)</${variant}>`,
      );
      expect(html).not.toContain("alert");
      expect(html).not.toContain("cookie");
      expect(html.toLowerCase()).not.toContain("<script");
    }
  });

  it("nested dangerous subtrees (script inside script inside div) never leak, and drop the whole ancestor's text", () => {
    const html = sanitizedHtml(
      `<div><script><script>alert(1)</script>trailing-in-outer-script</script>after-div-close</div>`,
    );
    expect(html).not.toContain("alert");
    expect(html).not.toContain("trailing-in-outer-script");
    // "after-div-close" is text that belongs to the (unwrapped) <div>
    // itself, not to either dropped <script> -- legitimately kept.
    expect(html).toContain("after-div-close");
  });

  it("an unclosed/malformed comment consumes to end-of-document rather than leaking '<!--' as text, and never hides a real dangerous tag that follows it", () => {
    const html = sanitizedHtml(`<p>before ${"word ".repeat(10)}</p><!-- unterminated comment <script>alert(1)</script>`);
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("alert");
    expect(html).toContain("before");
  });

  it("a malformed comment with stray double-dashes inside still terminates safely at the first real '-->' ", () => {
    const html = sanitizedHtml(`<p>${"word ".repeat(10)}</p><!-- a -- b -- c --><script>alert(1)</script>`);
    expect(html).not.toContain("alert");
    expect(html).not.toContain("<!--");
  });

  it("namespace-prefixed dangerous tags (svg:script, html:script) are dropped by their local name", () => {
    const html = sanitizedHtml(
      `<p>Safe ${"word ".repeat(10)}</p><svg:script>alert(1)</svg:script><html:script>alert(2)</html:script>`,
    );
    expect(html).not.toContain("alert");
  });

  it("a namespace-prefixed benign tag (epub:switch) is unwrapped, not treated as one of the plain reading tags", () => {
    const html = sanitizedHtml(`<epub:switch><epub:case>fallback text</epub:case></epub:switch>`);
    expect(html).not.toContain("<epub:");
    expect(html).not.toContain("epub:switch");
    expect(html).toContain("fallback text");
  });

  it("already-escaped, encoded tag-looking text is passed through as inert display text, never decoded into real markup", () => {
    const html = sanitizedHtml(`<p>Discussing HTML: &lt;script&gt;alert(1)&lt;/script&gt; is dangerous ${"word ".repeat(10)}</p>`);
    // The literal entity text survives verbatim -- it is not our job to
    // decode it, and a browser rendering this will show "<script>" as
    // text, never execute it (entities in text nodes are never
    // re-parsed as markup by any HTML parser).
    expect(html).toContain("&lt;script&gt;");
    // Never a real, executable <script> element in the output.
    expect(html).not.toMatch(/<script(?![a-z])/i);
  });

  it("malformed/incomplete entities (&foo with no semicolon, bare &) do not crash and never produce markup", () => {
    const html = sanitizedHtml(`<p>Tom & Jerry, &foo went &nowhere; ${"word ".repeat(10)}</p>`);
    expect(html).toContain("Tom & Jerry");
    expect(html).not.toMatch(/<(?!\/?p>)/); // only the <p>/</p> wrapper, nothing else
  });

  it("null and control characters in text do not crash extraction and never enable markup injection", () => {
    const withControls = `<p>Weird text\u0000here\u0001\u001f ${"word ".repeat(10)}</p>`;
    expect(() => sanitizedHtml(withControls)).not.toThrow();
    const html = sanitizedHtml(withControls);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("<p>");
  });

  it("a self-closing <script/> (XML-empty-element form) contributes nothing at all", () => {
    const html = sanitizedHtml(`<p>Safe ${"word ".repeat(10)}</p><script src="evil.js"/>`);
    expect(html).not.toContain("script");
    expect(html).not.toContain("evil.js");
  });

  it("an unclosed <script> swallows everything after it for the rest of the document, including tags that look allowed", () => {
    const html = sanitizedHtml(
      `<p>Safe ${"word ".repeat(10)}</p><script>var x = 1; <p>fake-paragraph-inside-script</p> more`,
    );
    expect(html).not.toContain("fake-paragraph-inside-script");
    expect(html).not.toContain("var x");
  });

  it("svg wrapping a script (common real-world XSS vector) is fully dropped, including nested content", () => {
    const html = sanitizedHtml(
      `<p>Safe ${"word ".repeat(10)}</p><svg><script>alert(1)</script></svg>`,
    );
    expect(html).not.toContain("alert");
    expect(html.toLowerCase()).not.toContain("<svg");
  });

  it("event-handler-like attribute text embedded without real tag structure never becomes a live attribute", () => {
    // Not a real tag at all -- just prose that happens to contain
    // 'onerror=' as literal text (e.g. a technical book about XSS).
    const html = sanitizedHtml(`<p>The payload used onerror="alert(1)" as its vector ${"word ".repeat(10)}</p>`);
    expect(html).toContain("onerror=");
    // It's inert prose text inside <p>...</p>, never inside a real tag's
    // attribute list (which would require it to appear before a `>`
    // that closes an actual opening tag) -- confirmed no tag in the
    // output carries any attribute at all.
    expect(html).not.toMatch(/<[a-zA-Z][^>]*=/);
  });
});

// Sample XSS fix (9 Nov 2026): a broken tag with no closing '>' before
// the next real tag is never matched by TOKEN_RE, so it reached the
// output as raw "text" and the browser parsed it as a live element
// (book-sample-reader.tsx renders sections with dangerouslySetInnerHTML).
// Text runs now have '<' and '>' escaped in the HTML output.
describe("sanitizeBodyIntoChunks: broken tags in text are escaped", () => {
  const ALLOWED = new Set([
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
    "em", "strong", "i", "b", "br", "hr", "ul", "ol", "li", "small", "sup", "sub",
  ]);

  // Every '<' in the output must start one of our own bare tags: an
  // allowed name, optional leading '/', then '>' straight away.
  function expectOnlyBareAllowedTags(html: string) {
    for (const m of html.matchAll(/<[^>]*>?/g)) {
      const tag = m[0].match(/^<\/?([a-z0-9]+)>$/);
      expect(tag, `unexpected markup ${JSON.stringify(m[0])} in ${JSON.stringify(html)}`).not.toBeNull();
      expect(ALLOWED.has(tag![1])).toBe(true);
    }
  }

  const hostile = [
    `<p>hi <img src=x onerror=alert(1)// <b>x</b></p>`,
    `<p>hi <script src=//evil.example/x.js <b>x</b></p>`,
    `<p>hi <svg/onload=alert(1)// <b>x</b></p>`,
    `<p>hi <iframe srcdoc=x <em>y</em></p>`,
    `<p>trailing broken tag at the very end <img src=x onerror=alert(1)//`,
    `<p>ok</p><img src=x onerror=alert(1)// `,
    `<p>a <![CDATA[ unterminated <b>z</b></p>`,
    `<p>a <? unterminated pi <b>z</b></p>`,
    `<p>a <!DOCTYPE x <b>z</b></p>`,
    `<p>a </b <i>z</i></p>`,
    `<p>a << <<<img src=x onerror=alert(1)//<b>z</b></p>`,
  ];

  it("the reported case: '<img ... onerror' without '>' comes out as inert text", () => {
    const html = sanitizedHtml(`<p>hi <img src=x onerror=alert(1)// <b>x</b></p>`);
    expect(html).toBe("<p>hi &lt;img src=x onerror=alert(1)// <b>x</b></p>");
  });

  it("'<script' without '>' comes out as inert text", () => {
    const html = sanitizedHtml(`<p>hi <script src=//evil.example/x.js <b>x</b></p>`);
    expect(html).toBe("<p>hi &lt;script src=//evil.example/x.js <b>x</b></p>");
    expect(html).not.toMatch(/<script/i);
  });

  it("'<svg/onload=...' without '>' comes out as inert text", () => {
    const html = sanitizedHtml(`<p>hi <svg/onload=alert(1)// <b>x</b></p>`);
    expect(html).toBe("<p>hi &lt;svg/onload=alert(1)// <b>x</b></p>");
    expect(html).not.toMatch(/<svg/i);
  });

  it("no '<' in the output starts anything but a bare allowed tag, for every hostile case", () => {
    for (const input of hostile) {
      expectOnlyBareAllowedTags(sanitizedHtml(input));
    }
  });

  it("a stray '>' in text is escaped too; entities already in the text are not double-escaped", () => {
    const html = sanitizedHtml(`<p>a > b, Tom &amp; Jerry, &lt;tag&gt;, caf&#233;</p>`);
    expect(html).toBe("<p>a &gt; b, Tom &amp; Jerry, &lt;tag&gt;, caf&#233;</p>");
  });

  it("the plain text used for the 10% length and word count stays unescaped", () => {
    const chunks = sanitizeBodyIntoChunks(`<p>a > b <img src=x</p>`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("a > b <img src=x");
  });

  it("a normal well-formed paragraph is unchanged", () => {
    const input = `<p>Një ditë <em>e bukur</em>, tha ai &amp; ajo.</p><h2>Kreu 2</h2>`;
    expect(sanitizedHtml(input)).toBe(input);
  });
});
