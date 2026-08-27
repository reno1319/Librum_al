import { describe, expect, it, vi, beforeEach } from "vitest";
import JSZip from "jszip";

// LIBRUM 2.0 PRODUCT-1 PRE-COMMIT LEGACY PREVIEW RETIREMENT: this file
// exists to pin ONE specific regression risk -- that removing the
// Studio's preview_text textarea (Read Sample replaced its old public
// purpose entirely) can never silently wipe an existing book's legacy
// preview_text value merely because the form no longer submits that
// field. createBook()/updateBook() otherwise have no test coverage of
// their own here; this is deliberately narrow, not a general audit of
// either function.
//
// Real cover/manuscript bytes are used (a real PNG signature, a real
// minimal-but-valid EPUB built with JSZip -- same "write with JSZip,
// read with the real validator" discipline as epub-validation.test.ts)
// rather than mocking detectCoverImageKind/validateEpubStructure: both
// are cheap, pure, already-real functions, so there's no reason to fake
// them when satisfying them for real is this simple.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockGetUser = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockExistingSingle = vi.fn();
const mockUploadCover = vi.fn();
const mockUploadManuscript = vi.fn();

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table !== "books") {
        throw new Error(`unexpected table in this focused test: ${table}`);
      }
      return {
        insert: (payload: unknown) => {
          mockInsert(payload);
          return Promise.resolve({ error: null });
        },
        select: () => ({
          eq: () => ({
            single: () => mockExistingSingle(),
          }),
        }),
        update: (payload: unknown) => {
          mockUpdate(payload);
          return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
        },
      };
    },
    storage: {
      from: (bucket: string) => ({
        upload: bucket === "covers" ? mockUploadCover : mockUploadManuscript,
      }),
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { createBook, updateBook } = await import("./actions");

const USER_ID = "author-1";
const BOOK_ID = "book-1";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

async function buildValidEpubBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest></manifest><spine></spine></package>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function buildFormData(overrides: Record<string, string> = {}): Promise<FormData> {
  const epubBytes = await buildValidEpubBytes();
  const formData = new FormData();
  formData.set("title", overrides.title ?? "My Book");
  formData.set("description", overrides.description ?? "A description.");
  formData.set("keywords", "");
  formData.set("isbn", "");
  formData.set("genre", "Fiction");
  formData.set("price", "0");
  formData.set(
    "cover",
    new File([new Uint8Array(PNG_SIGNATURE)], "cover.png", { type: "image/png" }),
  );
  formData.set(
    "manuscript",
    new File([new Uint8Array(epubBytes)], "book.epub", { type: "application/epub+zip" }),
  );
  // Deliberately no "previewText" entry anywhere -- the Studio no
  // longer submits this field at all, which is exactly the scenario
  // this file exists to verify is handled correctly.
  return formData;
}

function resetMocks() {
  mockRedirect.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockInsert.mockClear();
  mockUpdate.mockClear();
  mockExistingSingle.mockReset().mockResolvedValue({
    data: {
      cover_path: "author-1/book-1-cover.png",
      file_path: "author-1/book-1.epub",
      author_id: USER_ID,
    },
  });
  mockUploadCover.mockReset().mockResolvedValue({ error: null });
  mockUploadManuscript.mockReset().mockResolvedValue({ error: null });
}

describe("createBook: preview_text is no longer collected", () => {
  beforeEach(resetMocks);

  it("succeeds with no previewText field in FormData at all", async () => {
    const formData = await buildFormData();

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("the insert payload does not include a preview_text key at all -- the column's own DB default applies", async () => {
    const formData = await buildFormData();

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockInsert.mock.calls[0][0];
    expect(payload).not.toHaveProperty("preview_text");
    // Sanity: this is still a real, correctly-shaped insert, not an
    // accidentally-empty payload.
    expect(payload).toMatchObject({ title: "My Book", author_id: USER_ID, status: "draft" });
  });
});

describe("updateBook: editing never erases a legacy preview_text value", () => {
  beforeEach(resetMocks);

  it("succeeds with no previewText field in FormData at all", async () => {
    const formData = await buildFormData();
    // No file replacement this time -- the common "just edit the text
    // fields" path.
    formData.delete("cover");
    formData.delete("manuscript");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it("the update payload does not include a preview_text key at all -- an existing legacy value is never touched, let alone overwritten with an empty string", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockUpdate.mock.calls[0][0];
    expect(payload).not.toHaveProperty("preview_text");
    expect(payload).toMatchObject({ title: "My Book" });
  });
});
