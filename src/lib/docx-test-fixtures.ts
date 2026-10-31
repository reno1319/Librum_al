import JSZip from "jszip";

// LIBRUM 2.0 PRODUCT-5: synthetic DOCX fixtures, built by hand with
// JSZip -- same "write with JSZip, read with the real
// parser/validator" discipline already established in this codebase
// (src/app/dashboard/books/actions.test.ts builds a minimal-but-valid
// EPUB the same way). No copyrighted book content anywhere. Every XML
// fragment below was empirically verified against the real, installed
// Mammoth build before being relied on in a test (see the PRODUCT-5
// audit) -- these aren't guessed-at OOXML, they're the minimum
// concretely confirmed to produce the expected HTML.

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function tinyPngBytes(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, "base64");
}

type BuildOptions = {
  bodyXml: string;
  includeStyles?: boolean;
  includeNumbering?: boolean;
  includeImageRel?: boolean;
  includeHyperlinkRel?: { id: string; target: string; external?: boolean }[];
  includeVbaProject?: boolean;
  contentTypesOverride?: string;
  // W2: extra paragraph styles written into styles.xml (needs
  // includeStyles), e.g. Word's own "Title" or "toc 1".
  extraParagraphStyles?: { id: string; name: string }[];
  // W3: numbering definitions (inside <w:numbering>) replacing the
  // default bullet list (needs includeNumbering).
  numberingXml?: string;
  // W3: a footnotes part with one note, w:id="2".
  includeFootnotes?: boolean;
  // W3 Part 2: footnotes/endnotes parts with these notes (see note()).
  footnotesXml?: string;
  endnotesXml?: string;
};

export async function buildDocxBytes(options: BuildOptions): Promise<Buffer> {
  const zip = new JSZip();

  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    options.includeStyles
      ? `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
      : "",
    options.includeFootnotes || options.footnotesXml !== undefined
      ? `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>`
      : "",
    options.endnotesXml !== undefined
      ? `<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>`
      : "",
    options.includeNumbering
      ? `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`
      : "",
  ].join("\n");

  zip.file(
    "[Content_Types].xml",
    options.contentTypesOverride ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
${overrides}
</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  if (options.includeStyles) {
    zip.file(
      "word/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/></w:style>
${(options.extraParagraphStyles ?? [])
  .map((st) => `<w:style w:type="paragraph" w:styleId="${st.id}"><w:name w:val="${st.name}"/><w:basedOn w:val="Normal"/></w:style>`)
  .join("\n")}
</w:styles>`,
    );
  }

  if (options.includeNumbering) {
    zip.file(
      "word/numbering.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${options.numberingXml ?? `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`}
</w:numbering>`,
    );
  }

  if (options.includeFootnotes) {
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="2"><w:p><w:r><w:t>Shënim.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    );
  }

  for (const [kind, xml] of [["footnote", options.footnotesXml], ["endnote", options.endnotesXml]] as const) {
    if (xml === undefined) continue;
    zip.file(
      `word/${kind}s.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${kind}s xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:${kind} w:type="separator" w:id="-1"/><w:${kind} w:type="continuationSeparator" w:id="0"/>${xml}</w:${kind}s>`,
    );
  }

  if (options.includeImageRel) {
    zip.file("word/media/image1.png", tinyPngBytes());
  }

  if (options.includeVbaProject) {
    zip.file("word/vbaProject.bin", Buffer.from([0x00, 0x01, 0x02]));
  }

  const relEntries = [
    options.includeStyles
      ? `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      : "",
    options.includeNumbering
      ? `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`
      : "",
    options.includeFootnotes || options.footnotesXml !== undefined
      ? `<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>`
      : "",
    options.endnotesXml !== undefined
      ? `<Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>`
      : "",
    options.includeImageRel
      ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>`
      : "",
    ...(options.includeHyperlinkRel ?? []).map(
      (link) =>
        `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${link.target}"${link.external === false ? "" : ' TargetMode="External"'}/>`,
    ),
  ].join("\n");

  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relEntries}
</Relationships>`,
  );

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${options.bodyXml}</w:body></w:document>`,
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

