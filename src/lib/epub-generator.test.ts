import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import JSZip from "jszip";
import { generateEpub, patchEpubMetadata } from "./epub-generator";
import { validateEpubStructure } from "./epub-validation";
import { extractEpubSample } from "./epub-sample";
import { convertDocxToDocument } from "./docx-converter";
import {
  buildDocxBytes,
  heading,
  paragraph,
  boldItalicParagraph,
  imageParagraph,
  tinyPngBytes,
  hyperlinkParagraph,
} from "./docx-test-fixtures";

const BASE_INPUT = {
  bookId: "11111111-1111-1111-1111-111111111111",
  title: "The Test Book",
  authorName: "A. Uthor",
  sections: [
    { heading: "Chapter One", html: "<p>First chapter text.</p>" },
    { heading: "Chapter Two", html: "<p>Second chapter text.</p>" },
  ],
  images: [],
};

describe("generateEpub", () => {
  it("produces a ZIP with mimetype as the first entry, stored uncompressed, with the exact required value", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const zip = await JSZip.loadAsync(bytes);
    const mimetypeFile = zip.file("mimetype");
    expect(mimetypeFile).not.toBeNull();
    const mimetype = await mimetypeFile!.async("string");
    expect(mimetype).toBe("application/epub+zip");

    // JSZip's own options.compression is documented (see
    // epub-validation.ts's own comment) as a WRITE-facing field that
    // always reads back null after loadAsync() -- there is no public
    // JSZip API to confirm compression from a loaded object. Checked
    // instead at the raw ZIP byte level: the EPUB OCF spec requires
    // mimetype to be the FIRST local file header in the archive, and
    // a local file header's compression-method field is a fixed
    // 2-byte little-endian value at byte offset 8 (after the 4-byte
    // "PK\x03\x04" signature and 2-byte version field) -- 0 means
    // STORE (uncompressed).
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50); // local file header signature
    expect(bytes.readUInt16LE(8)).toBe(0); // compression method: 0 = STORE
    const nameLength = bytes.readUInt16LE(26);
    expect(bytes.subarray(30, 30 + nameLength).toString("ascii")).toBe("mimetype");
  });

  it("includes a valid META-INF/container.xml pointing at the OPF", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const zip = await JSZip.loadAsync(bytes);
    const containerXml = await zip.file("META-INF/container.xml")!.async("string");
    expect(containerXml).toContain('full-path="OEBPS/content.opf"');
    expect(zip.file("OEBPS/content.opf")).not.toBeNull();
  });

  it("writes correct dc:title, dc:creator, and a book-id-derived dc:identifier -- never an invented ISBN", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>The Test Book</dc:title>");
    expect(opf).toContain("<dc:creator>A. Uthor</dc:creator>");
    expect(opf).toContain(`urn:librum:book:${BASE_INPUT.bookId}`);
    expect(opf).not.toMatch(/isbn/i);
  });

  // SQ-17: every book on Librum is Albanian, so an omitted language
  // is "sq" (was "und", which left Edit Book's Word books unlabelled).
  it("writes dc:language as 'sq' when no language is supplied", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:language>sq</dc:language>");
    expect(opf).not.toContain("<dc:language>und</dc:language>");
  });

  // LIBRUM 2.0 PUBLISHING-UX-1 PART B: `language` is a new, optional
  // EpubGeneratorInput field -- no current caller (docx-actions.ts)
  // supplies it yet, so the "omitted" case above is the real-world
  // regression to protect; these three cover the field's own contract
  // directly, for whenever a future caller does start supplying it.
  it("writes the real language code when supplied", async () => {
    const bytes = await generateEpub({ ...BASE_INPUT, language: "sq" });
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:language>sq</dc:language>");
  });

  it("falls back to 'sq' for an explicit null language -- never crashes", async () => {
    const bytes = await generateEpub({ ...BASE_INPUT, language: null });
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:language>sq</dc:language>");
  });

  it("falls back to 'sq' for a blank/whitespace-only language", async () => {
    const bytes = await generateEpub({ ...BASE_INPUT, language: "   " });
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:language>sq</dc:language>");
  });

  it("lists every chapter in the manifest and spine, in section order", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain('<item id="chapter1" href="chapter-1.xhtml"');
    expect(opf).toContain('<item id="chapter2" href="chapter-2.xhtml"');
    const spineOrder = [...opf.matchAll(/<itemref idref="(chapter\d+)"\/>/g)].map((m) => m[1]);
    expect(spineOrder).toEqual(["chapter1", "chapter2"]);
    expect(zip.file("OEBPS/chapter-1.xhtml")).not.toBeNull();
    expect(zip.file("OEBPS/chapter-2.xhtml")).not.toBeNull();
  });

  it("marks the nav document with properties=\"nav\" in the manifest", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toMatch(/<item id="nav" href="nav\.xhtml"[^>]*properties="nav"/);
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('href="chapter-1.xhtml"');
    expect(nav).toContain("Chapter One");
  });

  it("builds a minimal valid nav even when no section has a heading", async () => {
    const bytes = await generateEpub({
      ...BASE_INPUT,
      sections: [{ heading: null, html: "<p>Only text, no headings.</p>" }],
    });
    const zip = await JSZip.loadAsync(bytes);
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain("<ol>");
    expect(nav).toContain("<li>");
  });

  it("produces well-formed XHTML content documents containing the section's own html", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const zip = await JSZip.loadAsync(bytes);
    const chapter1 = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter1).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(chapter1).toContain("<h1>Chapter One</h1>");
    expect(chapter1).toContain("<p>First chapter text.</p>");
    expect(chapter1).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    // Balanced tags -- every opened element in this fragment has a
    // matching close (a weak but real well-formedness signal without
    // pulling in a full XML parser dependency).
    const opens = [...chapter1.matchAll(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?(?<!\/)>/g)].map((m) => m[1]);
    const closes = [...chapter1.matchAll(/<\/([a-zA-Z][\w-]*)>/g)].map((m) => m[1]);
    const voidTags = new Set(["meta", "link", "br", "hr", "img"]);
    expect(opens.filter((t) => !voidTags.has(t)).sort()).toEqual(closes.sort());
  });

  it("includes embedded images in the manifest and writes their bytes", async () => {
    const bytes = await generateEpub({
      ...BASE_INPUT,
      sections: [{ heading: "Chapter One", html: '<p>Text.</p><img src="images/img-1.png" alt=""/>' }],
      images: [{ filename: "img-1.png", mediaType: "image/png", bytes: tinyPngBytes() }],
    });
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain('<item id="image1" href="images/img-1.png" media-type="image/png"/>');
    const imageFile = zip.file("OEBPS/images/img-1.png");
    expect(imageFile).not.toBeNull();
    const written = await imageFile!.async("nodebuffer");
    expect(written.equals(tinyPngBytes())).toBe(true);
  });

  it("passes the EXISTING validateEpubStructure() unchanged", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const result = await validateEpubStructure(bytes);
    expect(result).toEqual({ valid: true });
  });

  it("passes validateEpubStructure() for a single-section book with no heading", async () => {
    const bytes = await generateEpub({
      ...BASE_INPUT,
      sections: [{ heading: null, html: "<p>Just one section.</p>" }],
    });
    const result = await validateEpubStructure(bytes);
    expect(result).toEqual({ valid: true });
  });
});

