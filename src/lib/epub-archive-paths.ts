import { posix } from "node:path";

// LIBRUM 2.0 EPUB-VALIDATION-1B: one shared archive-relative path
// resolver for both epub-validation.ts (the container.xml rootfile
// path) and epub-sample.ts (manifest item hrefs, resolved relative to
// the OPF's own directory) -- previously each file had its own
// slightly different inline normalization. JSZip has no filesystem
// access at all (it is a name -> compressed-entry Map, nothing else),
// so there is no real filesystem to escape to; the actual risk a
// crafted path poses here is a normalized result that no longer
// denotes what the referencing document plausibly meant, worth
// rejecting outright rather than quietly attempting (and likely
// failing) a lookup for something else. No filesystem extraction is
// used or needed anywhere in this resolution -- resolveArchivePath
// only ever produces a string, which the caller then looks up via
// JSZip's own in-memory `zip.file(name)`.
//
// A leading "/" in `relativePath` is rejected here as unsafe input,
// not silently stripped -- this is the ONE place this codebase
// tightens rather than tolerates that shape. It's deliberately
// different from container.xml's own rootfile full-path attribute,
// which keeps its OWN pre-existing, narrower, already-tested
// leading-slash tolerance in epub-validation.ts (some real EPUB-
// producing tools write full-path="/OEBPS/content.opf" -- a
// compatibility quirk, stripped BEFORE ever reaching this resolver,
// unchanged by this module). A manifest href, by contrast, has no
// legitimate reason to be archive-root-absolute, so treating that
// shape as unsafe input here, rather than a compatibility quirk to
// normalize through, is the correct default for every OTHER path this
// resolver is used for.
export type ArchivePathResolution = { safe: true; path: string } | { safe: false };

export function resolveArchivePath(baseDir: string, relativePath: string): ArchivePathResolution {
  if (!relativePath || relativePath.includes("\0")) return { safe: false };
  if (relativePath.startsWith("/")) return { safe: false };

  const joined = baseDir ? posix.join(baseDir, relativePath) : relativePath;
  const normalized = posix.normalize(joined);

  // A normalized result that is empty, exactly "..", or still starts
  // with "../" means the input walked at or above whatever archive
  // root `baseDir` itself was already relative to -- rejected, never
  // silently clamped to root or otherwise guessed at. A LEGITIMATE
  // sibling-directory reference (e.g. baseDir="OEBPS/Text2",
  // relativePath="../Text/chapter.xhtml") normalizes to
  // "OEBPS/Text/chapter.xhtml" -- doesn't start with "../" -- and is
  // correctly accepted below.
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return { safe: false };
  }

  return { safe: true, path: normalized };
}
