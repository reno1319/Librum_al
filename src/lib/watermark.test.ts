import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { watermarkEpub } from "./watermark";

// LAUNCH-1 P3-2: watermark.ts never logs anything itself (the download
// route is the sole logging boundary -- see route.test.ts) -- these
// tests only ever assert on the returned WatermarkResult, never on
// console output.

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF_WITH_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
  </metadata>
  <manifest></manifest>
  <spine></spine>
</package>`;

async function buildValidEpub(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", OPF_WITH_METADATA);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("watermarkEpub", () => {
  it("valid EPUB: watermarked=true, bytes differ from the original, output contains the escaped buyer's watermark notice", async () => {
    const original = await buildValidEpub();

    const result = await watermarkEpub(original, "reader@example.com");

    expect(result.watermarked).toBe(true);
    expect(result.bytes.equals(original)).toBe(false);

    // Read the OPF back out of the resulting zip to confirm the notice
    // actually landed inside <metadata>, not just that SOME bytes changed.
    const resultZip = await JSZip.loadAsync(result.bytes);
    const opfXml = await resultZip.file("OEBPS/content.opf")!.async("string");
    expect(opfXml).toContain(
      "This copy is licensed to reader@example.com. Please do not distribute.",
    );
    expect(opfXml).toContain("<dc:rights>");
  });

  it("special characters in the email remain correctly escaped in the successful output", async () => {
    const original = await buildValidEpub();

    const result = await watermarkEpub(original, `o'brien+test<x>@example.com`);

    expect(result.watermarked).toBe(true);
    const resultZip = await JSZip.loadAsync(result.bytes);
    const opfXml = await resultZip.file("OEBPS/content.opf")!.async("string");
    expect(opfXml).toContain("o&apos;brien+test&lt;x&gt;@example.com");
    // The raw, unescaped characters must never appear in the XML.
    expect(opfXml).not.toContain(`o'brien+test<x>@example.com`);
  });

  it("missing META-INF/container.xml: watermarked=false, unsupported_structure, original bytes byte-identical", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("OEBPS/content.opf", OPF_WITH_METADATA);
    const original = await zip.generateAsync({ type: "nodebuffer" });

    const result = await watermarkEpub(original, "reader@example.com");

    expect(result.watermarked).toBe(false);
    if (!result.watermarked) {
      expect(result.failureStage).toBe("unsupported_structure");
    }
    expect(result.bytes.equals(original)).toBe(true);
  });

  it("no rootfile full-path match in container.xml: watermarked=false, unsupported_structure, original unchanged", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0"?><container><rootfiles><rootfile media-type="application/oebps-package+xml"/></rootfiles></container>`,
    );
    zip.file("OEBPS/content.opf", OPF_WITH_METADATA);
    const original = await zip.generateAsync({ type: "nodebuffer" });

    const result = await watermarkEpub(original, "reader@example.com");

    expect(result.watermarked).toBe(false);
    if (!result.watermarked) {
      expect(result.failureStage).toBe("unsupported_structure");
    }
    expect(result.bytes.equals(original)).toBe(true);
  });

  it("missing referenced OPF file: watermarked=false, unsupported_structure, original unchanged", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
    // Deliberately no OEBPS/content.opf entry, even though container.xml
    // references it.
    const original = await zip.generateAsync({ type: "nodebuffer" });

    const result = await watermarkEpub(original, "reader@example.com");

    expect(result.watermarked).toBe(false);
    if (!result.watermarked) {
      expect(result.failureStage).toBe("unsupported_structure");
    }
    expect(result.bytes.equals(original)).toBe(true);
  });

  it("missing metadata insertion target: watermarked=false, unsupported_structure, original unchanged", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
    // A structurally-present OPF with no <metadata ...> tag at all -- the
    // replace() in watermarkEpub has nothing to match, so it's a no-op.
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><manifest></manifest></package>`,
    );
    const original = await zip.generateAsync({ type: "nodebuffer" });

    const result = await watermarkEpub(original, "reader@example.com");

    expect(result.watermarked).toBe(false);
    if (!result.watermarked) {
      expect(result.failureStage).toBe("unsupported_structure");
    }
    expect(result.bytes.equals(original)).toBe(true);
  });

  it("malformed ZIP: watermarked=false, unexpected_exception, original bytes unchanged", async () => {
    const original = Buffer.from("this is not a zip file at all, just plain bytes");

    const result = await watermarkEpub(original, "reader@example.com");

    expect(result.watermarked).toBe(false);
    if (!result.watermarked) {
      expect(result.failureStage).toBe("unexpected_exception");
    }
    expect(result.bytes.equals(original)).toBe(true);
  });
});