describe("patchEpubMetadata", () => {
  it("replaces dc:title/dc:creator/dcterms:modified while leaving every other entry byte-for-byte untouched", async () => {
    const original = await generateEpub({
      ...BASE_INPUT,
      images: [{ filename: "img-1.png", mediaType: "image/png", bytes: tinyPngBytes() }],
      sections: [{ heading: "Chapter One", html: '<p>Text.</p><img src="images/img-1.png" alt=""/>' }],
    });

    const patched = await patchEpubMetadata(original, "New Title", "New Author");

    const originalZip = await JSZip.loadAsync(original);
    const patchedZip = await JSZip.loadAsync(patched);

    const patchedOpf = await patchedZip.file("OEBPS/content.opf")!.async("string");
    expect(patchedOpf).toContain("<dc:title>New Title</dc:title>");
    expect(patchedOpf).toContain("<dc:creator>New Author</dc:creator>");
    expect(patchedOpf).not.toContain(BASE_INPUT.title);
    expect(patchedOpf).not.toContain(BASE_INPUT.authorName);
    // dc:language/dc:identifier/manifest/spine survive untouched --
    // only title/creator/modified were meant to change.
    expect(patchedOpf).toContain("<dc:language>sq</dc:language>");
    expect(patchedOpf).toContain(`urn:librum:book:${BASE_INPUT.bookId}`);

    const originalChapter = await originalZip.file("OEBPS/chapter-1.xhtml")!.async("string");
    const patchedChapter = await patchedZip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(patchedChapter).toBe(originalChapter);

    const originalImage = await originalZip.file("OEBPS/images/img-1.png")!.async("nodebuffer");
    const patchedImage = await patchedZip.file("OEBPS/images/img-1.png")!.async("nodebuffer");
    expect(patchedImage.equals(originalImage)).toBe(true);
  });

  it("still passes validateEpubStructure() after patching", async () => {
    const original = await generateEpub(BASE_INPUT);
    const patched = await patchEpubMetadata(original, "New Title", "New Author");
    const result = await validateEpubStructure(patched);
    expect(result).toEqual({ valid: true });
  });

  it("preserves mimetype as the first entry, stored uncompressed, at the raw byte level after patching", async () => {
    const original = await generateEpub(BASE_INPUT);
    const patched = await patchEpubMetadata(original, "New Title", "New Author");
    expect(patched.readUInt32LE(0)).toBe(0x04034b50);
    expect(patched.readUInt16LE(8)).toBe(0); // STORE
    const nameLength = patched.readUInt16LE(26);
    expect(patched.subarray(30, 30 + nameLength).toString("ascii")).toBe("mimetype");
    const mimetypeContent = await (await JSZip.loadAsync(patched)).file("mimetype")!.async("string");
    expect(mimetypeContent).toBe("application/epub+zip");
  });

  it("XML-escapes a title/author containing special characters", async () => {
    const original = await generateEpub(BASE_INPUT);
    const patched = await patchEpubMetadata(original, `Tom & Jerry <2>`, `O'Brien "Ace"`);
    const opf = await (await JSZip.loadAsync(patched)).file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>Tom &amp; Jerry &lt;2&gt;</dc:title>");
    expect(opf).toContain(`<dc:creator>O'Brien &quot;Ace&quot;</dc:creator>`);
  });

  it("handles a generated EPUB well over Vercel's ~4.5MB function payload limit entirely in-process, without any request/response boundary involved", async () => {
    // A synthetic illustrated manuscript sized to produce a generated
    // EPUB comfortably over 4.5MB -- proving patchEpubMetadata() (and
    // by extension repackageWithTitle(), which calls it) never needs
    // to move an EPUB this size through any Vercel Function body, in
    // either direction, to do a title change.
    // Genuinely random (incompressible) bytes -- DEFLATE can't shrink
    // these the way it would real repeated/structured data, so the
    // resulting ZIP stays close to the raw byte count. Not real PNG
    // bytes, but generateEpub() writes image bytes through as-is
    // without decoding them, so that's irrelevant to this test.
    const bigImage = randomBytes(3 * 1024 * 1024);
    const original = await generateEpub({
      ...BASE_INPUT,
      images: [
        { filename: "img-1.png", mediaType: "image/png", bytes: bigImage },
        { filename: "img-2.png", mediaType: "image/png", bytes: bigImage },
      ],
    });
    expect(original.length).toBeGreaterThan(4.5 * 1024 * 1024);

    const patched = await patchEpubMetadata(original, "Illustrated Title", "Illustrated Author");
    expect(patched.length).toBeGreaterThan(4.5 * 1024 * 1024);

    const opf = await (await JSZip.loadAsync(patched)).file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>Illustrated Title</dc:title>");
    const result = await validateEpubStructure(patched);
    expect(result).toEqual({ valid: true });
  });

  // LIBRUM 2.0 PUBLISHING-UX-1 PART C: the new, optional fourth
  // `language` parameter. The omitted-parameter case is already the
  // real-world regression the tests above protect (every call above
  // passes only title+author, and dc:language still reads "sq") --
  // these cover the parameter's own contract directly: an explicit
  // code patches dc:language, an explicit null/blank falls back to
  // "sq" via the same resolveEpubLanguageCode() generateEpub() itself
  // already uses (one resolution rule, shared, never two independently
  // invented ones).
  describe("language parameter", () => {
    it.each(["sq", "en", "it"])("patches dc:language to '%s' when explicitly supplied", async (code) => {
      const original = await generateEpub(BASE_INPUT);
      const patched = await patchEpubMetadata(original, "New Title", "New Author", code);
      const opf = await (await JSZip.loadAsync(patched)).file("OEBPS/content.opf")!.async("string");
      expect(opf).toContain(`<dc:language>${code}</dc:language>`);
    });

    it("falls back to 'sq' when language is explicitly null", async () => {
      const original = await generateEpub(BASE_INPUT);
      const patched = await patchEpubMetadata(original, "New Title", "New Author", null);
      const opf = await (await JSZip.loadAsync(patched)).file("OEBPS/content.opf")!.async("string");
      expect(opf).toContain("<dc:language>sq</dc:language>");
    });

    it("falls back to 'sq' when language is explicitly blank/whitespace-only", async () => {
      const original = await generateEpub(BASE_INPUT);
      const patched = await patchEpubMetadata(original, "New Title", "New Author", "   ");
      const opf = await (await JSZip.loadAsync(patched)).file("OEBPS/content.opf")!.async("string");
      expect(opf).toContain("<dc:language>sq</dc:language>");
    });

    it("leaves a previously-patched dc:language completely untouched when a later call omits the parameter", async () => {
      const original = await generateEpub(BASE_INPUT);
      const firstPatch = await patchEpubMetadata(original, "First Title", "First Author", "en");
      const firstOpf = await (await JSZip.loadAsync(firstPatch)).file("OEBPS/content.opf")!.async("string");
      expect(firstOpf).toContain("<dc:language>en</dc:language>");

      // No fourth argument at all -- the omitted case, not an explicit
      // undefined -- must leave the "en" set by the first patch alone.
      const secondPatch = await patchEpubMetadata(firstPatch, "Second Title", "Second Author");
      const secondOpf = await (await JSZip.loadAsync(secondPatch)).file("OEBPS/content.opf")!.async("string");
      expect(secondOpf).toContain("<dc:language>en</dc:language>");
      expect(secondOpf).toContain("<dc:title>Second Title</dc:title>");
    });
  });
});

