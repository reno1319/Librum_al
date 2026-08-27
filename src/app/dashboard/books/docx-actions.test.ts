import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomBytes } from "crypto";
import JSZip from "jszip";
import { buildDocxBytes, heading, paragraph } from "@/lib/docx-test-fixtures";

// LIBRUM 2.0 PRODUCT-5 413 CORRECTION: parseDocxToDocument()/
// repackageWithTitle() no longer take a File/FormData or return EPUB
// bytes -- both now talk to Supabase Storage exclusively (see the
// correction's own top-of-file comment in docx-actions.ts for why).
// Real conversion/packaging code runs for real here (real DOCX bytes
// via buildDocxBytes, real Mammoth, real JSZip, real
// validateEpubStructure()) -- only the Supabase server client's
// storage.from("manuscripts") calls are faked, in-memory, following
// the same mocking convention src/app/dashboard/books/actions.test.ts
// already established for this codebase's Server Action tests.

const USER_ID = "author-1";

function createFakeStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    from(bucket: string) {
      if (bucket !== "manuscripts") {
        throw new Error(`unexpected bucket in this focused test: ${bucket}`);
      }
      return {
        async download(path: string) {
          const bytes = objects.get(path);
          if (!bytes) return { data: null, error: { message: "not found" } };
          return {
            data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
            error: null,
          };
        },
        async upload(path: string, body: Buffer) {
          objects.set(path, Buffer.isBuffer(body) ? body : Buffer.from(body as unknown as Uint8Array));
          return { error: null };
        },
        async remove(paths: string[]) {
          paths.forEach((p) => objects.delete(p));
          return { error: null };
        },
      };
    },
  };
}

const mockGetUser = vi.fn();
let fakeStorage: ReturnType<typeof createFakeStorage>;

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    storage: fakeStorage,
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { parseDocxToDocument, repackageWithTitle } = await import("./docx-actions");

beforeEach(() => {
  fakeStorage = createFakeStorage();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
});

async function realDocxBytes(): Promise<Buffer> {
  return buildDocxBytes({
    includeStyles: true,
    bodyXml: heading(1, "Chapter One") + paragraph("Some real chapter text."),
  });
}

describe("parseDocxToDocument", () => {
  it("downloads the temp DOCX, converts it, packages+stores a temp EPUB, and removes the temp DOCX", async () => {
    const tempDocxPath = `${USER_ID}/tmp/docx/abc.docx`;
    fakeStorage.objects.set(tempDocxPath, await realDocxBytes());

    const result = await parseDocxToDocument(tempDocxPath);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.conversionId).toMatch(new RegExp(`^${USER_ID}/tmp/epub/.+\\.epub$`));
    expect(fakeStorage.objects.has(tempDocxPath)).toBe(false);

    const epubBytes = fakeStorage.objects.get(result.conversionId);
    expect(epubBytes).toBeDefined();
    const zip = await JSZip.loadAsync(epubBytes!);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    // No real title/author known yet at parse time -- see the
    // trim-or-placeholder fallback docx-actions.ts documents.
    expect(opf).toContain("<dc:title>Untitled manuscript</dc:title>");
    expect(opf).toContain("<dc:creator>Unknown author</dc:creator>");
  });

  it("rejects a temp path not owned by the calling user, without touching storage", async () => {
    const foreignPath = "someone-else/tmp/docx/abc.docx";
    fakeStorage.objects.set(foreignPath, await realDocxBytes());

    const result = await parseDocxToDocument(foreignPath);
    expect(result).toEqual({
      success: false,
      error: "Something went wrong converting this document. Please try again.",
    });
    expect(fakeStorage.objects.has(foreignPath)).toBe(true);
  });

  it("fails with a controlled message when there's no authenticated user", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const result = await parseDocxToDocument(`${USER_ID}/tmp/docx/abc.docx`);
    expect(result).toEqual({
      success: false,
      error: "Your session has expired. Please refresh the page and try again.",
    });
  });

  it("fails with a controlled message when the temp DOCX object is missing from storage", async () => {
    const result = await parseDocxToDocument(`${USER_ID}/tmp/docx/does-not-exist.docx`);
    expect(result).toEqual({
      success: false,
      error: "Something went wrong converting this document. Please try again.",
    });
  });

  it("converts a real DOCX well over Vercel's confirmed ~4.5MB payload limit -- the actual production defect this correction fixes", async () => {
    // Mirrors the real, reported failure: a genuine ~8.3MB DOCX 413'd
    // before conversion ever started, because its bytes used to be
    // sent through a Server Action's own request body. Here the
    // "upload" is just an entry already sitting in fake storage (as a
    // real browser upload would leave it) -- parseDocxToDocument()
    // downloads it via the Storage SDK, never through any Server
    // Action request body, so there's no size ceiling to hit.
    const base = await buildDocxBytes({
      includeStyles: true,
      includeImageRel: true,
      bodyXml: heading(1, "Chapter One") + paragraph("Some real chapter text."),
    });
    const zip = await JSZip.loadAsync(base);
    // Not a real, referenced image -- just bulk, incompressible bytes
    // padding this fixture DOCX past the confirmed 4.5MB threshold,
    // the same way a real illustrated manuscript's own media parts do.
    zip.file("word/media/image1.png", randomBytes(6 * 1024 * 1024));
    const bigDocxBytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    expect(bigDocxBytes.length).toBeGreaterThan(4.5 * 1024 * 1024);

    const tempDocxPath = `${USER_ID}/tmp/docx/big.docx`;
    fakeStorage.objects.set(tempDocxPath, bigDocxBytes);

    const result = await parseDocxToDocument(tempDocxPath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings).toEqual([]);
    expect(fakeStorage.objects.has(result.conversionId)).toBe(true);
  });

  it("removes the temp DOCX even when conversion itself fails", async () => {
    const tempDocxPath = `${USER_ID}/tmp/docx/bad.docx`;
    fakeStorage.objects.set(tempDocxPath, Buffer.from("not a zip at all"));

    const result = await parseDocxToDocument(tempDocxPath);
    expect(result.success).toBe(false);
    expect(fakeStorage.objects.has(tempDocxPath)).toBe(false);
  });
});

