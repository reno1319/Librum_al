import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { generateEpub } from "./epub-generator";
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
});