describe("DOCX -> EPUB -> Read Sample round trip", () => {
  it("a real converted DOCX produces an EPUB that validates and extracts a real Read Sample", async () => {
    const docxBytes = await buildDocxBytes({
      includeStyles: true,
      includeImageRel: true,
      bodyXml:
        heading(1, "Chapter One") +
        paragraph("This is the opening line of the story.") +
        boldItalicParagraph() +
        imageParagraph() +
        heading(1, "Chapter Two") +
        paragraph("This is the second chapter, continuing the story onward."),
    });

    const conversion = await convertDocxToDocument(docxBytes);
    expect(conversion.success).toBe(true);
    if (!conversion.success) return;

    const epubBytes = await generateEpub({
      bookId: "22222222-2222-2222-2222-222222222222",
      title: "Round Trip Book",
      authorName: "Round Trip Author",
      sections: conversion.sections,
      images: conversion.images,
    });

    // 1. The EXISTING, unmodified EPUB validator this app already uses
    // for every uploaded EPUB.
    const validation = await validateEpubStructure(epubBytes);
    expect(validation).toEqual({ valid: true });

    // 2. The EXISTING, unmodified PRODUCT-1 sample extractor -- proves
    // a DOCX-converted book works with Read Sample with zero
    // DOCX-specific code path anywhere in that pipeline.
    const sample = await extractEpubSample(epubBytes);
    expect(sample.available).toBe(true);
    if (!sample.available) return;
    expect(sample.sections.length).toBeGreaterThan(0);
    const allSampleText = sample.sections.map((s) => s.html).join(" ");
    expect(allSampleText).toContain("opening line of the story");
  });

  // LIBRUM 2.0 PRODUCT-5 EPUB-SAMPLE-AVAILABILITY CORRECTION: a
  // production report investigated a published book converted from a
  // real 8.3MB DOCX ("Nancy Drew KDP Final.docx") apparently showing no
  // Read Sample -- root cause turned out to be unrelated to DOCX/EPUB
  // structure at all (see book-purchase.test.ts's own comment: the
  // report's screenshots were the author's own view, where Read Sample
  // has always been intentionally omitted). Still, the test directly
  // above uses a trivially small two-paragraph fixture -- nothing like
  // a real ~60,000-word novel's chapter count, paragraph volume, or
  // embedded-image count. This test closes that gap: a synthetic
  // manuscript sized to genuinely stress the same pipeline (many
  // chapters, real paragraph volume approaching a real short novel,
  // multiple embedded images), proving the full DOCX -> EPUB ->
  // validateEpubStructure() -> extractEpubSample() chain still succeeds
  // at production scale, not just on a minimal fixture.
  it("a large, multi-chapter, illustrated DOCX (production-scale, not a trivial fixture) still converts, validates, and extracts a real Read Sample", async () => {
    const CHAPTER_COUNT = 20;
    const PARAGRAPHS_PER_CHAPTER = 40;
    // Generic, non-copyrighted placeholder prose -- long enough per
    // paragraph, and repeated enough times, that the resulting
    // manuscript's total readable text approaches a real short novel's
    // scale (twenty chapters this size is on the order of 60,000+
    // words), not merely "large enough to not be trivial."
    const SENTENCE =
      "The old clock ticked steadily on the mantel while the detective considered every clue " +
      "gathered so far, turning each detail over as the rain traced long lines down the window " +
      "and the house settled into its familiar evening quiet.";

    let bodyXml = "";
    for (let chapter = 1; chapter <= CHAPTER_COUNT; chapter++) {
      bodyXml += heading(1, `Chapter ${chapter}`);
      for (let p = 0; p < PARAGRAPHS_PER_CHAPTER; p++) {
        bodyXml += paragraph(`${SENTENCE} (chapter ${chapter}, paragraph ${p + 1})`);
      }
      if (chapter === 1) bodyXml += imageParagraph();
    }

    const docxBytes = await buildDocxBytes({
      includeStyles: true,
      includeImageRel: true,
      bodyXml,
    });

    const conversion = await convertDocxToDocument(docxBytes);
    expect(conversion.success).toBe(true);
    if (!conversion.success) return;
    expect(conversion.sections.length).toBe(CHAPTER_COUNT);

    const epubBytes = await generateEpub({
      bookId: "33333333-3333-3333-3333-333333333333",
      title: "The Secret of the Old Clock (synthetic, non-copyrighted fixture)",
      authorName: "Test Author",
      sections: conversion.sections,
      images: conversion.images,
    });

    const validation = await validateEpubStructure(epubBytes);
    expect(validation).toEqual({ valid: true });

    const sample = await extractEpubSample(epubBytes);
    expect(sample.available).toBe(true);
    if (!sample.available) return;
    expect(sample.sections.length).toBeGreaterThan(0);
    // A real ~10% sample of a 20-chapter book should land well short of
    // the whole book, not accidentally include everything.
    expect(sample.sections.length).toBeLessThan(CHAPTER_COUNT);
    expect(sample.approximatePercent).toBeGreaterThan(0);
    expect(sample.approximatePercent).toBeLessThanOrEqual(15);
    const allSampleText = sample.sections.map((s) => s.html).join(" ");
    expect(allSampleText).toContain("chapter 1, paragraph 1");
  }, 20000);
});

