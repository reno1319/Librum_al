import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomBytes } from "crypto";
import JSZip from "jszip";
import { buildDocxBytes, heading, note, noteRef, paragraph, textWithNotes } from "@/lib/docx-test-fixtures";

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
    expect(opf).toContain("<dc:title>Dorëshkrim pa titull</dc:title>");
    expect(opf).toContain("<dc:creator>Autor i panjohur</dc:creator>");
  });

  it("rejects a temp path not owned by the calling user, without touching storage", async () => {
    const foreignPath = "someone-else/tmp/docx/abc.docx";
    fakeStorage.objects.set(foreignPath, await realDocxBytes());

    const result = await parseDocxToDocument(foreignPath);
    expect(result).toEqual({
      success: false,
      error: "Diçka shkoi keq gjatë kthimit të këtij dokumenti. Provoni përsëri.",
    });
    expect(fakeStorage.objects.has(foreignPath)).toBe(true);
  });

  it("fails with a controlled message when there's no authenticated user", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const result = await parseDocxToDocument(`${USER_ID}/tmp/docx/abc.docx`);
    expect(result).toEqual({
      success: false,
      error: "Seanca juaj ka skaduar. Rifreskoni faqen dhe provoni përsëri.",
    });
  });

  it("fails with a controlled message when the temp DOCX object is missing from storage", async () => {
    const result = await parseDocxToDocument(`${USER_ID}/tmp/docx/does-not-exist.docx`);
    expect(result).toEqual({
      success: false,
      error: "Diçka shkoi keq gjatë kthimit të këtij dokumenti. Provoni përsëri.",
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
    expect(opf).toContain("<dc:title>Dorëshkrim pa titull</dc:title>");
    expect(opf).toContain("<dc:creator>Autor i panjohur</dc:creator>");
  });

  it("rejects a conversionId not owned by the calling user", async () => {
    const result = await repackageWithTitle("someone-else/tmp/epub/x.epub", "Title", "Author");
    expect(result).toEqual({
      success: false,
      error: "Diçka shkoi keq gjatë kthimit të këtij dokumenti. Provoni përsëri.",
    });
  });

  it("fails with a controlled message when the temp EPUB object is missing", async () => {
    const result = await repackageWithTitle(`${USER_ID}/tmp/epub/missing.epub`, "Title", "Author");
    expect(result).toEqual({
      success: false,
      error: "Diçka shkoi keq gjatë kthimit të këtij dokumenti. Provoni përsëri.",
    });
  });

  // LIBRUM 2.0 PUBLISHING-UX-1 PART C: the new, optional fourth
  // `language` parameter -- passed straight through to
  // patchEpubMetadata()'s own optional fourth parameter (see
  // epub-generator.test.ts for that function's own direct contract
  // tests). These cover the pass-through itself: a real code reaches
  // the stored temp EPUB's dc:language, and omitting the argument
  // (the shape every call above already uses) leaves dc:language at
  // "sq" (SQ-17; was "und") -- parseDocxToDocument()'s own packaging, which
  // this function's own top-of-file comment says is deliberately never
  // supplied a language either.
  it.each(["sq", "en", "it"])("threads language '%s' into the repackaged temp EPUB's dc:language", async (code) => {
    const conversionId = await storedTempEpub();
    const result = await repackageWithTitle(conversionId, "The Maltese Falcon", "Dashiell Hammett", code);
    expect(result).toEqual({ success: true });

    const zip = await JSZip.loadAsync(fakeStorage.objects.get(conversionId)!);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain(`<dc:language>${code}</dc:language>`);
  });

  it("leaves dc:language at 'sq' when the language argument is omitted (SQ-17: Edit Book sends none)", async () => {
    const conversionId = await storedTempEpub();
    const result = await repackageWithTitle(conversionId, "The Maltese Falcon", "Dashiell Hammett");
    expect(result).toEqual({ success: true });

    const zip = await JSZip.loadAsync(fakeStorage.objects.get(conversionId)!);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:language>sq</dc:language>");
  });
});

