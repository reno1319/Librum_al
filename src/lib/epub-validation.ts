import JSZip from "jszip";
import { posix } from "node:path";
import sharp from "sharp";
import { preflightZipEntries } from "@/lib/zip-preflight";
import { resolveArchivePath } from "@/lib/epub-archive-paths";
// Imports this file back for EPUB_ZIP_PREFLIGHT_LIMITS, used only
// inside its functions, so the cycle is safe.
import { buildReaderContent, linkedStylesheetPaths, RASTER_TYPES, readerNavItem, readReaderSpine } from "@/lib/epub-reader";
import { MAX_READ_RESPONSE_BYTES } from "@/lib/owned-reader";
import { firstElementInner } from "@/lib/markup-scan";

// container.xml is always a tiny, fixed-shape file (a few hundred bytes
// in every real EPUB). This cap is still kept as an EXTRA, tighter,
// container.xml-specific bound on top of the generic per-entry
// preflight cap below (EPUB_ZIP_PREFLIGHT_LIMITS) -- a real
// container.xml never approaches even this much smaller size, so it
// stays a useful, non-redundant sanity check on the decoded text this
// function's own regex then processes, not zip-bomb protection by
// itself (that's now the preflight's job, run before any decompression
// at all -- see below).
const MAX_CONTAINER_XML_BYTES = 16 * 1024;

// LIBRUM 2.0 EPUB-VALIDATION-1B: pre-inflation resource bounds for
// EPUB uploads, checked against the ZIP's own central directory --
// BEFORE JSZip.loadAsync() or any entry.async() call below ever
// decompresses a single byte. Reuses the exact mechanism DOCX
// conversion already established (zip-preflight.ts) -- see that
// file's own header comment for the full rationale and honest
// limitations; nothing new is invented here, only wired into the EPUB
// path, which is the concrete gap the EPUB-VALIDATION-1A audit found:
// every entry.async() call in this file previously ran with no
// pre-inflation size bound at all. This matters beyond just this
// function -- extractEpubSample() (epub-sample.ts) reuses these SAME
// limits, and that function backs a PUBLIC, unauthenticated route
// (/api/books/[id]/sample) that re-parses an already-stored manuscript
// on every request; this validator running first, at ingestion, is
// what's supposed to guarantee nothing unbounded ever reaches
// permanent storage for that route to repeatedly re-decompress.
//
// Chosen with the same "generous headroom over any real manuscript"
// reasoning docx-converter.ts's own MAX_DOCX_ENTRIES/
// MAX_DOCX_UNCOMPRESSED_BYTES already used (same order of magnitude,
// independently justified for EPUB's own shape -- a real EPUB,
// even heavily illustrated, realistically has tens to a few hundred
// entries and rarely approaches 300MB uncompressed):
//   - EPUB_MAX_ENTRIES: mirrors DOCX's own bound.
//   - EPUB_MAX_TOTAL_UNCOMPRESSED_BYTES: mirrors DOCX's own bound.
//   - EPUB_MAX_SINGLE_ENTRY_UNCOMPRESSED_BYTES: new axis DOCX's own
//     preflight call doesn't use (its per-XML-part cap is applied
//     separately, after JSZip.loadAsync(), not through this shared
//     preflight option) -- the check that closes the actual gap the
//     audit found: a SINGLE pathological entry (mimetype, container.xml,
//     the OPF, or -- in extractEpubSample()'s case -- a spine content
//     document) with a tiny compressed footprint and an enormous
//     declared uncompressed size, previously fully decompressed before
//     any length check ever ran.
const EPUB_MAX_ENTRIES = 5_000;
const EPUB_MAX_TOTAL_UNCOMPRESSED_BYTES = 300 * 1024 * 1024;
const EPUB_MAX_SINGLE_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

