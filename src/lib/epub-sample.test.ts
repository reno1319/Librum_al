import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractEpubSample, __internal } from "./epub-sample";

const { sanitizeBodyIntoChunks } = __internal;

function sanitizedHtml(bodyInner: string): string {
  return sanitizeBodyIntoChunks(bodyInner)
    .map((c) => c.html)
    .join("");
}

// LIBRUM 2.0 PRODUCT-1: every fixture here is a real EPUB built with
// JSZip and read back through the exact same extractEpubSample() a real
// upload's manuscript goes through -- same "write with JSZip, read with
// the function under test" discipline epub-validation.test.ts already
// established for this codebase's other EPUB-parsing code.

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

describe("extractEpubSample: valid EPUBs with several spine documents", () => {
  it("extracts a real sample from a multi-chapter EPUB, in spine order", async () => {
    const bytes = await buildEpub({
      docs: [
        { id: "c1", href: "c1.xhtml", body: "<p>" + "one ".repeat(200) + "</p>" },
        { id: "c2", href: "c2.xhtml", body: "<p>" + "two ".repeat(200) + "</p>" },
        { id: "c3", href: "c3.xhtml", body: "<p>" + "three ".repeat(200) + "</p>" },
      ],
    });

    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections[0].html).toContain("one");
    expect(result.approximatePercent).toBeGreaterThan(0);
    expect(result.approximatePercent).toBeLessThanOrEqual(100);
  });

  it("ordering follows OPF spine order, not manifest declaration order", async () => {
    // Manifest lists chapter three, then one, then two -- the spine
    // itself (declared separately, in a different order) is what must
    // govern reading order.
    const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>
    <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`;
    const bytes = await buildEpub({
      opfXml,
      docs: [
        { id: "c1", href: "c1.xhtml", body: "<p>CHAPTER-ONE-MARKER " + "x ".repeat(500) + "</p>" },
        { id: "c2", href: "c2.xhtml", body: "<p>CHAPTER-TWO-MARKER " + "x ".repeat(500) + "</p>" },
        { id: "c3", href: "c3.xhtml", body: "<p>CHAPTER-THREE-MARKER " + "x ".repeat(500) + "</p>" },
      ],
    });

    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.sections[0].html).toContain("CHAPTER-ONE-MARKER");
    // Whatever else made it in must respect spine order: two before three.
    const joined = result.sections.map((s) => s.html).join("");
    const twoIdx = joined.indexOf("CHAPTER-TWO-MARKER");
    const threeIdx = joined.indexOf("CHAPTER-THREE-MARKER");
    if (twoIdx !== -1 && threeIdx !== -1) {
      expect(twoIdx).toBeLessThan(threeIdx);
    }
  });

  it("skips the EPUB3 navigation document even if present in spine", async () => {
    const bytes = await buildEpub({
      navId: "nav",
      docs: [
        { id: "nav", href: "nav.xhtml", body: "<p>NAV-SHOULD-NOT-APPEAR</p>" },
        { id: "c1", href: "c1.xhtml", body: "<p>" + "real content ".repeat(300) + "</p>" },
      ],
    });

    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const joined = result.sections.map((s) => s.html).join("");
    expect(joined).not.toContain("NAV-SHOULD-NOT-APPEAR");
  });

  it("skips linear=\"no\" spine items", async () => {
    const bytes = await buildEpub({
      docs: [
        { id: "c1", href: "c1.xhtml", body: "<p>" + "main ".repeat(300) + "</p>" },
        { id: "extra", href: "extra.xhtml", body: "<p>NONLINEAR-SHOULD-NOT-APPEAR</p>", linear: "no" },
      ],
    });

    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const joined = result.sections.map((s) => s.html).join("");
    expect(joined).not.toContain("NONLINEAR-SHOULD-NOT-APPEAR");
  });

  it("does not double-count a spine item referenced twice", async () => {
    const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c1"/>
  </spine>
</package>`;
    const bytes = await buildEpub({
      opfXml,
      docs: [{ id: "c1", href: "c1.xhtml", body: "<p>" + "solo ".repeat(50) + "</p>" }],
    });

    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.sections.length).toBe(1);
  });
});

