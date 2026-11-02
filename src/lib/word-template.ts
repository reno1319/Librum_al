import JSZip from "jszip";

export { WORD_TEMPLATE_FILENAME } from "@/lib/word-guide-paths";

// BD6 (Master List W5/BD6, Renato's 1 Nov pick "K3 back in"): the
// Librum Word template authors download before they upload. It is
// built here from plain OOXML text (no binary file in the repository),
// so every byte of it can be read in review, and
// word-template.test.ts runs it through the real converter: a file made
// from this template must give real chapters, a scene break, a kept
// footnote, a sub-heading and a poem, with no unsure guesses and no
// warnings in the author preview.
//
// It teaches exactly what the converter reads today (docx-converter.ts,
// docx-structure.ts): Heading 1 = a chapter, Heading 2 = a sub-heading,
// "* * *" alone on a line = a scene break, Word's own footnotes, a poem
// written with Shift+Enter between lines and one paragraph per stanza.
// No title page, copyright page or contents list: Librum makes those
// itself (BD3). No author, date or personal data anywhere in the file.

export const WORD_TEMPLATE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// A fixed date for every part inside the zip, so the same code always
// gives the same bytes.
const FIXED_ZIP_DATE = new Date(Date.UTC(2026, 10, 1, 0, 0, 0));

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function run(text: string): string {
  return `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

type Block =
  | { kind: "chapter"; text: string }
  | { kind: "subheading"; text: string }
  | { kind: "text"; text: string; footnote?: string }
  | { kind: "sceneBreak" }
  | { kind: "stanza"; lines: string[] };

// The example book. Placeholder text the author replaces; each
// paragraph also explains the rule it shows.
export const WORD_TEMPLATE_BLOCKS: readonly Block[] = [
  { kind: "chapter", text: "Kapitulli 1" },
  {
    kind: "text",
    text:
      "Shkruani ose ngjitni këtu tekstin e kapitullit të parë. Ky paragraf është në stilin Normal. Fshijeni të gjithë tekstin shembull para se ta ngarkoni librin.",
  },
  {
    kind: "text",
    text:
      "Kur mbaron një paragraf, shtypni Enter vetëm një herë. Mos vendosni Tab ose hapësira në fillim të paragrafit dhe mos lini rreshta bosh. Librum e vendos vetë kryeradhën dhe hapësirën midis paragrafëve.",
  },
  { kind: "sceneBreak" },
  {
    kind: "text",
    text:
      "Tre yjet më sipër, në një rresht më vete, shënojnë një ndarje skene. Në libër dalin në qendër.",
  },
  {
    kind: "text",
    text: "Një shënim në fund të faqes e shtoni në Word me References › Insert Footnote.",
    footnote:
      "Ky është një shënim shembull. Në librin elektronik, Librum e vendos në fund të kapitullit, dhe në shumicën e aplikacioneve të leximit lexuesi e hap me një prekje.",
  },
  { kind: "subheading", text: "Një nëntitull" },
  {
    kind: "text",
    text:
      "Për një nëntitull brenda kapitullit përdorni stilin Heading 2. Kur libri ka kapituj me Heading 1, nëntitulli nuk e ndan librin në kapituj.",
  },
  { kind: "chapter", text: "Kapitulli 2" },
  {
    kind: "text",
    text:
      "Çdo kapitull fillon me titullin e vet në stilin Heading 1. Librum e nis çdo kapitull në faqe të re dhe me këta tituj ndërton përmbajtjen e librit.",
  },
  {
    kind: "text",
    text:
      "Një poezi shkruhet kështu: brenda strofës, në fund të çdo vargu shtypni Shift+Enter; në fund të strofës shtypni Enter. Librum e njeh si poezi një strofë me të paktën tre vargje të shkurtra.",
  },
  {
    kind: "stanza",
    lines: ["Vargu i parë i strofës,", "vargu i dytë poshtë tij,", "vargu i tretë e mbyll strofën."],
  },
  { kind: "stanza", lines: ["Strofa e dytë fillon", "pas një Enter-i të vetëm", "dhe ka po ashtu tre vargje."] },
];

const FOOTNOTE_FIRST_ID = 1;

function blockXml(block: Block, footnoteId: () => number): string {
  switch (block.kind) {
    case "chapter":
      return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run(block.text)}</w:p>`;
    case "subheading":
      return `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${run(block.text)}</w:p>`;
    case "sceneBreak":
      return `<w:p><w:pPr><w:spacing w:before="240" w:after="240"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr>${run("* * *")}</w:p>`;
    case "stanza":
      // A blank line after each stanza in Word; the ebook makes its own.
      return `<w:p><w:pPr><w:spacing w:after="240"/><w:ind w:firstLine="0"/></w:pPr>${block.lines
        .map((line, i) => (i === 0 ? "" : "<w:r><w:br/></w:r>") + run(line))
        .join("")}</w:p>`;
    case "text": {
      const note = block.footnote
        ? `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${footnoteId()}"/></w:r>`
        : "";
      return `<w:p>${run(block.text)}${note}</w:p>`;
    }
  }
}

