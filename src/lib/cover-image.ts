// LAUNCH-1 P3-1: cover-image byte-signature detection and canonical
// storage-key/Content-Type resolution -- pure, framework-independent
// helpers, deliberately NOT living in src/app/dashboard/books/actions.ts
// (a "use server" module). That file requires every export to be an
// async Server Action (a Next.js build-time constraint), which these
// pure/test-only helpers are not -- keeping them here avoids expanding
// the Server Action surface solely to satisfy that constraint, and lets
// resolveVerifiedCoverStorageDetails stay genuinely synchronous.
//
// Checks the actual file signature (magic bytes), not the filename or
// browser-reported MIME type -- neither of those can be trusted, and
// this is the standard, dependency-free way to confirm a file's real
// format. Only reads the first few bytes, never the whole image.
//
// detectCoverImageKind returns WHICH format matched, not just whether
// one did -- this verified kind is then the single source of truth for
// both the cover's stored storage-key extension and its stored
// Content-Type metadata, replacing cover.name/cover.type for both.
export type VerifiedCoverImageKind = "jpeg" | "png";

export async function detectCoverImageKind(
  file: File,
): Promise<VerifiedCoverImageKind | null> {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());

  const isPng =
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a;
  if (isPng) return "png";

  const isJpeg =
    header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (isJpeg) return "jpeg";

  return null;
}

// The ONLY place cover storage-key extensions and Content-Type values
// come from -- both keyed exclusively on the server-verified byte
// signature above, never on cover.name or cover.type. Accepted formats
// remain exactly JPEG and PNG, matching both upload UIs' own
// accept="image/png,image/jpeg" attribute; WebP and SVG are
// deliberately not added here (see the P3-1 audit -- WebP was never
// actually supported despite being a plausible-sounding candidate, and
// SVG can embed script content, unsafe on a public bucket).
export function resolveVerifiedCoverStorageDetails(
  kind: VerifiedCoverImageKind,
): {
  extension: "jpg" | "png";
  contentType: "image/jpeg" | "image/png";
} {
  return kind === "png"
    ? { extension: "png", contentType: "image/png" }
    : { extension: "jpg", contentType: "image/jpeg" };
}