describe("extractEpubSample: the 10% boundary spans multiple spine documents", () => {
  it("accumulates across several small documents until reaching ~10% of total readable text", async () => {
    // 12 near-equal documents (~8.3% each) -- reaching 10% requires the
    // first document PLUS at least part of the second, never stopping
    // inside document 1 alone.
    const docs: Doc[] = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      href: `c${i}.xhtml`,
      body: `<p>DOC-${i}-MARKER ${"word ".repeat(50)}</p>`,
    }));
    const bytes = await buildEpub({ docs });

    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.sections.length).toBeGreaterThanOrEqual(2);
    expect(result.sections[0].html).toContain("DOC-0-MARKER");
    expect(result.sections[1].html).toContain("DOC-1-MARKER");
  });

  it("never truncates mid-element -- every returned chunk's tags are balanced", async () => {
    const docs: Doc[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      href: `c${i}.xhtml`,
      body: `<p>Paragraph ${i} ${"word ".repeat(40)}</p><p>Second paragraph ${"word ".repeat(40)}</p>`,
    }));
    const bytes = await buildEpub({ docs });

    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    for (const section of result.sections) {
      const opens = section.html.match(/<p>/g)?.length ?? 0;
      const closes = section.html.match(/<\/p>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });
});

describe("extractEpubSample: malformed EPUB / missing structure", () => {
  it("rejects arbitrary non-ZIP bytes", async () => {
    const result = await extractEpubSample(Buffer.from("not a zip at all"));
    expect(result).toEqual({ available: false, reason: "invalid_zip" });
  });

  it("rejects a ZIP with no META-INF/container.xml", async () => {
    const bytes = await buildEpub({ omitContainer: true, docs: [{ id: "c1", href: "c1.xhtml", body: "<p>x</p>" }] });
    const result = await extractEpubSample(bytes);
    expect(result).toEqual({ available: false, reason: "missing_container" });
  });

  it("rejects when the OPF the container points to is absent", async () => {
    const bytes = await buildEpub({ omitOpf: true });
    const result = await extractEpubSample(bytes);
    expect(result).toEqual({ available: false, reason: "missing_opf" });
  });

  it("rejects an OPF with no manifest", async () => {
    const bytes = await buildEpub({
      docs: [{ id: "c1", href: "c1.xhtml", body: "<p>x</p>" }],
      omitManifest: true,
    });
    const result = await extractEpubSample(bytes);
    expect(result).toEqual({ available: false, reason: "missing_manifest" });
  });

  it("rejects an OPF with no spine", async () => {
    const bytes = await buildEpub({
      docs: [{ id: "c1", href: "c1.xhtml", body: "<p>x</p>" }],
      omitSpine: true,
    });
    const result = await extractEpubSample(bytes);
    expect(result).toEqual({ available: false, reason: "missing_spine" });
  });

  it("reports no_readable_content when every spine document is empty of readable text", async () => {
    const bytes = await buildEpub({
      docs: [
        { id: "c1", href: "c1.xhtml", body: "" },
        { id: "c2", href: "c2.xhtml", body: "   \n  " },
      ],
    });
    const result = await extractEpubSample(bytes);
    expect(result).toEqual({ available: false, reason: "no_readable_content" });
  });

  it("skips a spine item whose manifest href doesn't exist in the archive, rather than crashing", async () => {
    const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>
    <item id="ghost" href="does-not-exist.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ghost"/>
    <itemref idref="c1"/>
  </spine>
</package>`;
    const bytes = await buildEpub({
      opfXml,
      docs: [{ id: "c1", href: "c1.xhtml", body: "<p>" + "real ".repeat(50) + "</p>" }],
    });
    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.sections[0].html).toContain("real");
  });
});

describe("extractEpubSample: sanitization security", () => {
  it("strips <script> tags and their content entirely", async () => {
    const bytes = await buildEpub({
      docs: [
        {
          id: "c1",
          href: "c1.xhtml",
          body: `<p>Safe text ${"word ".repeat(30)}</p><script>alert("evil")</script>`,
        },
      ],
    });
    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const joined = result.sections.map((s) => s.html).join("");
    expect(joined).not.toContain("script");
    expect(joined).not.toContain("alert");
    expect(joined).not.toContain("evil");
  });

  it("strips event-handler attributes (dropped along with all attributes on retained tags)", async () => {
    const bytes = await buildEpub({
      docs: [
        {
          id: "c1",
          href: "c1.xhtml",
          body: `<p onclick="evil()" onload="evil2()">Safe text ${"word ".repeat(30)}</p>`,
        },
      ],
    });
    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const joined = result.sections.map((s) => s.html).join("");
    expect(joined).not.toContain("onclick");
    expect(joined).not.toContain("onload");
    expect(joined).not.toContain("evil");
    expect(joined).toContain("<p>Safe text");
  });

  it("strips iframe/object/embed/form/input/button entirely, including their content", async () => {
    const bytes = await buildEpub({
      docs: [
        {
          id: "c1",
          href: "c1.xhtml",
          body: `<p>Before ${"word ".repeat(30)}</p><iframe src="https://evil.example">trapped</iframe><object data="x"><param/></object><embed src="x"/><form><input type="text"/><button>Click</button></form>`,
        },
      ],
    });
    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const joined = result.sections.map((s) => s.html).join("");
    for (const forbidden of ["iframe", "object", "embed", "<form", "<input", "<button", "trapped", "evil.example"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("omits images entirely -- no <img>, no src leakage", async () => {
    const bytes = await buildEpub({
      docs: [
        {
          id: "c1",
          href: "c1.xhtml",
          body: `<p>Text ${"word ".repeat(30)}</p><img src="https://tracker.example/pixel.png" alt="x"/>`,
        },
      ],
    });
    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const joined = result.sections.map((s) => s.html).join("");
    expect(joined).not.toContain("<img");
    expect(joined).not.toContain("tracker.example");
  });

  it("unwraps <a href> links -- keeps visible text, never the href/javascript: URL", async () => {
    const bytes = await buildEpub({
      docs: [
        {
          id: "c1",
          href: "c1.xhtml",
          body: `<p>See <a href="javascript:alert(1)">this footnote</a> ${"word ".repeat(30)}</p>`,
        },
      ],
    });
    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const joined = result.sections.map((s) => s.html).join("");
    expect(joined).not.toContain("javascript:");
    expect(joined).not.toContain("<a ");
    expect(joined).not.toContain("href");
    expect(joined).toContain("this footnote");
  });

  it("only ever emits allowed tags with zero attributes -- no style/class/id leaks through", async () => {
    const bytes = await buildEpub({
      docs: [
        {
          id: "c1",
          href: "c1.xhtml",
          body: `<p style="color:red" class="fancy" id="p1">${"word ".repeat(30)}</p>`,
        },
      ],
    });
    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const joined = result.sections.map((s) => s.html).join("");
    expect(joined).toContain("<p>");
    expect(joined).not.toContain("style=");
    expect(joined).not.toContain("class=");
    expect(joined).not.toContain('id="');
  });

  it("never leaks manuscript_path, a storage path, or a signed URL -- the extractor never sees or handles them", async () => {
    const bytes = await buildEpub({
      docs: [{ id: "c1", href: "c1.xhtml", body: `<p>${"word ".repeat(30)}</p>` }],
    });
    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("manuscript_path");
    expect(serialized).not.toContain("supabase.co");
    expect(serialized).not.toContain("/storage/v1/");
  });
});

describe("extractEpubSample: sample does not return the full book", () => {
  it("returned sample text is meaningfully shorter than the total manuscript text", async () => {
    const docs: Doc[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      href: `c${i}.xhtml`,
      body: `<p>${"filler word ".repeat(200)}</p>`,
    }));
    const bytes = await buildEpub({ docs });

    const result = await extractEpubSample(bytes);
    expect(result.available).toBe(true);
    if (!result.available) return;

    const sampleLength = result.sections.reduce((sum, s) => sum + s.html.length, 0);
    const totalDocsLength = docs.reduce((sum, d) => sum + d.body.length, 0);
    // A generous ceiling -- the true target is ~10%; this only asserts
    // the sample is not anywhere close to the whole book.
    expect(sampleLength).toBeLessThan(totalDocsLength * 0.5);
    expect(result.approximatePercent).toBeLessThan(50);
  });
});

// LIBRUM 2.0 PRODUCT-1 PRE-COMMIT HARDENING: sanitizeBodyIntoChunks is
// the actual security boundary (extractEpubSample just calls it per
// spine document), so these exercise it directly via __internal --
// exactly the fixture set requested by the PRE-COMMIT review's hostile-
// markup audit. The required invariant throughout: malformed input may
// lose content or come back empty, but must NEVER put executable/active
// markup or an attribute of any kind into the output.
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