// SQ-17: the words Librum writes into a Word-made e-book are Albanian,
// and every page names its language.
describe("generated EPUB text (SQ-17)", () => {
  async function files(input: Parameters<typeof generateEpub>[0]) {
    const zip = await JSZip.loadAsync(await generateEpub(input));
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    return { nav, chapter };
  }

  it("the table of contents page is titled Përmbajtja", async () => {
    const { nav } = await files(BASE_INPUT);
    expect(nav).toContain("<title>Përmbajtja</title>");
    expect(nav).toContain("<h1>Përmbajtja</h1>");
    expect(nav).not.toContain("Table of Contents");
  });

  it("a book with no chapter headings gets the single entry Fillimi and untitled pages named Pjesë", async () => {
    const input = {
      ...BASE_INPUT,
      sections: BASE_INPUT.sections.map((section) => ({ ...section, heading: null })),
    };
    const { nav, chapter } = await files(input);
    expect(nav).toContain(">Fillimi</a>");
    expect(nav).not.toContain(">Start<");
    expect(chapter).toContain("<title>Pjesë</title>");
    expect(chapter).not.toContain("<title>Section</title>");
  });

  it("the contents and chapter pages carry the book language", async () => {
    const plain = await files(BASE_INPUT);
    expect(plain.nav).toContain('xml:lang="sq" lang="sq"');
    expect(plain.chapter).toContain('xml:lang="sq" lang="sq"');
    const english = await files({ ...BASE_INPUT, language: "en" });
    expect(english.chapter).toContain('xml:lang="en" lang="en"');
  });

  it("generated pages are still a valid EPUB", async () => {
    const result = await validateEpubStructure(await generateEpub(BASE_INPUT));
    expect(result).toEqual({ valid: true });
  });
});