describe("parseDocxToDocument: author preview (W4)", () => {
  async function docxWithBreaks(): Promise<Buffer> {
    const long = (seed: string) =>
      paragraph(`${seed} ishte një ditë e zakonshme në qytet, me njerëz që shkonin në punë dhe fëmijë që vraponin drejt shkollës.`);
    return buildDocxBytes({
      includeStyles: true,
      bodyXml: heading(1, "Liqeni") + long("Dita") + long("Nata") + paragraph("") + long("Era") + long("Shiu") + long("Bora"),
    });
  }

  it("stores a marked preview copy next to the ebook and returns the build's report", async () => {
    const tempDocxPath = `${USER_ID}/tmp/docx/w4.docx`;
    fakeStorage.objects.set(tempDocxPath, await docxWithBreaks());
    const result = await parseDocxToDocument(tempDocxPath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.previewPath).toMatch(new RegExp(`^${USER_ID}/tmp/preview/[0-9a-f-]+\\.epub$`));
    expect(result.previewPath.split("/").pop()).toBe(result.conversionId.split("/").pop());
    expect(result.chapters).toEqual([{ heading: "Liqeni", headingPara: 0 }]);
    expect(result.cleanup.applied).toBe(true);
    const suggestion = result.cleanup.guesses.find((g) => g.kind === "scene_break");
    expect(suggestion).toMatchObject({ paragraph: 4, applied: false });

    const ebook = await JSZip.loadAsync(fakeStorage.objects.get(result.conversionId)!);
    const preview = await JSZip.loadAsync(fakeStorage.objects.get(result.previewPath)!);
    const ebookPage = await ebook.file("OEBPS/chapter-1.xhtml")!.async("string");
    const previewPage = await preview.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(ebookPage).not.toMatch(/data-p|data-s|lbp_/);
    expect(previewPage).toContain('<span data-p="1"></span>');
    expect(previewPage.replace(/<span data-[ps]="\d+"><\/span>/g, "")).toBe(ebookPage);
  });

  it("keeps Word notes in both copies: a title's note link and the 'Shënime' chapter (W3 Part 2)", async () => {
    const tempDocxPath = `${USER_ID}/tmp/docx/notes.docx`;
    fakeStorage.objects.set(
      tempDocxPath,
      await buildDocxBytes({
        includeStyles: true,
        bodyXml:
          `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Liqeni</w:t></w:r>${noteRef("footnote", 2)}</w:p>` +
          textWithNotes("Dita ishte e qetë", noteRef("endnote", 3), "."),
        footnotesXml: note("footnote", 2, paragraph("Shënim te titulli.")),
        endnotesXml: note("endnote", 3, paragraph("Shënim në fund.")),
      }),
    );
    const result = await parseDocxToDocument(tempDocxPath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.chapters).toEqual([{ heading: "Liqeni", headingPara: 0 }, { heading: "Shënime", headingPara: null }]);
    expect(result.cleanup.notes).toEqual({ footnotes: 1, endnotes: 1, dropped: 0 });
    for (const path of [result.conversionId, result.previewPath]) {
      const zip = await JSZip.loadAsync(fakeStorage.objects.get(path)!);
      const page = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
      expect(page).toContain('<h1>Liqeni<sup><a epub:type="noteref" href="#fn-1" id="fnref-1">1</a></sup></h1>');
      expect(await zip.file("OEBPS/chapter-2.xhtml")!.async("string")).toContain("Shënim në fund.");
    }
  });

  it("rebuilds with the author's choices (one empty line accepted as a scene break)", async () => {
    const tempDocxPath = `${USER_ID}/tmp/docx/w4b.docx`;
    fakeStorage.objects.set(tempDocxPath, await docxWithBreaks());
    const result = await parseDocxToDocument(tempDocxPath, { sceneBreak: [4] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.cleanup.guesses.find((g) => g.kind === "scene_break")).toMatchObject({ paragraph: 4, applied: true });
    const ebook = await JSZip.loadAsync(fakeStorage.objects.get(result.conversionId)!);
    expect(await ebook.file("OEBPS/chapter-1.xhtml")!.async("string")).toContain('<p class="scene-break">* * *</p>');
  });

  it("refuses choices that aren't lists of paragraph numbers, and still deletes the Word file", async () => {
    for (const bad of [{ makeChapter: ["1"] }, { makeChapter: [-1] }, { unknown: [] }, { fixQuotes: "no" }, [1, 2], "x"]) {
      const tempDocxPath = `${USER_ID}/tmp/docx/bad.docx`;
      fakeStorage.objects.set(tempDocxPath, await realDocxBytes());
      const result = await parseDocxToDocument(tempDocxPath, bad);
      expect(result.success).toBe(false);
      expect(fakeStorage.objects.has(tempDocxPath)).toBe(false);
      expect([...fakeStorage.objects.keys()]).toEqual([]);
    }
  });
});
