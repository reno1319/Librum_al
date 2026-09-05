import JSZip from "jszip";
import { preflightZipEntries } from "@/lib/zip-preflight";
import { resolveArchivePath } from "@/lib/epub-archive-paths";

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
        | "unsafe_path";
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

  return { valid: true };
}