export function paragraph(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

export function heading(level: 1 | 2 | 3, text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

export function boldItalicParagraph(): string {
  return `<w:p><w:r><w:t xml:space="preserve">Some </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>`;
}

export function quoteParagraph(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

export function listItem(text: string): string {
  return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

export function hyperlinkParagraph(relId: string, text: string): string {
  return `<w:p><w:hyperlink r:id="${relId}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`;
}

export function imageParagraph(): string {
  return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100000" cy="100000"/><wp:docPr id="1" name="Picture 1"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

export function tableXml(): string {
  return `<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>`;
}

export function pageBreakParagraph(text: string): string {
  return `<w:p><w:r><w:br w:type="page"/><w:t>${text}</w:t></w:r></w:p>`;
}

// W2: a paragraph in the given Word style id.
export function styledParagraph(styleId: string, text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

// W2: a link to a bookmark inside the document, the way Word's own
// table of contents writes it.
export function internalLinkParagraph(anchor: string, text: string): string {
  return `<w:p><w:hyperlink w:anchor="${anchor}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`;
}

// W2: a paragraph holding only a bookmark -- no visible text.
export function bookmarkOnlyParagraph(name: string): string {
  return `<w:p><w:bookmarkStart w:id="0" w:name="${name}"/><w:bookmarkEnd w:id="0"/></w:p>`;
}

// W3: a paragraph with direct formatting, the way authors type
// chapter titles by hand (centered, bigger, bold, on a new page).
export type Look = {
  align?: "center" | "right" | "both" | "left";
  size?: number; // half-points, e.g. 36 = 18pt
  bold?: boolean;
  italic?: boolean;
  pageBreakBefore?: boolean;
  pageBreakAfter?: boolean; // a page break typed at the end of this paragraph
  tabs?: number; // leading tabs
  style?: string;
  numId?: number;
};
export function fmt(text: string, look: Look = {}): string {
  const pPr = [
    look.style ? `<w:pStyle w:val="${look.style}"/>` : "",
    look.pageBreakBefore ? `<w:pageBreakBefore/>` : "",
    look.numId !== undefined ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${look.numId}"/></w:numPr>` : "",
    look.align ? `<w:jc w:val="${look.align}"/>` : "",
  ].join("");
  const rPr = [look.bold ? "<w:b/>" : "", look.italic ? "<w:i/>" : "", look.size ? `<w:sz w:val="${look.size}"/>` : ""].join("");
  const tabs = "<w:tab/>".repeat(look.tabs ?? 0);
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}${tabs}<w:t xml:space="preserve">${text}</w:t>${look.pageBreakAfter ? '<w:br w:type="page"/>' : ""}</w:r></w:p>`;
}

export function emptyPara(count = 1): string {
  return "<w:p/>".repeat(count);
}

// A body paragraph long enough to read as ordinary prose.
export function prose(seed: string): string {
  return fmt(`${seed} ishte një ditë e zakonshme në qytet, me njerëz që shkonin në punë dhe fëmijë që vraponin drejt shkollës.`, { tabs: 1 });
}

// W3 Part 2: a note reference run (Word's superscript number) and a
// note's text for footnotesXml / endnotesXml. `paras` are paragraph
// XML (paragraph(), fmt(), ...).
export function noteRef(kind: "footnote" | "endnote", id: number, superscript = false): string {
  const tag = kind === "footnote" ? "w:footnoteReference" : "w:endnoteReference";
  return `<w:r>${superscript ? '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>' : ""}<${tag} w:id="${id}"/></w:r>`;
}
export function note(kind: "footnote" | "endnote", id: number, ...paras: string[]): string {
  return `<w:${kind} w:id="${id}">${paras.join("")}</w:${kind}>`;
}
// A paragraph of text runs with note references in between:
// textWithNotes("Fjala", noteRef("footnote", 7), " vazhdon.").
export function textWithNotes(...parts: string[]): string {
  return `<w:p>${parts.map((p) => (p.startsWith("<w:r>") ? p : `<w:r><w:t xml:space="preserve">${p}</w:t></w:r>`)).join("")}</w:p>`;
}