// Exported so epub-sample.ts uses the IDENTICAL limits -- one shared
// definition, never two independently-chosen numbers for what is
// conceptually the same bound applied to the same class of untrusted
// EPUB archive.
export const EPUB_ZIP_PREFLIGHT_LIMITS = {
  maxEntries: EPUB_MAX_ENTRIES,
  maxTotalUncompressedBytes: EPUB_MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxSingleEntryUncompressedBytes: EPUB_MAX_SINGLE_ENTRY_UNCOMPRESSED_BYTES,
};

// The well-known, fixed OCF part name for EPUB's own encryption
// manifest (per the EPUB/OCF spec, always at exactly this path when
// any resource in the container is encrypted). Presence alone is the
// signal for this product's DRM-free-only V1 policy -- its content is
// never parsed, and no attempt is made to distinguish which resources
// or which algorithm; that's out of scope, and unnecessary for a
// reject-or-accept decision.
const ENCRYPTION_MANIFEST_ENTRY = "META-INF/encryption.xml";

// LAUNCH-1 P1: kept deliberately small -- one reason per structural
// requirement this validator actually checks, not one per internal
// branch. The user-facing error stays the same single generic message
// regardless of which of these fires (see the Server Action call
// sites); this taxonomy exists so a future failure like the one this
// fix addresses is diagnosable from a server log line, not another
// multi-hour reproduction.
export type EpubValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "invalid_zip"
        | "missing_mimetype"
        | "invalid_mimetype"
        | "missing_container"
        | "container_too_large"
        | "missing_rootfile"
        | "missing_opf"
        // LIBRUM 2.0 EPUB-VALIDATION-1B additions -- see the preflight/
        // DRM/path-safety comments below for what each one covers.
        | "too_many_entries"
        | "too_large_uncompressed"
        | "entry_too_large"
        | "encrypted_or_drm"
        | "unsafe_path"
        // PV1 1d (sz1 a): too slow for the reader to open.
        | "text_too_large"
        | "pictures_too_large"
        // sz5 a: the buyer's online reader could not send it.
        | "reader_output_too_large";
    };

