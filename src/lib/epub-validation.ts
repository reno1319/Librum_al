import JSZip from "jszip";

// container.xml is always a tiny, fixed-shape file (a few hundred bytes
// in every real EPUB). JSZip has no supported, public API to inspect an
// entry's uncompressed size before decompressing it -- the only such
// property, _data.uncompressedSize, is explicitly documented as private
// in JSZip's own type definitions ("this private _data property... if/
// when it is made public this should be uncommented"), so it is
// deliberately not used here. Instead, container.xml's decoded text is
// rejected outright if it's larger than this cap -- a lightweight,
// public-API-only bound on how much of it gets processed, not zip-bomb
// protection for the archive as a whole (which remains bounded only by
// the caller's own upload size limit).
const MAX_CONTAINER_XML_BYTES = 16 * 1024;

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
        | "missing_opf";
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
  if (!zip.file(normalizedOpfPath)) return { valid: false, reason: "missing_opf" };

  return { valid: true };
}
