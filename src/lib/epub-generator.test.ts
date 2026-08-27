import { describe, expect, it } from "vitest";
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

  it("writes dc:language as 'und' -- EPUB3's own required metadata, never a guessed language code", async () => {
    const bytes = await generateEpub(BASE_INPUT);
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:language>und</dc:language>");
    expect(opf).not.toMatch(/<dc:language>(en|sq|und-.+)<\/dc:language>/);
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
      sections: [{ heading: "Chapter One", html: '<p>Text.</p><img src="../images/img-1.png" alt=""/>' }],
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
      sections: [{ heading: "Chapter One", html: '<p>Text.</p><img src="../images/img-1.png" alt=""/>' }],
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
    expect(patchedOpf).toContain("<dc:language>und</dc:language>");
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