function documentXml(): { document: string; footnotes: string[] } {
  let next = FOOTNOTE_FIRST_ID;
  const footnotes: string[] = [];
  const body = WORD_TEMPLATE_BLOCKS.map((block) =>
    blockXml(block, () => {
      footnotes.push(block.kind === "text" && block.footnote ? block.footnote : "");
      return next++;
    }),
  ).join("");
  // A4, 2.5 cm margins.
  const sectPr =
    `<w:sectPr><w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr>` +
    `<w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/>` +
    `</w:sectPr>`;
  return {
    document: `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}${sectPr}</w:body></w:document>`,
    footnotes,
  };
}

function footnotesXml(notes: string[]): string {
  const separators =
    `<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`;
  const bodies = notes
    .map(
      (text, i) =>
        `<w:footnote w:id="${FOOTNOTE_FIRST_ID + i}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>` +
        `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${run(` ${text}`)}</w:p></w:footnote>`,
    )
    .join("");
  return `${XML_HEAD}<w:footnotes xmlns:w="${W_NS}" xmlns:r="${R_NS}">${separators}${bodies}</w:footnotes>`;
}

// Word's built-in style ids and (English) names, which Word, Google
// Docs, LibreOffice and Pages all recognise, so the author can pick
// "Heading 1" from the usual styles menu. Albanian language for the
// spelling check.
function stylesXml(): string {
  const font = `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Georgia" w:cs="Georgia"/>`;
  return (
    `${XML_HEAD}<w:styles xmlns:w="${W_NS}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="sq-AL" w:eastAsia="sq-AL" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:ind w:firstLine="397"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:pageBreakBefore/><w:spacing w:before="1440" w:after="720"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr>` +
    `<w:rPr><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="480" w:after="240"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="1"/></w:pPr>` +
    `<w:rPr><w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>` +
    `<w:pPr><w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>` +
    `<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `</w:styles>`
  );
}

function settingsXml(): string {
  return (
    `${XML_HEAD}<w:settings xmlns:w="${W_NS}">` +
    `<w:defaultTabStop w:val="708"/><w:characterSpacingControl w:val="doNotCompress"/>` +
    `<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>` +
    `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>` +
    `</w:settings>`
  );
}

const CONTENT_TYPES =
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
  `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `</Types>`;

const PACKAGE_RELS =
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `</Relationships>`;

const DOCUMENT_RELS =
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>` +
  `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>` +
  `</Relationships>`;

// Title only: no creator, no dates (no personal data in a public file).
const CORE_PROPS =
  `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
  `<dc:title>Shablloni i Librum</dc:title><dc:language>sq-AL</dc:language>` +
  `</cp:coreProperties>`;

export async function buildWordTemplate(): Promise<Buffer> {
  const { document, footnotes } = documentXml();
  const zip = new JSZip();
  const add = (path: string, text: string) => zip.file(path, text, { date: FIXED_ZIP_DATE, createFolders: false });
  // [Content_Types].xml first, as Word writes it.
  add("[Content_Types].xml", CONTENT_TYPES);
  add("_rels/.rels", PACKAGE_RELS);
  add("docProps/core.xml", CORE_PROPS);
  add("word/document.xml", document);
  add("word/_rels/document.xml.rels", DOCUMENT_RELS);
  add("word/styles.xml", stylesXml());
  add("word/settings.xml", settingsXml());
  add("word/footnotes.xml", footnotesXml(footnotes));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "DOS" });
}
