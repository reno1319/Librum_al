import JSZip from "jszip";
import type { DocImage, DocSection } from "@/lib/docx-converter";

// LIBRUM 2.0 PRODUCT-5: builds a real, minimal, valid EPUB 3 package
// from the normalized document model docx-converter.ts produces --
// never a "HTML blob zipped up and called EPUB" (see the PRODUCT-5
// brief's own core-decision section). Every structural piece EPUB
// requires is written by hand here (mimetype, container.xml, OPF,
// nav, XHTML content documents) via JSZip, already a project
// dependency -- no new EPUB-authoring library, matching this
// codebase's existing precedent (epub-validation.ts/epub-sample.ts
// both hand-roll lightweight EPUB XML themselves rather than take on
// a parsing/generation dependency for it).
//
// Deliberately targets exactly what this app's own
// validateEpubStructure() (src/lib/epub-validation.ts) and
// extractEpubSample() (src/lib/epub-sample.ts) actually read --
// confirmed by reading both directly, not assumed -- so a generated
// book works with Read Sample and the rest of the existing pipeline
// automatically, with no separate DOCX-aware code path anywhere else
// in the app.

export type EpubGeneratorInput = {
  bookId: string;
  title: string;
  authorName: string;
  sections: DocSection[];
  images: DocImage[];
  // LIBRUM 2.0 PUBLISHING-UX-1 PART B: optional -- omitted, null, or
  // blank all resolve to "und" exactly as every caller already got
  // before this field existed (see resolveEpubLanguageCode() below).
  // No caller in this codebase passes a real value yet (books.language
  // did not exist until migration 044, and threading a live value from
  // the wizard's own eventual Language field through docx-actions.ts/
  // manuscript-field.tsx is Part C's UI work, not this signature
  // change) -- this only makes doing so possible later without a
  // second signature change.
  language?: string | null;
};

// Falls back to "und" (the real, standards-defined ISO 639-2 code for
// "undetermined") for an absent/null/blank language -- never guesses,
// never crashes. See renderOpf()'s own PRE-COMMIT CORRECTION comment
// below for why "und" specifically, not omission.
function resolveEpubLanguageCode(language: string | null | undefined): string {
  const trimmed = language?.trim();
  return trimmed ? trimmed : "und";
}

const XML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => XML_ESCAPE[c]);
}

// A small, generic reflowable-ebook stylesheet -- paragraph spacing,
// heading rhythm, blockquote/list/image treatment. Deliberately NOT
// Word's own generated stylesheet (fixed page widths, absolute
// positioning, print-layout assumptions all excluded on purpose, per
// the brief's "no print-layout hacks" rule) -- an ebook is reflowable,
// this preserves structure/emphasis, not DOCX page geometry.
const STYLESHEET = `body { font-family: serif; line-height: 1.5; margin: 1em; }
h1, h2, h3, h4 { font-family: sans-serif; line-height: 1.25; margin: 1.4em 0 0.6em; }
h1 { font-size: 1.6em; }
h2 { font-size: 1.3em; }
h3 { font-size: 1.1em; }
h4 { font-size: 1em; }
p { margin: 0 0 1em; }
blockquote { margin: 1em 2em; font-style: italic; }
ul, ol { margin: 0 0 1em; padding-left: 1.5em; }
img { max-width: 100%; }
table { border-collapse: collapse; width: 100%; margin: 0 0 1em; }
td, th { border: 1px solid #999; padding: 0.4em; text-align: left; }
`;

function chapterFilename(index: number): string {
  return `chapter-${index + 1}.xhtml`;
}

function renderChapterXhtml(section: DocSection, index: number): string {
  const headingHtml = section.heading
    ? `<h1>${escapeXml(section.heading)}</h1>\n`
    : index === 0
      ? ""
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(section.heading ?? "Section")}</title>
<link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
${headingHtml}${section.html}
</body>
</html>
`;
}

function renderNavXhtml(sections: DocSection[]): string {
  const items = sections
    .map((section, i) =>
      section.heading
        ? `<li><a href="${chapterFilename(i)}">${escapeXml(section.heading)}</a></li>`
        : "",
    )
    .filter(Boolean)
    .join("\n");
  // Every real EPUB 3 must have a non-empty nav -- a manuscript with
  // no Heading 1 at all still needs a minimal, valid single entry
  // rather than an empty <ol>, per the brief's own "if no chapter
  // headings: use a minimal valid navigation entry" rule.
  const list = items || `<li><a href="${chapterFilename(0)}">Start</a></li>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<meta charset="utf-8"/>
