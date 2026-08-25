import JSZip from "jszip";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// LAUNCH-1 P3-2: the caller (the download route) needs to know WHETHER
// watermarking actually happened, not just get bytes back -- that's the
// only way it can produce exactly one operator-visible log for a
// fallback. Deliberately a small, two-value taxonomy, not one code per
// bail-out branch below: every "unsupported_structure" case already
// shares one designed-for meaning ("this EPUB doesn't have the shape
// this lightweight regex-based watermarker expects"), which is this
// function's own pre-existing, explicit design philosophy (see the
// comment on watermarkEpub itself) -- splitting it further would add
// taxonomy without adding operator value. "unexpected_exception" stays
// distinct because, by definition, nothing here anticipates it.
export type WatermarkFailureStage = "unsupported_structure" | "unexpected_exception";

export type WatermarkResult =
  | {
      watermarked: true;
      bytes: Buffer;
    }
  | {
      watermarked: false;
      bytes: Buffer;
      failureStage: WatermarkFailureStage;
    };

// Lightweight anti-piracy, not DRM: stamps the buyer's email into the
// EPUB's own metadata (its .opf package file) so a leaked copy can be
// traced back to whoever downloaded it. The file still opens normally
// everywhere — nothing is encrypted or restricted.
//
// Best-effort: if the EPUB doesn't have the structure we expect for any
// reason, this just returns the original bytes rather than failing the
// download -- reported via the structured result above, not thrown.
//
// LAUNCH-1 P3-2: never logs anything itself -- the caller (which has
// the request/book context this function deliberately doesn't) is the
// sole logging boundary. See src/app/api/books/[id]/download/route.ts.
export async function watermarkEpub(bytes: Buffer, email: string): Promise<WatermarkResult> {
  try {
    const zip = await JSZip.loadAsync(bytes);

    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) {
      return { watermarked: false, bytes, failureStage: "unsupported_structure" };
    }

    const containerXml = await containerFile.async("string");
    const rootfileMatch = containerXml.match(/full-path="([^"]+)"/i);
    if (!rootfileMatch) {
      return { watermarked: false, bytes, failureStage: "unsupported_structure" };
    }

    const opfPath = rootfileMatch[1];
    const opfFile = zip.file(opfPath);
    if (!opfFile) {
      return { watermarked: false, bytes, failureStage: "unsupported_structure" };
    }

    const opfXml = await opfFile.async("string");
    const notice = `<dc:rights>This copy is licensed to ${escapeXml(email)}. Please do not distribute.</dc:rights>`;
    const updatedOpf = opfXml.replace(
      /(<[a-zA-Z0-9:]*metadata[^>]*>)/i,
      `$1${notice}`,
    );

    // Metadata tag not found in the shape we expected — bail out rather
    // than silently produce an unwatermarked file that looks watermarked.
    if (updatedOpf === opfXml) {
      return { watermarked: false, bytes, failureStage: "unsupported_structure" };
    }

    zip.file(opfPath, updatedOpf);
    const generatedBytes = await zip.generateAsync({ type: "nodebuffer" });
    return { watermarked: true, bytes: generatedBytes };
  } catch {
    return { watermarked: false, bytes, failureStage: "unexpected_exception" };
  }
}
