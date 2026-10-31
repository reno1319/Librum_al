import JSZip from "jszip";
import { DEFAULT_EPUB_LANGUAGE } from "@/lib/epub-generator";
import { EPUB_ZIP_PREFLIGHT_LIMITS } from "@/lib/epub-validation";
import { preflightZipEntries } from "@/lib/zip-preflight";

// W7 (Renato 10-31: W7 a, 1a, 2a; then 1a 2a 3a 4b 5a): the book's cover
// goes INSIDE an ebook Librum made from a Word file -- as the first page
// and as the reader app's library thumbnail -- and is swapped in again
// whenever the author changes the cover. Librum keeps no Word file, so
// the stored ebook itself is rewritten. An ebook the author uploaded
// directly is never touched (2a): only the exact package shape
// generateEpub() writes is recognised below, and anything else is left
// byte-for-byte as it is.
//
// Every name this module writes is fixed and lives OUTSIDE the
// OEBPS/images/ folder the converter's own pictures use, so it can never
// collide with an author's image, and a second run first removes what
// the previous run wrote (the swap is repeatable).
export const EBOOK_COVER_IMAGE_ENTRY = "OEBPS/cover.jpg";
export const EBOOK_COVER_PAGE_ENTRY = "OEBPS/cover.xhtml";
const COVER_IMAGE_ID = "librum-cover-image";
const COVER_PAGE_ID = "librum-cover-page";

const OPF_ENTRY = "OEBPS/content.opf";
const CONTAINER_ENTRY = "META-INF/container.xml";

// generateEpub()'s identifier: "urn:librum:book:" + the conversion's
// randomUUID() (docx-actions.ts). The exact element, not a substring.
const LIBRUM_IDENTIFIER_RE =
  /<dc:identifier id="book-id">urn:librum:book:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}<\/dc:identifier>/;
// generateEpub()'s first manifest item, always.
const LIBRUM_NAV_ITEM =
  '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>';
const LIBRUM_ROOTFILE =
  '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>';

export type EmbedEbookCoverResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "not_librum_made" | "unreadable" | "cover_not_jpeg" };

export type EmbedEbookCoverInput = {
  coverJpeg: Buffer;
  // 3a: refreshed together with the cover. Omitted/blank keeps the
  // value already in the ebook.
  title?: string | null;
  authorName?: string | null;
};

const XML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => XML_ESCAPE[c]);
}

type LoadedLibrumEpub = { zip: JSZip; opf: string };

// Returns the opened package only when it is generateEpub()'s shape:
// container pointing at OEBPS/content.opf, the urn:librum:book:<uuid>
// identifier as the unique identifier, the nav item first in exactly one
// manifest, exactly one spine, and the nav/stylesheet entries present.
async function loadLibrumEpub(bytes: Buffer): Promise<LoadedLibrumEpub | "not_librum_made" | "unreadable"> {
  // The same pre-inflation bounds every stored EPUB passed at upload.
  const preflight = preflightZipEntries(bytes, EPUB_ZIP_PREFLIGHT_LIMITS);
  if (!preflight.ok) return "unreadable";

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return "unreadable";
  }

  const container = zip.file(CONTAINER_ENTRY);
  const opfEntry = zip.file(OPF_ENTRY);
  if (!container || !opfEntry || !zip.file("OEBPS/nav.xhtml") || !zip.file("OEBPS/styles.css")) {
    return "not_librum_made";
  }

  let containerXml: string;
  let opf: string;
  try {
    containerXml = await container.async("string");
    opf = await opfEntry.async("string");
  } catch {
    return "unreadable";
  }

  if (!containerXml.includes(LIBRUM_ROOTFILE)) return "not_librum_made";
  if (!opf.includes('unique-identifier="book-id"')) return "not_librum_made";
  if (!LIBRUM_IDENTIFIER_RE.test(opf)) return "not_librum_made";
  if (countOccurrences(opf, "<manifest>") !== 1 || countOccurrences(opf, "</manifest>") !== 1) {
    return "not_librum_made";
  }
  if (countOccurrences(opf, "<spine>") !== 1 || countOccurrences(opf, "</spine>") !== 1) {
    return "not_librum_made";
  }
  // A swap puts the cover items first, so the nav item is checked with
  // them taken out.
  if (!stripPreviousCover(opf).includes(`<manifest>\n${LIBRUM_NAV_ITEM}`)) return "not_librum_made";
  if (countOccurrences(opf, "</metadata>") !== 1) return "not_librum_made";

  return { zip, opf };
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export async function isLibrumMadeEpub(bytes: Buffer): Promise<boolean> {
  const loaded = await loadLibrumEpub(bytes);
  return typeof loaded !== "string";
}

