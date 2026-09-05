import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { validateEpubStructure } from "./epub-validation";

// LAUNCH-1 P1: this file exists because the previous validator (inlined
// in src/app/dashboard/books/actions.ts, before this extraction) had
// ZERO test coverage of any kind -- confirmed during the production
// acceptance audit that found this bug. Every fixture here is built
// with real JSZip bytes (write with JSZip, read with JSZip), never
// mocked, so these tests exercise the exact same JSZip.loadAsync()
// round trip a real uploaded file goes through in production.

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:identifier id="uid">urn:uuid:00000000-0000-0000-0000-000000000000</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest></manifest>
  <spine></spine>
</package>`;

// EPUB2-style OPF: no unique-identifier/version="3.0" trappings, an
// <opf:package> root some EPUB2 tools emit, ncx-driven spine (toc
// attribute) instead of EPUB3's nav document. Only used to prove the
// validator doesn't care about OPF content/version -- it never parses
// the OPF body at all, only confirms the entry exists.
const OPF_EPUB2 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Test Book (EPUB2)</dc:title>
    <dc:identifier id="BookId" opf:scheme="UUID">urn:uuid:00000000-0000-0000-0000-000000000000</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"></spine>
</package>`;

function containerXmlFor(fullPath: string, quote: '"' | "'" = '"') {
  const q = quote;
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path=${q}${fullPath}${q} media-type=${q}application/oebps-package+xml${q}/>
  </rootfiles>
</container>`;
}

async function buildEpub({
  mimetypeCompression = "STORE" as "STORE" | "DEFLATE",
  containerXml = containerXmlFor("OEBPS/content.opf"),
  opfEntryPath = "OEBPS/content.opf",
  opfContent = OPF,
  omitMimetype = false,
  omitContainer = false,
  mimetypeValue = "application/epub+zip",
}: {
  mimetypeCompression?: "STORE" | "DEFLATE";
  containerXml?: string;
  opfEntryPath?: string;
  opfContent?: string;
  omitMimetype?: boolean;
  omitContainer?: boolean;
  mimetypeValue?: string;
} = {}): Promise<Buffer> {
  const zip = new JSZip();
  if (!omitMimetype) {
    zip.file("mimetype", mimetypeValue, { compression: mimetypeCompression });
  }
  if (!omitContainer) {
    zip.file("META-INF/container.xml", containerXml, { compression: "DEFLATE" });
  }
  zip.file(opfEntryPath, opfContent, { compression: "DEFLATE" });
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("validateEpubStructure: accepts real, structurally valid EPUBs", () => {
  // LAUNCH-1 P1 REGRESSION: this is the exact bug. The mimetype entry is
  // written STORE (spec-compliant, "textbook valid"), but after
  // JSZip.loadAsync() -- the same round trip every real upload goes
  // through -- entry.options.compression reads null regardless of the
  // entry's actual on-disk compression method (confirmed in the
  // LAUNCH-1 P1 audit against jszip@3.10.1's own type definitions: the
  // only read-side compression interface is an explicitly private,
  // commented-out API). The removed check compared against that always-
  // null value, so it rejected every EPUB ever uploaded, with no
  // exception -- including this one. This test documents that bug
  // forever: it must pass now, and would have failed against the old
  // validator. No private _data field is asserted here or anywhere in
  // this file -- only the function's own public result.
  it("accepts a valid EPUB after JSZip load even when loaded entry compression metadata is null", async () => {
    const bytes = await buildEpub({ mimetypeCompression: "STORE" });
    const result = await validateEpubStructure(bytes);
    expect(result).toEqual({ valid: true });
  });

  it("accepts a DEFLATE-compressed mimetype entry -- compression method is no longer a validation boundary", async () => {
    const bytes = await buildEpub({ mimetypeCompression: "DEFLATE" });
    const result = await validateEpubStructure(bytes);
    expect(result).toEqual({ valid: true });
  });

  it("accepts a double-quoted full-path attribute", async () => {
    const bytes = await buildEpub({ containerXml: containerXmlFor("OEBPS/content.opf", '"') });
    expect(await validateEpubStructure(bytes)).toEqual({ valid: true });
  });

  it("accepts a single-quoted full-path attribute", async () => {
    const bytes = await buildEpub({ containerXml: containerXmlFor("OEBPS/content.opf", "'") });
    expect(await validateEpubStructure(bytes)).toEqual({ valid: true });
  });

  // LAUNCH-1 P1: the OPF leading-slash normalization hardening -- some
  // EPUB-producing tools write full-path="/OEBPS/content.opf" even
  // though real zip entry names never carry a leading slash. The actual
  // archive entry here is stored as "OEBPS/content.opf" (no leading
  // slash, as always) while container.xml claims the absolute-looking
  // path -- this must still resolve.
  it("accepts a leading-slash OPF path in container.xml by normalizing only the lookup", async () => {
    const bytes = await buildEpub({
      containerXml: containerXmlFor("/OEBPS/content.opf"),
      opfEntryPath: "OEBPS/content.opf",
    });
    expect(await validateEpubStructure(bytes)).toEqual({ valid: true });
  });

  it("accepts an EPUB2-style OPF (version 2.0, NCX-driven spine) -- the validator never parses OPF content, only confirms the entry exists", async () => {
    const bytes = await buildEpub({ opfContent: OPF_EPUB2 });
    expect(await validateEpubStructure(bytes)).toEqual({ valid: true });
  });

  it("accepts an EPUB3-style OPF (version 3.0, unique-identifier)", async () => {
    const bytes = await buildEpub({ opfContent: OPF });
    expect(await validateEpubStructure(bytes)).toEqual({ valid: true });
  });
});

describe("validateEpubStructure: rejects malformed/non-EPUB input", () => {
  it("rejects arbitrary non-ZIP bytes", async () => {
    const bytes = Buffer.from("this is not a zip file at all, just plain bytes");
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "invalid_zip",
    });
  });

  it("rejects a ZIP missing the mimetype entry", async () => {
    const bytes = await buildEpub({ omitMimetype: true });
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "missing_mimetype",
    });
  });

  it("rejects the wrong mimetype value", async () => {
    const bytes = await buildEpub({ mimetypeValue: "application/zip" });
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "invalid_mimetype",
    });
  });

  it("rejects a ZIP missing META-INF/container.xml", async () => {
    const bytes = await buildEpub({ omitContainer: true });
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "missing_container",
    });
  });

  it("rejects a container.xml exceeding the existing size bound", async () => {
    const oversizedContainerXml = containerXmlFor("OEBPS/content.opf") + "x".repeat(17 * 1024);
    const bytes = await buildEpub({ containerXml: oversizedContainerXml });
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "container_too_large",
    });
  });

  it("rejects container.xml with no rootfile full-path attribute", async () => {
    const noFullPath = `<?xml version="1.0"?><container><rootfiles><rootfile media-type="application/oebps-package+xml"/></rootfiles></container>`;
    const bytes = await buildEpub({ containerXml: noFullPath });
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "missing_rootfile",
    });
  });

  it("rejects a rootfile path that is empty after normalization", async () => {
    const emptyPath = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="/" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    const bytes = await buildEpub({ containerXml: emptyPath });
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "missing_rootfile",
    });
  });

  it("rejects when the referenced OPF entry is absent from the archive", async () => {
    const bytes = await buildEpub({
      containerXml: containerXmlFor("OEBPS/content.opf"),
      opfEntryPath: "OEBPS/some-other-file.opf",
    });
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "missing_opf",
    });
  });
});

// LIBRUM 2.0 EPUB-VALIDATION-1B: proves the preflight/DRM/path-safety
// additions actually run through validateEpubStructure() itself using
// its REAL, non-configurable EPUB_ZIP_PREFLIGHT_LIMITS -- not
// preflightZipEntries() called directly with custom smaller limits
// (that's zip-preflight.test.ts's own job). Zip-bomb-shaped fixtures
// below use real, DEFLATE-compressible all-zero content (the same
// technique zip-preflight.test.ts's own bomb test already
// established) -- tiny actual compressed footprint, fast to generate,
// while still exercising the real declared-size thresholds.
describe("validateEpubStructure: resource limits (EPUB-VALIDATION-1B)", () => {
  it("rejects an archive with more entries than EPUB_ZIP_PREFLIGHT_LIMITS.maxEntries", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", containerXmlFor("OEBPS/content.opf"), { compression: "DEFLATE" });
    zip.file("OEBPS/content.opf", OPF, { compression: "DEFLATE" });
    for (let i = 0; i < 5001; i++) {
      zip.file(`OEBPS/filler-${i}.txt`, "x");
    }
    const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "too_many_entries",
    });
  });

  it(
    "rejects an archive whose declared TOTAL uncompressed size exceeds the aggregate limit, even though every individual entry stays within the per-entry limit",
    async () => {
      const zip = new JSZip();
      zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
      zip.file("META-INF/container.xml", containerXmlFor("OEBPS/content.opf"), { compression: "DEFLATE" });
      zip.file("OEBPS/content.opf", OPF, { compression: "DEFLATE" });

      // 7 entries at 50MB each (the per-entry cap itself, so none of
      // them individually trips entry_too_large) sum to 350MB, over the
      // 300MB aggregate cap. One shared buffer reference keeps peak
      // memory to ~50MB rather than ~350MB; compression level 1
      // (fastest) is plenty for content this trivially compressible
      // (all zeros) and keeps this test fast despite the large declared
      // size.
      const chunk = Buffer.alloc(50 * 1024 * 1024, 0);
      for (let i = 0; i < 7; i++) {
        zip.file(`OEBPS/bomb-${i}.bin`, chunk, { compression: "DEFLATE", compressionOptions: { level: 1 } });
      }
      const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

      expect(await validateEpubStructure(bytes)).toEqual({
        valid: false,
        reason: "too_large_uncompressed",
      });
    },
    20_000,
  );

  it("rejects an archive containing a single entry whose declared uncompressed size exceeds the per-entry limit -- the exact zip-bomb shape EPUB-VALIDATION-1A found unbounded (tiny compressed, enormous declared uncompressed)", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", containerXmlFor("OEBPS/content.opf"), { compression: "DEFLATE" });
    zip.file("OEBPS/content.opf", OPF, { compression: "DEFLATE" });

    const bomb = Buffer.alloc(51 * 1024 * 1024, 0);
    zip.file("OEBPS/bomb.bin", bomb, { compression: "DEFLATE", compressionOptions: { level: 9 } });
    const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    // Prove the compressed archive itself stays small -- the whole
    // point of both this test and the fix it verifies.
    expect(bytes.length).toBeLessThan(1024 * 1024);

    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "entry_too_large",
    });
  });
});

describe("validateEpubStructure: DRM/encryption (EPUB-VALIDATION-1B)", () => {
  it("rejects an EPUB containing META-INF/encryption.xml, presence alone, content never parsed", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", containerXmlFor("OEBPS/content.opf"), { compression: "DEFLATE" });
    zip.file("META-INF/encryption.xml", "this is not even valid XML {{{", { compression: "DEFLATE" });
    zip.file("OEBPS/content.opf", OPF, { compression: "DEFLATE" });
    const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "encrypted_or_drm",
    });
  });

  it("an EPUB with no META-INF/encryption.xml is unaffected -- the ordinary valid-EPUB path still passes", async () => {
    const bytes = await buildEpub();
    expect(await validateEpubStructure(bytes)).toEqual({ valid: true });
  });
});

describe("validateEpubStructure: archive-path safety (EPUB-VALIDATION-1B)", () => {
  it("rejects a rootfile full-path that resolves outside the archive root via '../' traversal", async () => {
    const bytes = await buildEpub({
      containerXml: containerXmlFor("../../etc/passwd"),
      opfEntryPath: "OEBPS/content.opf",
    });
    expect(await validateEpubStructure(bytes)).toEqual({
      valid: false,
      reason: "unsafe_path",
    });
  });

  it("still accepts the existing approved leading-slash rootfile compatibility case -- resolveArchivePath never sees the leading slash, since it's stripped before reaching it, unchanged from before this pass", async () => {
    const bytes = await buildEpub({
      containerXml: containerXmlFor("/OEBPS/content.opf"),
      opfEntryPath: "OEBPS/content.opf",
    });
    expect(await validateEpubStructure(bytes)).toEqual({ valid: true });
  });
});

// LIBRUM 2.0 EPUB-VALIDATION-1B: Librum's own generated EPUBs must
// keep passing after every addition above. Direct, not indirect --
// exercises the REAL generateEpub() output, not a hand-built fixture
// shaped like it.
describe("validateEpubStructure: Librum-generated EPUB regression (EPUB-VALIDATION-1B)", () => {
  it("accepts the exact bytes generateEpub() produces", async () => {
    const { generateEpub } = await import("./epub-generator");
    const bytes = await generateEpub({
      bookId: "book-1",
      title: "Test Book",
      authorName: "Test Author",
      sections: [
        { heading: "Chapter One", html: "<p>Once upon a time.</p>" },
        { heading: "Chapter Two", html: "<p>The end.</p>" },
      ],
      images: [],
    });

    expect(await validateEpubStructure(bytes)).toEqual({ valid: true });
  });
});