describe("repackageWithTitle", () => {
  async function storedTempEpub(): Promise<string> {
    const tempDocxPath = `${USER_ID}/tmp/docx/src.docx`;
    fakeStorage.objects.set(tempDocxPath, await realDocxBytes());
    const parsed = await parseDocxToDocument(tempDocxPath);
    if (!parsed.success) throw new Error("fixture setup failed");
    return parsed.conversionId;
  }

  it("patches the stored temp EPUB's title/author and re-validates it, without re-running conversion", async () => {
    const conversionId = await storedTempEpub();

    const result = await repackageWithTitle(conversionId, "The Maltese Falcon", "Dashiell Hammett");
    expect(result).toEqual({ success: true });

    const epubBytes = fakeStorage.objects.get(conversionId)!;
    const zip = await JSZip.loadAsync(epubBytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>The Maltese Falcon</dc:title>");
    expect(opf).toContain("<dc:creator>Dashiell Hammett</dc:creator>");
    // The chapter content Mammoth actually parsed survives untouched --
    // proof this was a metadata-only patch, not a full Mammoth re-run.
    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter).toContain("Some real chapter text.");
  });

  it("falls back to the same placeholder title/author as an empty/whitespace-only value", async () => {
    const conversionId = await storedTempEpub();
    const result = await repackageWithTitle(conversionId, "   ", "");
    expect(result).toEqual({ success: true });

    const zip = await JSZip.loadAsync(fakeStorage.objects.get(conversionId)!);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>Untitled manuscript</dc:title>");
    expect(opf).toContain("<dc:creator>Unknown author</dc:creator>");
  });

  it("rejects a conversionId not owned by the calling user", async () => {
    const result = await repackageWithTitle("someone-else/tmp/epub/x.epub", "Title", "Author");
    expect(result).toEqual({
      success: false,
      error: "Something went wrong converting this document. Please try again.",
    });
  });

  it("fails with a controlled message when the temp EPUB object is missing", async () => {
    const result = await repackageWithTitle(`${USER_ID}/tmp/epub/missing.epub`, "Title", "Author");
    expect(result).toEqual({
      success: false,
      error: "Something went wrong converting this document. Please try again.",
    });
  });
});
