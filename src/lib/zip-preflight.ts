// LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: a real, pre-inflation
// ZIP-bomb preflight for DOCX uploads. Audited first, not assumed:
// JSZip's own public API (node_modules/jszip/index.d.ts) exposes
// `compressedSize`/`uncompressedSize` ONLY on a `CompressedObject`
// interface its own type definitions mark private with the comment
// "if/when it is made public this should be uncommented" -- the public
// `JSZipObject` interface (name/dir/date/comment/permissions/options/
// async()/nodeStream()) has no size field of any kind. There is no
// supported way to learn an entry's uncompressed size through JSZip
// without calling `.async()` on it, which decompresses it into memory
// -- exactly the operation a preflight needs to happen BEFORE.
//
// The fix: read the ZIP's own End Of Central Directory record and
// Central Directory File Headers directly from the raw, still-
// compressed buffer -- a fixed-format, well-documented binary
// structure (PKWARE's APPNOTE.TXT) that stores each entry's
// uncompressed size as a real header field, independent of and prior
// to actually decompressing anything. This needed no new dependency:
// it's the same "hand-parse a well-specified binary/XML format rather
// than take on a library" precedent this codebase already established
// in epub-validation.ts (container.xml) and the raw local-file-header
// byte check in epub-generator.test.ts's own mimetype/STORE assertion.
//
// Honest limit of this defense (documented, not hidden): a ZIP's
// central directory is not cryptographically bound to what its DEFLATE
// streams actually decompress to -- nothing stops a deliberately
// crafted archive from lying in its own header while still decoding
// through JSZip. What this DOES reliably catch: every accidental case
// (a huge but honest manuscript, a document with far more parts/images
// than reasonable) and the overwhelming majority of naive zip-bomb
// attempts, entirely before any inflation happens. It is a real,
// meaningful bound, not a complete guarantee against a maliciously
// self-consistent forged central directory -- closing that last gap
// would need OS/process-level memory limits, an infrastructure concern
// outside this module's reach, not a code-level fix available here.

export type ZipPreflightEntry = {
  name: string;
  uncompressedSize: number;
};

export type ZipPreflightResult =
  | { ok: true; entries: ZipPreflightEntry[] }
  | {
      ok: false;
      reason: "not_a_zip" | "too_many_entries" | "too_large_uncompressed" | "entry_too_large";
    };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
// EOCD is fixed-size (22 bytes) plus up to a 64KB comment -- the
// signature is searched for within that trailing window, same bound
// every ZIP reader uses.
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;
// A ZIP64 marker (fields reading as 0xFFFFFFFF, meaning "see the
// ZIP64 extra record") is treated as an unconditional rejection rather
// than parsed -- no legitimate Word-authored DOCX is ever ZIP64
// (that format exists for archives over 4GB / 65535 entries), so
// there's no real-world case this excludes, only a parsing path this
// preflight deliberately doesn't need to trust.
const ZIP64_MARKER = 0xffffffff;

export function preflightZipEntries(
  buffer: Buffer,
  limits: {
    maxEntries: number;
    maxTotalUncompressedBytes: number;
    // LIBRUM 2.0 EPUB-VALIDATION-1B: optional -- omitted, the exact
    // shape every pre-existing DOCX caller already uses, skips this
    // check entirely, leaving DOCX behavior byte-for-byte unchanged.
    // Added for EPUB validation, which needs a bound on any SINGLE
    // entry's declared uncompressed size (not just the aggregate) --
    // see epub-validation.ts's own comment for why: a single
    // pathological entry (tiny compressed, enormous declared
    // uncompressed) is the actual zip-bomb shape that mattered there,
    // and the aggregate-only check alone doesn't catch it until AFTER
    // that one entry has already been added to the running total (by
    // which point, for a real zip bomb, the aggregate check would also
    // fire -- but only after reading that entry's own header, still
    // before any decompression; this option makes the specific entry
    // responsible identifiable via its own dedicated reason instead of
    // an aggregate one).
    maxSingleEntryUncompressedBytes?: number;
  },
): ZipPreflightResult {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === null) {
    return { ok: false, reason: "not_a_zip" };
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries === 0xffff || centralDirOffset === ZIP64_MARKER) {
    // ZIP64 marker on the EOCD record itself.
    return { ok: false, reason: "too_many_entries" };
  }
  if (totalEntries > limits.maxEntries) {
    return { ok: false, reason: "too_many_entries" };
  }

  const entries: ZipPreflightEntry[] = [];
  let cursor = centralDirOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > buffer.length) {
      return { ok: false, reason: "not_a_zip" };
    }
    const signature = buffer.readUInt32LE(cursor);
    if (signature !== CENTRAL_DIRECTORY_SIGNATURE) {
      return { ok: false, reason: "not_a_zip" };
    }

    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);

    if (uncompressedSize === ZIP64_MARKER) {
      return { ok: false, reason: "too_large_uncompressed" };
    }

    // Checked BEFORE folding into the running aggregate, and against
    // the declared size straight from the central directory header --
    // same "before any inflation happens" guarantee the aggregate
    // check below already provides, just scoped to one entry rather
    // than the whole archive.
    if (
      limits.maxSingleEntryUncompressedBytes !== undefined &&
      uncompressedSize > limits.maxSingleEntryUncompressedBytes
    ) {
      return { ok: false, reason: "entry_too_large" };
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      return { ok: false, reason: "too_large_uncompressed" };
    }

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      return { ok: false, reason: "not_a_zip" };
    }
    const name = buffer.toString("utf8", nameStart, nameEnd);
    entries.push({ name, uncompressedSize });

    cursor = nameEnd + extraLength + commentLength;
  }

  return { ok: true, entries };
}

function findEndOfCentralDirectory(buffer: Buffer): number | null {
  const searchStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  return null;
}

export function findEntry(entries: ZipPreflightEntry[], name: string): ZipPreflightEntry | undefined {
  return entries.find((e) => e.name === name);
}