// W2: the old tests only compared strings, so an image path that pointed
// outside the book ("../images/x") passed while every picture was
// broken in real readers. This opens the generated EPUB and resolves
// every src/href in every page and in the package file, the way a
// reading app does.
async function unresolvedReferences(epubBytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(epubBytes);
  const missing: string[] = [];
  // Resolves `ref` against the folder of `fromFile`; null when the
  // path climbs out of the EPUB, which can never resolve.
  const resolve = (fromFile: string, ref: string): string | null => {
    const parts = fromFile.split("/").slice(0, -1);
    for (const seg of ref.split("#")[0].split("/")) {
      if (seg === "..") {
        if (parts.length === 0) return null;
        parts.pop();
      } else if (seg !== "." && seg !== "") parts.push(decodeURIComponent(seg));
    }
    return parts.join("/");
  };
  for (const path of Object.keys(zip.files)) {
    if (!/\.(xhtml|opf)$/.test(path)) continue;
    const text = await zip.file(path)!.async("string");
    for (const m of text.matchAll(/\b(?:src|href)="([^"]*)"/g)) {
      const ref = m[1];
      if (/^(?:https?:|mailto:)/.test(ref) || ref.startsWith("#")) continue;
      const target = resolve(path, ref);
      if (target === null || !zip.file(target)) missing.push(`${path} -> ${ref}`);
    }
  }
  return missing;
}