// Deliberately lightweight structural validation, not EPUBCheck-style
// conformance validation: confirms the upload is a real ZIP archive with
// the specific handful of entries every EPUB must have (the mimetype
// file with the exact required value, a container.xml that points at a
// package/OPF document, and that document actually existing in the
// archive) -- without ever decompressing or reading the manuscript
// content itself. This is enough to reject "any file renamed .epub"
// while staying far short of validating the book's actual EPUB
// conformance, which is out of scope.
//
// LAUNCH-1 P1 CORRECTION: this function previously also rejected any
// mimetype entry whose `options.compression !== "STORE"`. That check is
// gone, not replaced. Root cause (reproduced and documented in the
// LAUNCH-1 P1 audit): JSZipObject.options.compression is a WRITE-facing
// field (what compression an entry should get on its next
// generateAsync()), not a read result -- confirmed directly against the
// installed jszip@3.10.1's own type definitions, whose only
// compression-bearing read-side interface (CompressedObject, on the
// private `_data` property) is explicitly commented out as unpublished
// API. After JSZip.loadAsync() -- the only code path a real uploaded
// file ever takes -- `options.compression` reads `null` unconditionally,
// regardless of the entry's actual on-disk compression method, so the
// removed check rejected every real EPUB ever uploaded, with no
// exception. There is no public JSZip API this function could use to
// reinstate an equivalent check, and the EPUB OCF spec's own
// requirement that `mimetype` be stored uncompressed is, in practice,
// unenforced by every mainstream reading system (Apple Books, Kindle,
// Adobe Digital Editions, calibre all open a DEFLATE-compressed
// mimetype entry without complaint) -- so dropping it narrows this
// validator's spec-conformance checking, not its ability to reject a
// non-EPUB file. Protection against "any file renamed .epub" still
// comes from the mimetype VALUE check below (unchanged), plus the
// container.xml/rootfile/OPF structural checks (unchanged).
export async function validateEpubStructure(bytes: Buffer): Promise<EpubValidationResult> {
  // LIBRUM 2.0 EPUB-VALIDATION-1B: preflight runs FIRST, against the
  // raw buffer, before JSZip.loadAsync() -- and therefore before any
  // entry.async() call below -- ever touches this file. See
  // EPUB_ZIP_PREFLIGHT_LIMITS above for the limits and their
  // rationale. Preflight failure reasons map directly to this
  // function's own taxonomy; no ZIP-parser-internal error or message
  // ever escapes past this point.
  const preflight = preflightZipEntries(bytes, EPUB_ZIP_PREFLIGHT_LIMITS);
  if (!preflight.ok) {
    if (preflight.reason === "not_a_zip") return { valid: false, reason: "invalid_zip" };
    if (preflight.reason === "too_many_entries") return { valid: false, reason: "too_many_entries" };
    if (preflight.reason === "too_large_uncompressed") {
      return { valid: false, reason: "too_large_uncompressed" };
    }
    return { valid: false, reason: "entry_too_large" };
  }

  // LIBRUM 2.0 EPUB-VALIDATION-1B: DRM/encryption -- this product is
  // DRM-free EPUB only for V1. Checked against the already-parsed
  // preflight entry list, so this rejects an encrypted EPUB before
  // JSZip.loadAsync() is even called, let alone before any entry is
  // decompressed -- presence alone of the well-known OCF manifest part
  // name is sufficient; its content is never read or parsed.
  if (preflight.entries.some((entry) => entry.name === ENCRYPTION_MANIFEST_ENTRY)) {
    return { valid: false, reason: "encrypted_or_drm" };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { valid: false, reason: "invalid_zip" };
  }

  const mimetypeFile = zip.file("mimetype");
  if (!mimetypeFile) return { valid: false, reason: "missing_mimetype" };

  let mimetype: string;
  try {
    // Safe to decompress fully now -- the preflight above already
    // proved every entry in this archive, including this one, declares
    // an uncompressed size at or under
    // EPUB_MAX_SINGLE_ENTRY_UNCOMPRESSED_BYTES.
    mimetype = (await mimetypeFile.async("string")).trim();
  } catch {
    return { valid: false, reason: "invalid_mimetype" };
  }
  if (mimetype !== "application/epub+zip") {
    return { valid: false, reason: "invalid_mimetype" };
  }

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) return { valid: false, reason: "missing_container" };

  let containerXml: string;
  try {
    // Same per-entry preflight bound applies here as it did to
    // mimetype above -- safe to decompress fully.
    containerXml = await containerFile.async("string");
  } catch {
    return { valid: false, reason: "missing_container" };
  }
  // See MAX_CONTAINER_XML_BYTES above: rejected outright rather than
  // truncated, since a real EPUB's container.xml never approaches this
  // size in the first place.
  if (containerXml.length > MAX_CONTAINER_XML_BYTES) {
    return { valid: false, reason: "container_too_large" };
  }

  // Conservative, bounded extraction -- only looks for the one attribute
  // that matters, within the already size-capped string above. Accepts
  // either quote style via the backreference, and normal attribute
  // ordering/whitespace -- including whitespace around "=", which XML
  // permits (e.g. full-path = "OEBPS/content.opf") -- but can only ever
  // match inside a <rootfile ...> tag, never arbitrary unrelated text.
  const rootfileMatch = containerXml.match(
    /<rootfile\b[^>]*\bfull-path\s*=\s*(["'])(.*?)\1/i,
  );
  if (!rootfileMatch) return { valid: false, reason: "missing_rootfile" };

  const opfPath = rootfileMatch[2].trim();
  if (!opfPath) return { valid: false, reason: "missing_rootfile" };

  // LAUNCH-1 P1: leading-slash normalization, lookup-only -- reproduced
  // in the audit as a real compatibility gap: some EPUB-producing tools
  // write full-path="/OEBPS/content.opf" (an absolute-looking path),
  // even though OCF zip entry names never carry a leading slash (no
  // real zip archive stores one). Only the LOOKUP is normalized; the
  // rest of this function never re-derives or stores opfPath itself.
  // Deliberately narrow -- strips only leading slashes, not arbitrary
  // dot-segments or general path canonicalization, per the approved
  // scope for this fix.
  const normalizedOpfPath = opfPath.replace(/^\/+/, "");
  if (!normalizedOpfPath) return { valid: false, reason: "missing_rootfile" };

  // LIBRUM 2.0 EPUB-VALIDATION-1B: archive-path safety, via the same
  // shared resolver epub-sample.ts uses for manifest hrefs (see
  // epub-archive-paths.ts's own comment). Applied here to the
  // ALREADY-leading-slash-stripped path above -- resolveArchivePath's
  // own "reject a leading slash outright" rule never fires for the
  // approved container.xml compatibility case, since that slash was
  // already removed by the line above, unchanged from before this
  // pass. This catches the genuinely different case: a rootfile
  // full-path containing enough "../" segments to resolve outside the
  // archive root entirely (e.g. "../../etc/passwd") -- previously this
  // would only ever surface as an incidental "missing_opf" once the
  // lookup below failed to find it; now it's a distinct, intentional
  // "unsafe_path" reason instead.
  const resolvedOpfPath = resolveArchivePath("", normalizedOpfPath);
  if (!resolvedOpfPath.safe) return { valid: false, reason: "unsafe_path" };

  if (!zip.file(resolvedOpfPath.path)) return { valid: false, reason: "missing_opf" };

  const size = await checkReaderSize(zip);
  if (!size.valid) return size;
  return checkBuyerOutput(bytes);
}

// PV1 1d (Renato sz1 a, 21 Nov 2026): the reader re-reads the whole
// book on every open (buyer, author preview, public sample), so a small
// file holding a lot of text or many huge pictures took 16 s or more per
// open, or ran the server out of memory. Measured on staging d1a9525:
// about 0.2 s per MB of text and 0.16 s per 40-megapixel picture. These
// two limits keep the worst book at a few seconds; real books are far
// under them (his biggest manuscript: 0.14 MB of text, no pictures).
export const EPUB_MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const EPUB_MAX_PICTURE_PIXELS = 1_000_000_000;
// sz4 a: the least any one picture counts for.
export const EPUB_MIN_PICTURE_PIXELS = 10_000_000;

// The authors' messages (pictures r1 and r2), shared by the book
// file upload and the Word upload.
export const EPUB_TEXT_TOO_LARGE_MESSAGE =
  "Teksti i këtij libri është shumë i madh për t'u hapur te lexuesit. Lejohen deri në 10 MB tekst gjithsej. Ndajeni librin në më shumë vëllime.";
export const EPUB_READER_OUTPUT_TOO_LARGE_MESSAGE =
  "Ky libër është shumë i madh për t'u lexuar online në Librum. Zvogëloni fotot ose ndajeni librin në më shumë vëllime.";
export const EPUB_PICTURES_TOO_LARGE_MESSAGE =
  "Ky libër ka shumë foto për t'u hapur te lexuesit. Lejohen deri në 100 foto, dhe një foto mbi 10 megapiksel numërohet si më shumë se një. Hiqni ose zvogëloni disa foto dhe ngarkojeni përsëri.";

// The reader reads two things that grow with the book: the documents
// of its spine (as text) and the pictures its manifest lists (each
// re-encoded). Both are measured exactly as the reader finds them
// (readReaderSpine), so a page or picture the reader would never read
// costs nothing here, and one it would read cannot hide behind a name.
async function checkReaderSize(zip: JSZip): Promise<EpubValidationResult> {
  const found = await readReaderSpine(zip);
  // A book the reader cannot open costs the reader nothing to open.
  if (!found) return { valid: true };

  // Text: every page of the spine, the stylesheets those pages link to,
  // and the contents page, each counted once, as the reader reads each
  // once. Measured by opening them the way the reader does (never by a
  // name in the archive's own listing), stopping at the limit.
  let textBytes = 0;
  const counted = new Set<string>();
  const addText = async (path: string): Promise<string | null> => {
    if (counted.has(path)) return null;
    counted.add(path);
    const file = zip.file(path);
    if (!file) return null;
    let bytes: Buffer;
    try {
      bytes = await file.async("nodebuffer");
    } catch {
      return null;
    }
    textBytes += bytes.length;
    return bytes.toString("utf8");
  };
  const tooMuchText = { valid: false, reason: "text_too_large" } as const;
  const nav = readerNavItem(found.manifest);
  if (nav?.path) await addText(nav.path);
  if (textBytes > EPUB_MAX_TEXT_BYTES) return tooMuchText;
  const stylesheets = new Set<string>();
  for (const item of found.spine) {
    const xml = await addText(item.path!);
    if (textBytes > EPUB_MAX_TEXT_BYTES) return tooMuchText;
    if (xml === null) continue;
    const head = firstElementInner(xml, "head") ?? "";
    for (const cssPath of linkedStylesheetPaths(head, posix.dirname(item.path!))) {
      if (stylesheets.has(cssPath)) continue;
      stylesheets.add(cssPath);
      await addText(cssPath);
      if (textBytes > EPUB_MAX_TEXT_BYTES) return tooMuchText;
    }
  }

  // Pictures (sz4 a): every listed picture counts (not only the ones a
  // page shows), at the size its own header states but never less than
  // EPUB_MIN_PICTURE_PIXELS, because each picture also costs a fixed
  // re-encode: 400 mid-size pictures (768 Mpx) took 23-30 s per buyer
  // open (audit r1, HIGH-1). With the floor, at most about 100 pictures.
  let pixels = 0;
  for (const [path, item] of found.byPath) {
    if (!RASTER_TYPES.has(item.mediaType)) continue;
    const file = zip.file(path);
    if (!file) continue;
    let bytes: Buffer;
    try {
      bytes = await file.async("nodebuffer");
    } catch {
      continue;
    }
    pixels += Math.max(EPUB_MIN_PICTURE_PIXELS, await picturePixels(bytes));
    if (pixels > EPUB_MAX_PICTURE_PIXELS) return { valid: false, reason: "pictures_too_large" };
  }
  return { valid: true };
}

// sz5 a (audit r1, MEDIUM-1): the buyer's online reader
// (/api/books/[id]/read) refuses an answer over MAX_READ_RESPONSE_BYTES,
// and a book's output can be up to ~2.7x its text. So the book is built
// once here exactly as for a buyer, and refused if that answer could
// not be sent. Run only after checkReaderSize, which bounds its cost
// (a few seconds at the very worst). The margin covers what the route
// adds around the book: the title (at most 500 characters, escaped up
// to 6 bytes each), the byline and the buyer's line.
const BUYER_RESPONSE_MARGIN_BYTES = 16 * 1024;

async function checkBuyerOutput(bytes: Buffer): Promise<EpubValidationResult> {
  const content = await buildReaderContent(bytes, "owned");
  // A book the reader cannot open costs the reader nothing to open.
  if (!content.available) return { valid: true };
  const size = Buffer.byteLength(JSON.stringify({ html: content.html, toc: content.toc }), "utf8");
  if (size + BUYER_RESPONSE_MARGIN_BYTES > MAX_READ_RESPONSE_BYTES) {
    return { valid: false, reason: "reader_output_too_large" };
  }
  return { valid: true };
}

async function picturePixels(bytes: Buffer): Promise<number> {
  try {
    const meta = await sharp(bytes, { limitInputPixels: false, animated: false }).metadata();
    return meta.width && meta.height ? meta.width * meta.height : 0;
  } catch {
    return 0;
  }
}
