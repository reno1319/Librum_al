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
};

export async function buildDocxBytes(options: BuildOptions): Promise<Buffer> {
  const zip = new JSZip();

  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    options.includeStyles
      ? `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
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
</w:styles>`,
    );
  }

  if (options.includeNumbering) {
    zip.file(
      "word/numbering.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`,
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