describe("generated EPUB references (W2)", () => {
  it("every picture, link, stylesheet and manifest entry in a converted book points at a file inside the EPUB", async () => {
    const docxBytes = await buildDocxBytes({
      includeStyles: true,
      includeImageRel: true,
      includeHyperlinkRel: [{ id: "rIdLink1", target: "https://example.com" }],
      bodyXml:
        heading(1, "Kapitulli 1") +
        paragraph("Fillimi.") +
        imageParagraph() +
        hyperlinkParagraph("rIdLink1", "faqja") +
        heading(1, "Ana &amp; Beni") +
        imageParagraph(),
    });
    const conversion = await convertDocxToDocument(docxBytes);
    expect(conversion.success).toBe(true);
    if (!conversion.success) return;
    const epubBytes = await generateEpub({
      ...BASE_INPUT,
      sections: conversion.sections,
      images: conversion.images,
    });

    const zip = await JSZip.loadAsync(epubBytes);
    const chapterOne = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapterOne).toMatch(/<img src="[^"]+"/);
    expect(await unresolvedReferences(epubBytes)).toEqual([]);
  });

  it("the reference check itself catches the old broken '../images/' path", async () => {
    const epubBytes = await generateEpub({
      ...BASE_INPUT,
      sections: [{ heading: "Kapitulli 1", html: '<p>x</p><img src="../images/img-1.png" alt=""/>' }],
      images: [{ filename: "img-1.png", mediaType: "image/png", bytes: tinyPngBytes() }],
    });
    expect(await unresolvedReferences(epubBytes)).toEqual(["OEBPS/chapter-1.xhtml -> ../images/img-1.png"]);
  });

  it("writes '&' in a chapter title escaped exactly once in the page, its title and the contents", async () => {
    const docxBytes = await buildDocxBytes({
      includeStyles: true,
      bodyXml: heading(1, "Ana &amp; Beni") + paragraph("Tekst."),
    });
    const conversion = await convertDocxToDocument(docxBytes);
    expect(conversion.success).toBe(true);
    if (!conversion.success) return;
    const epubBytes = await generateEpub({ ...BASE_INPUT, sections: conversion.sections, images: [] });
    const zip = await JSZip.loadAsync(epubBytes);
    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    for (const page of [chapter, nav]) {
      expect(page).toContain("Ana &amp; Beni");
      expect(page).not.toContain("&amp;amp;");
    }
    expect(chapter).toContain("<title>Ana &amp; Beni</title>");
  });
});