<title>Table of Contents</title>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>Table of Contents</h1>
<ol>
${list}
</ol>
</nav>
</body>
</html>
`;
}

function renderOpf(input: EpubGeneratorInput, modifiedAt: string): string {
  const manifestItems = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="styles.css" media-type="text/css"/>`,
    ...input.sections.map(
      (_, i) => `<item id="chapter${i + 1}" href="${chapterFilename(i)}" media-type="application/xhtml+xml"/>`,
    ),
    ...input.images.map((img, i) => {
      const id = `image${i + 1}`;
      return `<item id="${id}" href="images/${img.filename}" media-type="${img.mediaType}"/>`;
    }),
  ].join("\n");

  const spineItems = input.sections.map((_, i) => `<itemref idref="chapter${i + 1}"/>`).join("\n");

  // A generated internal identifier derived from the book's own id --
  // never a fabricated ISBN (per the brief's explicit "do not invent
  // ISBN" rule).
  //
  // LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: dc:language is EPUB3's
  // own required metadata element (never optional in the spec) -- the
  // earlier "omit it" decision was wrong, not merely conservative. At
  // the time this was written, books had no authoritative per-book
  // language field at all, so the fix was to use "und" -- the real,
  // standards-defined ISO 639-2 code for "undetermined," a genuine
  // value for exactly that situation, never a guessed "en"/"sq".
  //
  // LIBRUM 2.0 PUBLISHING-UX-1 PART B: books.language now exists
  // (migration 044) -- resolveEpubLanguageCode() above still falls
  // back to "und" for every caller that omits/nulls `input.language`
  // (which is every current caller; see this input type's own comment),
  // so this remains byte-for-byte the same output as before for any
  // book without a real language value, and only emits a real code once
  // a caller actually starts supplying one.
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:identifier id="book-id">urn:librum:book:${escapeXml(input.bookId)}</dc:identifier>
<dc:title>${escapeXml(input.title)}</dc:title>
<dc:creator>${escapeXml(input.authorName)}</dc:creator>
<dc:language>${escapeXml(resolveEpubLanguageCode(input.language))}</dc:language>
<meta property="dcterms:modified">${modifiedAt}</meta>
</metadata>
<manifest>
${manifestItems}
</manifest>
<spine>
${spineItems}
</spine>
</package>
`;
}

// LIBRUM 2.0 PRODUCT-5 413 CORRECTION: repackaging on every title
// keystroke used to mean re-running the FULL generateEpub() (cheap --
// no Mammoth -- but still a full JSZip rebuild). Now that the
// generated EPUB is cached server-side in temporary Storage between
// keystrokes (see docx-actions.ts's repackageWithTitle()) rather than
// round-tripped through a Server Action response, an even cheaper
// operation is available: patch just the OPF's own dc:title/
// dc:creator/dcterms:modified text and leave every other entry
// (chapters, images, nav, manifest, spine) byte-for-byte untouched.
//
// Verified empirically (not assumed) before relying on it: JSZip's
// loadAsync() -> replace one file's content -> generateAsync() round
// trip was probed directly against the raw ZIP bytes and confirmed to
// preserve the mimetype entry's required first-position/STORE-
// compression invariant and leave every other entry's bytes
// unchanged -- the same "verify JSZip behavior directly, never assume
// it" discipline the mimetype-compression test below already follows.
export async function patchEpubMetadata(
  epubBytes: Buffer,
  title: string,
  authorName: string,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(epubBytes);
  const opfEntry = zip.file("OEBPS/content.opf");
  if (!opfEntry) {
    throw new Error("patchEpubMetadata: OEBPS/content.opf not found in EPUB");
  }
  const opf = await opfEntry.async("string");
  const modifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const titleMatch = opf.match(/<dc:title>[\s\S]*?<\/dc:title>/);
  if (!titleMatch) {
    throw new Error("patchEpubMetadata: dc:title not found in OPF");
  }
  const creatorMatch = opf.match(/<dc:creator>[\s\S]*?<\/dc:creator>/);
  if (!creatorMatch) {
    throw new Error("patchEpubMetadata: dc:creator not found in OPF");
  }

  const patched = opf
    .replace(titleMatch[0], `<dc:title>${escapeXml(title)}</dc:title>`)
    .replace(creatorMatch[0], `<dc:creator>${escapeXml(authorName)}</dc:creator>`)
    .replace(
      /<meta property="dcterms:modified">[\s\S]*?<\/meta>/,
      `<meta property="dcterms:modified">${modifiedAt}</meta>`,
    );

  zip.file("OEBPS/content.opf", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

export async function generateEpub(input: EpubGeneratorInput): Promise<Buffer> {
  const zip = new JSZip();

  // EPUB OCF requirement: mimetype must be the very first entry,
  // stored uncompressed, with exactly this content and no trailing
  // newline. validateEpubStructure() doesn't enforce STORE compression
  // (see its own audit comment for why), but a real, spec-correct
  // EPUB does this regardless of what this app's own lightweight
  // validator happens to check -- "must be a real valid EPUB," not
  // merely one that satisfies this one validator.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>
`,
  );

  const modifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  zip.file("OEBPS/content.opf", renderOpf(input, modifiedAt));
  zip.file("OEBPS/nav.xhtml", renderNavXhtml(input.sections));
  zip.file("OEBPS/styles.css", STYLESHEET);

  input.sections.forEach((section, i) => {
    zip.file(`OEBPS/${chapterFilename(i)}`, renderChapterXhtml(section, i));
  });

  for (const image of input.images) {
    zip.file(`OEBPS/images/${image.filename}`, image.bytes);
  }

  return zip.generateAsync({ type: "nodebuffer" });
}