// The cover picture inside a Librum-made ebook, or null (not Librum-made,
// unreadable, or no cover yet). Used when an author uploads a new Word
// file without a new cover: the sharp ebook copy (4b) is carried over.
export async function readLibrumEbookCover(bytes: Buffer): Promise<Buffer | null> {
  const loaded = await loadLibrumEpub(bytes);
  if (typeof loaded === "string") return null;
  if (!loaded.opf.includes(`<item id="${COVER_IMAGE_ID}" `)) return null;
  const entry = loaded.zip.file(EBOOK_COVER_IMAGE_ENTRY);
  if (!entry) return null;
  try {
    return await entry.async("nodebuffer");
  } catch {
    return null;
  }
}

function renderCoverPageXhtml(titleXml: string, language: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
<head>
<meta charset="utf-8"/>
<title>${titleXml}</title>
<style>
html, body { margin: 0; padding: 0; height: 100%; }
div.cover { height: 100%; text-align: center; }
div.cover img { max-width: 100%; max-height: 100%; }
</style>
</head>
<body epub:type="cover">
<div class="cover"><img src="cover.jpg" alt="${titleXml}"/></div>
</body>
</html>
`;
}

// Removes what an earlier run wrote, so the swap can repeat.
function stripPreviousCover(opf: string): string {
  return opf
    .replace(new RegExp(`<item id="${COVER_IMAGE_ID}"[^>]*/>\\n?`, "g"), "")
    .replace(new RegExp(`<item id="${COVER_PAGE_ID}"[^>]*/>\\n?`, "g"), "")
    .replace(new RegExp(`<itemref idref="${COVER_PAGE_ID}"[^>]*/>\\n?`, "g"), "")
    .replace(new RegExp(`<meta name="cover" content="${COVER_IMAGE_ID}"/>\\n?`, "g"), "");
}

export async function embedCoverInLibrumEpub(
  bytes: Buffer,
  input: EmbedEbookCoverInput,
): Promise<EmbedEbookCoverResult> {
  // W7 r2 (audit R1): the cover is written as cover.jpg / image/jpeg, so
  // only JPEG bytes (FF D8 FF) are accepted; anything else would make an
  // invalid ebook (epubcheck OPF-029) that Librum's own check misses.
  if (!isJpeg(input.coverJpeg)) return { ok: false, reason: "cover_not_jpeg" };
  const loaded = await loadLibrumEpub(bytes);
  if (loaded === "not_librum_made" || loaded === "unreadable") return { ok: false, reason: loaded };
  const { zip } = loaded;

  let opf = stripPreviousCover(loaded.opf);

  const title = input.title?.trim();
  if (title) {
    opf = opf.replace(/<dc:title>[\s\S]*?<\/dc:title>/, () => `<dc:title>${escapeXml(title)}</dc:title>`);
  }
  const authorName = input.authorName?.trim();
  if (authorName) {
    opf = opf.replace(
      /<dc:creator>[\s\S]*?<\/dc:creator>/,
      () => `<dc:creator>${escapeXml(authorName)}</dc:creator>`,
    );
  }
  const modifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  opf = opf.replace(
    /<meta property="dcterms:modified">[\s\S]*?<\/meta>/,
    () => `<meta property="dcterms:modified">${modifiedAt}</meta>`,
  );

  opf = opf
    // EPUB 2 readers and older Kindle conversion look for this; EPUB 3
    // allows it alongside properties="cover-image".
    .replace("</metadata>", () => `<meta name="cover" content="${COVER_IMAGE_ID}"/>\n</metadata>`)
    .replace(
      `<manifest>\n`,
      () =>
        `<manifest>\n<item id="${COVER_IMAGE_ID}" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>\n` +
        `<item id="${COVER_PAGE_ID}" href="cover.xhtml" media-type="application/xhtml+xml"/>\n`,
    )
    // 1a: the cover is the first page.
    .replace(`<spine>\n`, () => `<spine>\n<itemref idref="${COVER_PAGE_ID}"/>\n`);

  // The title text already in the OPF is escaped XML, so it is reused
  // as-is for the cover page.
  const titleXml = opf.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1] ?? "";
  const language = opf.match(/<dc:language>([\s\S]*?)<\/dc:language>/)?.[1]?.trim() || DEFAULT_EPUB_LANGUAGE;

  zip.file(OPF_ENTRY, opf);
  zip.file(EBOOK_COVER_IMAGE_ENTRY, input.coverJpeg);
  zip.file(EBOOK_COVER_PAGE_ENTRY, renderCoverPageXhtml(titleXml, language));

  try {
    return { ok: true, bytes: await zip.generateAsync({ type: "nodebuffer" }) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