describe("Word-made book look (W3)", () => {
  it("indents paragraphs like a printed book: first-line indent, no gap, none after a heading or scene break", async () => {
    const zip = await JSZip.loadAsync(await generateEpub(BASE_INPUT));
    const css = await zip.file("OEBPS/styles.css")!.async("string");
    expect(css).toContain("p { margin: 0; text-indent: 1.5em; }");
    expect(css).toMatch(/h1 \+ p[^{]*p\.scene-break \+ p[^{]*\{ text-indent: 0; \}/);
    // Production gets the same book look (answers 1a/2a, 31 Oct); only
    // the emergency switch DOCX_CLEANUP_OFF brings back the old gap.
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DOCX_CLEANUP_OFF", "");
    try {
      const prodZip = await JSZip.loadAsync(await generateEpub(BASE_INPUT));
      expect(await prodZip.file("OEBPS/styles.css")!.async("string")).toBe(css);
      vi.stubEnv("DOCX_CLEANUP_OFF", "1");
      const offZip = await JSZip.loadAsync(await generateEpub(BASE_INPUT));
      const offCss = await offZip.file("OEBPS/styles.css")!.async("string");
      expect(offCss).toContain("p { margin: 0 0 1em; }");
      expect(offCss).not.toContain("text-indent: 1.5em");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(css).toContain("p.scene-break { text-align: center;");
    expect(css).not.toContain("p { margin: 0 0 1em; }");
  });

  it("styles kept blank lines and notes (W3 Part 2), and the switched-off stylesheet stays as it was", async () => {
    const zip = await JSZip.loadAsync(await generateEpub(BASE_INPUT));
    const css = await zip.file("OEBPS/styles.css")!.async("string");
    expect(css).toContain("p.gap, p.gap + p { text-indent: 0; }");
    expect(css).toContain("aside.footnote { font-size: 0.9em;");
    expect(css).toContain("aside.footnote p, div.endnote p { text-indent: 0; }");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DOCX_CLEANUP_OFF", "1");
    try {
      const prodCss = await (await JSZip.loadAsync(await generateEpub(BASE_INPUT))).file("OEBPS/styles.css")!.async("string");
      expect(prodCss).not.toMatch(/gap|footnote|endnote|sup a/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("puts a title's note links after a two-line title, and keeps them when the title was only a note number", async () => {
    const link = '<sup><a epub:type="noteref" href="#fn-1" id="fnref-1">1</a></sup>';
    const zip = await JSZip.loadAsync(
      await generateEpub({
        ...BASE_INPUT,
        sections: [
          { heading: "Kapitulli 1: Ana", headingLines: ["Kapitulli 1", "Ana"], headingNotes: link, html: "<p>Teksti.</p>" },
          { heading: null, headingNotes: link.replace(/1/g, "2"), html: "<p>Më tej.</p>" },
        ],
      }),
    );
    expect(await zip.file("OEBPS/chapter-1.xhtml")!.async("string")).toContain(`<h1>Kapitulli 1<br/>Ana${link}</h1>`);
    expect(await zip.file("OEBPS/chapter-2.xhtml")!.async("string")).toContain(`<p>${link.replace(/1/g, "2")}</p>\n<p>Më tej.</p>`);
  });

  it("shows a two-line chapter title on two lines and its one-line form in the contents", async () => {
    const zip = await JSZip.loadAsync(
      await generateEpub({
        ...BASE_INPUT,
        sections: [{ heading: "Kapitulli 1: Ana & Beni", headingLines: ["Kapitulli 1", "Ana & Beni"], html: "<p>Teksti.</p>" }],
      }),
    );
    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter).toContain("<h1>Kapitulli 1<br/>Ana &amp; Beni</h1>");
    expect(chapter).toContain("<title>Kapitulli 1: Ana &amp; Beni</title>");
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain(">Kapitulli 1: Ana &amp; Beni</a>");
  });
});
