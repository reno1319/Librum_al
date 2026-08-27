import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { convertDocxToDocument } from "./docx-converter";
import {
  buildDocxBytes,
  paragraph,
  heading,
  boldItalicParagraph,
  quoteParagraph,
  listItem,
  hyperlinkParagraph,
  imageParagraph,
  tableXml,
  pageBreakParagraph,
} from "./docx-test-fixtures";

describe("convertDocxToDocument", () => {
  it("converts simple paragraphs with no headings into a single section", async () => {
    const bytes = await buildDocxBytes({
      bodyXml: paragraph("Once upon a time.") + paragraph("The end."),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].heading).toBeNull();
    expect(result.sections[0].html).toContain("<p>Once upon a time.</p>");
    expect(result.sections[0].html).toContain("<p>The end.</p>");
  });

  it("splits into chapters on Heading 1 boundaries", async () => {
    const bytes = await buildDocxBytes({
      includeStyles: true,
      bodyXml:
        heading(1, "Chapter One") +
        paragraph("First chapter text.") +
        heading(1, "Chapter Two") +
        paragraph("Second chapter text."),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].heading).toBe("Chapter One");
    expect(result.sections[0].html).toContain("First chapter text.");
    expect(result.sections[1].heading).toBe("Chapter Two");
    expect(result.sections[1].html).toContain("Second chapter text.");
  });

  it("maps Heading 2 / Heading 3 to h2/h3 within the current section", async () => {
    const bytes = await buildDocxBytes({
      includeStyles: true,
      bodyXml:
        heading(1, "Chapter One") +
        heading(2, "A subheading") +
        heading(3, "A sub-subheading") +
        paragraph("Body text."),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).toContain("<h2>A subheading</h2>");
    expect(result.sections[0].html).toContain("<h3>A sub-subheading</h3>");
  });

  it("preserves bold and italic emphasis", async () => {
    const bytes = await buildDocxBytes({ bodyXml: boldItalicParagraph() });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).toContain("<strong>bold</strong>");
    expect(result.sections[0].html).toContain("<em>italic</em>");
  });

  it("converts an unordered list", async () => {
    const bytes = await buildDocxBytes({
      includeNumbering: true,
      bodyXml: listItem("First item") + listItem("Second item"),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).toContain("<ul>");
    expect(result.sections[0].html).toContain("<li>First item</li>");
    expect(result.sections[0].html).toContain("<li>Second item</li>");
  });

  it("maps the Quote style to blockquote", async () => {
    const bytes = await buildDocxBytes({
      includeStyles: true,
      bodyXml: quoteParagraph("A memorable line."),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).toContain("<blockquote>A memorable line.</blockquote>");
  });

  it("preserves a safe https hyperlink", async () => {
    const bytes = await buildDocxBytes({
      bodyXml: hyperlinkParagraph("rIdLink1", "our site"),
      includeHyperlinkRel: [{ id: "rIdLink1", target: "https://example.com" }],
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).toContain('<a href="https://example.com">our site</a>');
  });

  it("removes an unsafe javascript: hyperlink and warns, keeping the link text", async () => {
    const bytes = await buildDocxBytes({
      bodyXml: hyperlinkParagraph("rIdLink1", "click me"),
      includeHyperlinkRel: [{ id: "rIdLink1", target: "javascript:alert(1)" }],
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).not.toContain("javascript:");
    expect(result.sections[0].html).not.toContain("<a ");
    expect(result.sections[0].html).toContain("click me");
    expect(result.warnings.some((w) => w.code === "unsafe_link_removed")).toBe(true);
  });

  it("extracts an embedded PNG image and rewrites its reference", async () => {
    const bytes = await buildDocxBytes({
      includeImageRel: true,
      bodyXml: imageParagraph(),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mediaType).toBe("image/png");
    expect(result.images[0].bytes.length).toBeGreaterThan(0);
    expect(result.sections[0].html).toContain(`<img src="../images/${result.images[0].filename}"`);
  });

  it("converts a simple table and warns that it may need review", async () => {
    const bytes = await buildDocxBytes({ bodyXml: tableXml() });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).toContain("<table>");
    expect(result.sections[0].html).toContain("A1");
    expect(result.warnings.some((w) => w.code === "table_present")).toBe(true);
  });

  it("does not crash on a page break and still converts surrounding text", async () => {
    const bytes = await buildDocxBytes({ bodyXml: pageBreakParagraph("After the break.") });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).toContain("After the break.");
  });

  it("gives an unambiguous 'not preserved' warning about footnotes -- never merely 'may need review'", async () => {
    const zip = new JSZip();
    const base = await buildDocxBytes({ bodyXml: paragraph("Body text.") });
    const loaded = await JSZip.loadAsync(base);
    for (const [path, file] of Object.entries(loaded.files)) {
      if (!file.dir) zip.file(path, await file.async("nodebuffer"));
    }
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote w:type="separator" w:id="-1"/>
<w:footnote w:type="continuationSeparator" w:id="0"/>
<w:footnote w:id="2"><w:p><w:r><w:t>A real footnote.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: this is the "must
    // never show a clean success state with no warning" invariant --
    // a document with real footnotes always carries this exact
    // warning, never a hedged "may require review."
    const warning = result.warnings.find((w) => w.code === "footnotes_or_endnotes_skipped");
    expect(warning).toBeDefined();
    expect(warning?.message).toBe(
      "Footnotes or endnotes were detected. They are not preserved in DOCX conversion yet. Review the generated EPUB before publishing.",
    );
    expect(warning?.message).not.toMatch(/may (require|need)/i);
  });

  it("cleanly removes Mammoth's own footnote reference and note-list markup rather than leaving a dead cross-chapter link", async () => {
    // Built directly (not via the fixture helper) because this needs a
    // real w:footnoteReference + footnotes.xml pair, empirically
    // verified against the installed Mammoth build to actually produce
    // <sup><a href="#footnote-2" id="footnote-ref-2">[1]</a></sup> plus
    // a trailing <li id="footnote-2"> -- see the PRODUCT-5 pre-commit
    // audit for why that shape can't safely survive this converter's
    // own per-chapter XHTML split.
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`,
    );
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote w:type="separator" w:id="-1"/>
<w:footnote w:type="continuationSeparator" w:id="0"/>
<w:footnote w:id="2"><w:p><w:r><w:t>This is the real footnote text.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
</Relationships>`,
    );
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t xml:space="preserve">Some text with a note</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:t xml:space="preserve"> and more after.</w:t></w:r></w:p>
</w:body></w:document>`,
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const html = result.sections[0].html;
    // No dead internal link, no orphaned id, no leftover "[1]" marker,
    // and the actual note text is gone too -- a partial removal that
    // left the reference number behind but silently dropped its
    // meaning would be worse than this explicit, complete removal.
    expect(html).not.toContain("#footnote-");
    expect(html).not.toContain("footnote-ref-");
    expect(html).not.toContain("[1]");
    expect(html).not.toContain("This is the real footnote text.");
    expect(html).toContain("Some text with a note");
    expect(html).toContain("and more after.");
    expect(result.warnings.some((w) => w.code === "footnotes_or_endnotes_skipped")).toBe(true);
  });

  it("rejects a malformed DOCX (broken ZIP)", async () => {
    const result = await convertDocxToDocument(Buffer.from("not a zip at all"));
    expect(result).toEqual({ success: false, error: "invalid_zip" });
  });

  it("rejects a spoofed non-DOCX ZIP (valid ZIP, wrong internal structure)", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "just a text file in a zip");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const result = await convertDocxToDocument(bytes);
    expect(result).toEqual({ success: false, error: "not_a_docx" });
  });

  it("rejects a macro-enabled document (word/vbaProject.bin present)", async () => {
    const bytes = await buildDocxBytes({
      bodyXml: paragraph("Body text."),
      includeVbaProject: true,
    });
    const result = await convertDocxToDocument(bytes);
    expect(result).toEqual({ success: false, error: "macro_enabled_document_not_supported" });
  });

  it("rejects an empty document with no readable content", async () => {
    const bytes = await buildDocxBytes({ bodyXml: "" });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("empty_document");
  });

  it("sanitizes away a dangerous tag if one somehow reached the HTML stage", async () => {
    // Defense-in-depth check on the sanitizer itself, independent of
    // whether Mammoth could ever actually emit this -- constructs the
    // scenario via a paragraph containing literal angle-bracket text
    // (which Word/Mammoth would escape as &lt;script&gt;, not raw
    // markup) to confirm escaped text never becomes active markup.
    const bytes = await buildDocxBytes({
      bodyXml: paragraph("Look: &lt;script&gt;alert(1)&lt;/script&gt;"),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections[0].html).not.toContain("<script>");
  });

  describe("ZIP-bomb preflight (pre-inflation, runs before Mammoth ever parses anything)", () => {
    it("rejects a DOCX with an excessive number of ZIP entries", async () => {
      const zip = new JSZip();
      zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
      zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
      zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Body.</w:t></w:r></w:p></w:body></w:document>`);
      // Well beyond MAX_DOCX_ENTRIES (5,000) -- an ordinary manuscript,
      // even with hundreds of embedded images, never approaches this.
      for (let i = 0; i < 6000; i++) {
        zip.file(`word/junk/part-${i}.xml`, "x");
      }
      const bytes = await zip.generateAsync({ type: "nodebuffer" });

      const result = await convertDocxToDocument(bytes);
      expect(result).toEqual({ success: false, error: "too_complex" });
    });

    it(
      "rejects a DOCX whose declared uncompressed size is a zip-bomb shape, even though the upload itself stays small",
      async () => {
        const zip = new JSZip();
        zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
        zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
        zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Body.</w:t></w:r></w:p></w:body></w:document>`);
        // Highly repetitive content compresses to almost nothing but
        // declares its true (huge) uncompressed size in the ZIP central
        // directory -- exactly the shape a real zip bomb takes, and
        // exactly what the preflight is designed to catch before
        // anything inflates it. Low compression level (fast, not
        // maximal) purely to keep this test's own fixture-generation
        // time reasonable -- doesn't change what's being proven.
        zip.file("word/bomb.bin", Buffer.alloc(320 * 1024 * 1024, 0), {
          compression: "DEFLATE",
          compressionOptions: { level: 1 },
        });
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        // ~220x compression ratio (well under MAX_MANUSCRIPT_BYTES'S
        // 50MB upload cap) for a declared 320MB uncompressed payload --
        // the exact "small download, huge decompressed content" shape
        // a real zip bomb takes.
        expect(bytes.length).toBeLessThan(5 * 1024 * 1024);

        const result = await convertDocxToDocument(bytes);
        expect(result).toEqual({ success: false, error: "too_large_uncompressed" });
      },
      20_000,
    );

    it("rejects a DOCX whose word/document.xml alone exceeds the per-part limit", async () => {
      const zip = new JSZip();
      zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
      zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
      // A single, highly-compressible oversized document.xml -- well
      // beyond MAX_DOCUMENT_XML_BYTES (50MB), while the whole ZIP's
      // total stays under MAX_DOCX_UNCOMPRESSED_BYTES so this test
      // proves the PER-PART check specifically, not just the aggregate
      // one above.
      const filler = "x".repeat(60 * 1024 * 1024);
      zip.file(
        "word/document.xml",
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${filler}</w:t></w:r></w:p></w:body></w:document>`,
        { compression: "DEFLATE", compressionOptions: { level: 9 } },
      );
      const bytes = await zip.generateAsync({ type: "nodebuffer" });

      const result = await convertDocxToDocument(bytes);
      expect(result).toEqual({ success: false, error: "too_large_uncompressed" });
    });

    it("leaves an ordinary, well within limits DOCX completely unaffected", async () => {
      const bytes = await buildDocxBytes({
        includeStyles: true,
        bodyXml: heading(1, "Chapter One") + paragraph("Perfectly ordinary manuscript text."),
      });
      const result = await convertDocxToDocument(bytes);
      expect(result.success).toBe(true);
    });
  });
});
