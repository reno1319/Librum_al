import JSZip from "jszip";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Lightweight anti-piracy, not DRM: stamps the buyer's email into the
// EPUB's own metadata (its .opf package file) so a leaked copy can be
// traced back to whoever downloaded it. The file still opens normally
// everywhere — nothing is encrypted or restricted.
//
// Best-effort: if the EPUB doesn't have the structure we expect for any
// reason, this just returns the original bytes rather than failing the
// download.
export async function watermarkEpub(bytes: Buffer, email: string): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(bytes);

    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) return bytes;

    const containerXml = await containerFile.async("string");
    const rootfileMatch = containerXml.match(/full-path="([^"]+)"/i);
    if (!rootfileMatch) return bytes;

    const opfPath = rootfileMatch[1];
    const opfFile = zip.file(opfPath);
    if (!opfFile) return bytes;

    const opfXml = await opfFile.async("string");
    const notice = `<dc:rights>This copy is licensed to ${escapeXml(email)}. Please do not distribute.</dc:rights>`;
    const updatedOpf = opfXml.replace(
      /(<[a-zA-Z0-9:]*metadata[^>]*>)/i,
      `$1${notice}`,
    );

    // Metadata tag not found in the shape we expected — bail out rather
    // than silently produce an unwatermarked file that looks watermarked.
    if (updatedOpf === opfXml) return bytes;

    zip.file(opfPath, updatedOpf);
    return await zip.generateAsync({ type: "nodebuffer" });
  } catch {
    return bytes;
  }
}
