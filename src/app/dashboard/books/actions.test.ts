import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomBytes } from "crypto";
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
// LIBRUM 2.0 PRODUCT-5 CB-1: the manuscripts bucket now also needs
// download() (resolveManuscriptInput() downloading a temp EPUB
// reference) and remove() (cleaning it up after a successful save).
const mockDownloadManuscript = vi.fn();
const mockRemoveManuscript = vi.fn();

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
      from: (bucket: string) => {
        if (bucket === "covers") {
          return { upload: mockUploadCover };
        }
        if (bucket === "manuscripts") {
          return {
            upload: mockUploadManuscript,
            download: mockDownloadManuscript,
            remove: mockRemoveManuscript,
          };
        }
        throw new Error(`unexpected bucket in this focused test: ${bucket}`);
      },
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

// LIBRUM 2.0 PRODUCT-5 CB-1: a real, structurally valid EPUB well over
// Vercel's confirmed ~4.5MB payload limit -- padded with genuinely
// random (incompressible) bytes in an extra part so the file stays
// large even after DEFLATE, same technique already used in
// epub-generator.test.ts's own >4.5MB coverage. Proves
// resolveManuscriptInput()/createBook()/updateBook() never care how
// large the temp EPUB is, since it's a server<->Storage transfer, not
// a browser->Server-Action request body.
async function buildOversizedValidEpubBytes(): Promise<Buffer> {
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
  zip.file("OEBPS/images/big.bin", randomBytes(6 * 1024 * 1024));
  const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  if (bytes.length <= 4.5 * 1024 * 1024) {
    throw new Error("test fixture setup failed to exceed 4.5MB");
  }
  return bytes;
}

// LIBRUM 2.0 PRODUCT-5 COVER-1: a real PNG-signature-valid cover
// padded past a given size -- detectCoverImageKind() only inspects the
// first 8 bytes (a deliberate, pre-existing simplification this
// correction doesn't change), so padding bytes AFTER the real
// signature keeps it genuinely "detected as PNG" while inflating size,
// the same way buildOversizedValidEpubBytes() above inflates a real
// EPUB.
function buildPngBytesOfSize(totalBytes: number): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(totalBytes - PNG_SIGNATURE.length, 1)]);
}

function downloadResult(bytes: Buffer) {
  return {
    data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    error: null,
  };
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

// LIBRUM 2.0 PRODUCT-5 CB-1: the Studio's own ManuscriptField now
// always submits a manuscriptStoragePath reference instead of a
// manuscript File (see its own top-of-file comment) -- this mirrors
// that real submitted shape, with no "manuscript" entry at all.
async function buildFormDataWithManuscriptPath(
  manuscriptStoragePath: string,
  overrides: Record<string, string> = {},
): Promise<FormData> {
  const formData = await buildFormData(overrides);
  formData.delete("manuscript");
  formData.set("manuscriptStoragePath", manuscriptStoragePath);
  return formData;
}

// LIBRUM 2.0 PRODUCT-5 COVER-1: mirrors buildFormDataWithManuscriptPath
// above -- the real shape CoverField now submits, no "cover" entry at
// all.
async function buildFormDataWithCoverPath(
  coverStoragePath: string,
  overrides: Record<string, string> = {},
): Promise<FormData> {
  const formData = await buildFormData(overrides);
  formData.delete("cover");
  formData.set("coverStoragePath", coverStoragePath);
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
  mockDownloadManuscript.mockReset().mockResolvedValue({
    data: null,
    error: { message: "not found" },
  });
  mockRemoveManuscript.mockReset().mockResolvedValue({ error: null });
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

// LIBRUM 2.0 PRODUCT-5 CB-1: the large-manuscript final-save
// correction -- a manuscriptStoragePath reference (small text, from
// EITHER a directly-uploaded EPUB or a DOCX-generated one; actions.ts
// can't tell them apart and doesn't need to) is resolved into real
// bytes server-side via Storage download, never a Server Action
// request body, however large the manuscript actually is.
describe("createBook: manuscriptStoragePath reference (CB-1)", () => {
  beforeEach(resetMocks);

  it("accepts a small EPUB via a temp reference -- the same new path a directly-uploaded EPUB now always takes, regression-tested", async () => {
    const bytes = await buildValidEpubBytes();
    const tempPath = `${USER_ID}/tmp/epub/small.epub`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithManuscriptPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockDownloadManuscript).toHaveBeenCalledWith(tempPath);
    expect(mockUploadManuscript).toHaveBeenCalledOnce();
    const [uploadedPath, uploadedBytes] = mockUploadManuscript.mock.calls[0];
    expect(uploadedPath).toMatch(new RegExp(`^${USER_ID}/.+\\.epub$`));
    expect(Buffer.isBuffer(uploadedBytes) ? uploadedBytes.equals(bytes) : false).toBe(true);
    // Cleaned up only after the full save succeeded.
    expect(mockRemoveManuscript).toHaveBeenCalledWith([tempPath]);
  });

  it("accepts a real EPUB well over Vercel's confirmed ~4.5MB payload limit via a temp reference -- no browser binary round-trip involved", async () => {
    const bytes = await buildOversizedValidEpubBytes();
    const tempPath = `${USER_ID}/tmp/epub/big.epub`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithManuscriptPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockInsert).toHaveBeenCalledOnce();
    const [, uploadedBytes] = mockUploadManuscript.mock.calls[0];
    expect(uploadedBytes.length).toBeGreaterThan(4.5 * 1024 * 1024);
    expect(mockRemoveManuscript).toHaveBeenCalledWith([tempPath]);
  });

  it("treats a DOCX-generated temp EPUB identically -- actions.ts doesn't distinguish the reference's origin, only validates its bytes", async () => {
    // Same >4.5MB fixture standing in for what repackageWithTitle()
    // would have left in Storage -- from this action's own
    // perspective there is no difference at all, which is exactly the
    // point (see docx-actions.ts's own repackageWithTitle()).
    const bytes = await buildOversizedValidEpubBytes();
    const tempPath = `${USER_ID}/tmp/epub/from-docx.epub`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithManuscriptPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("still runs validateEpubStructure() on the downloaded bytes -- an invalid EPUB at a validly-shaped temp path is rejected", async () => {
    const tempPath = `${USER_ID}/tmp/epub/bad.epub`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(Buffer.from("not a zip at all")));

    const formData = await buildFormDataWithManuscriptPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=This+file+doesn%27t+appear+to+be+a+valid+EPUB",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("createBook: create atomicity when the final manuscript write fails (CB-1)", () => {
  beforeEach(resetMocks);

  it("never inserts a book row referencing a manuscript that failed to reach its permanent path", async () => {
    const bytes = await buildValidEpubBytes();
    const tempPath = `${USER_ID}/tmp/epub/x.epub`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));
    mockUploadManuscript.mockResolvedValueOnce({ error: { message: "storage write failed" } });

    const formData = await buildFormDataWithManuscriptPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Could+not+upload+your+manuscript.+Please+try+again",
    );
    expect(mockInsert).not.toHaveBeenCalled();
    // Deliberately NOT cleaned up on failure -- see actions.ts's own
    // comment: preserved so a retry can reuse the same temp object
    // instead of forcing a re-upload/re-conversion from scratch.
    expect(mockRemoveManuscript).not.toHaveBeenCalled();
  });
});

describe("updateBook: manuscriptStoragePath reference (CB-1)", () => {
  beforeEach(resetMocks);

  it("replaces the manuscript via a temp reference and cleans it up only after the update succeeds", async () => {
    const bytes = await buildValidEpubBytes();
    const tempPath = `${USER_ID}/tmp/epub/replacement.epub`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithManuscriptPath(tempPath);
    formData.delete("cover");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Book+updated");
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ file_path: `${USER_ID}/${BOOK_ID}.epub` });
    expect(mockRemoveManuscript).toHaveBeenCalledWith([tempPath]);
  });

  it("accepts a real EPUB well over 4.5MB via a temp reference", async () => {
    const bytes = await buildOversizedValidEpubBytes();
    const tempPath = `${USER_ID}/tmp/epub/big-replacement.epub`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithManuscriptPath(tempPath);
    formData.delete("cover");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Book+updated");
    const [, uploadedBytes] = mockUploadManuscript.mock.calls[0];
    expect(uploadedBytes.length).toBeGreaterThan(4.5 * 1024 * 1024);
  });

  it("leaves the existing manuscript completely untouched when no replacement is submitted", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    // No manuscriptStoragePath either -- the ordinary "just edit text
    // fields" case.

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUploadManuscript).not.toHaveBeenCalled();
    expect(mockRemoveManuscript).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      file_path: "author-1/book-1.epub",
    });
  });
});

describe("updateBook: update atomicity when the final manuscript write fails (CB-1)", () => {
  beforeEach(resetMocks);

  it("leaves the old manuscript authoritative -- no broken replacement -- when the final storage write fails", async () => {
    const bytes = await buildValidEpubBytes();
    const tempPath = `${USER_ID}/tmp/epub/x.epub`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));
    mockUploadManuscript.mockResolvedValueOnce({ error: { message: "storage write failed" } });

    const formData = await buildFormDataWithManuscriptPath(tempPath);
    formData.delete("cover");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/dashboard/books/${BOOK_ID}/edit?error=Could+not+upload+your+manuscript.+Please+try+again`,
    );
    // The DB row is never touched -- existing.file_path (the old,
    // still-valid manuscript) remains authoritative.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRemoveManuscript).not.toHaveBeenCalled();
  });
});

describe("resolveManuscriptInput: temp-path authorization (CB-1)", () => {
  beforeEach(resetMocks);

  it("rejects a temp path owned by a different user, without ever calling download", async () => {
    const formData = await buildFormDataWithManuscriptPath("someone-else/tmp/epub/x.epub");
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+manuscript+reference+is+no+longer+valid.+Please+choose+your+file+again",
    );
    expect(mockDownloadManuscript).not.toHaveBeenCalled();
  });

  it("rejects a path outside the tmp/epub namespace (e.g. a permanent manuscript path)", async () => {
    const formData = await buildFormDataWithManuscriptPath(`${USER_ID}/${BOOK_ID}.epub`);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+manuscript+reference+is+no+longer+valid.+Please+choose+your+file+again",
    );
    expect(mockDownloadManuscript).not.toHaveBeenCalled();
  });

  it("rejects a path in the wrong temp namespace (e.g. the DOCX-source namespace, not the generated-EPUB one)", async () => {
    const formData = await buildFormDataWithManuscriptPath(`${USER_ID}/tmp/docx/x.epub`);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+manuscript+reference+is+no+longer+valid.+Please+choose+your+file+again",
    );
  });

  it("rejects a path with the wrong extension inside an otherwise-valid namespace", async () => {
    const formData = await buildFormDataWithManuscriptPath(`${USER_ID}/tmp/epub/x.docx`);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+manuscript+reference+is+no+longer+valid.+Please+choose+your+file+again",
    );
  });

  it("fails with a controlled message when the referenced temp object is missing", async () => {
    const formData = await buildFormDataWithManuscriptPath(`${USER_ID}/tmp/epub/gone.epub`);
    // resetMocks already defaults mockDownloadManuscript to "not found".

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Could+not+read+your+uploaded+manuscript.+Please+try+again",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before ever touching the manuscript reference", async () => {
    mockGetUser.mockReset().mockResolvedValue({ data: { user: null } });
    const formData = await buildFormDataWithManuscriptPath(`${USER_ID}/tmp/epub/x.epub`);

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/login");
    expect(mockDownloadManuscript).not.toHaveBeenCalled();
  });
});

// LIBRUM 2.0 PRODUCT-5 COVER-1: the final 413 correction -- a cover
// between ~4.5MB and the app's own advertised 5MB limit could 413
// through the old File-in-FormData path (Vercel's own request-body
// ceiling sits below the app's cover limit). A coverStoragePath
// reference (small text, staged in the PRIVATE "manuscripts" bucket --
// see resolveCoverInput's own comment for why NOT the public "covers"
// bucket) is resolved into real, re-validated bytes server-side,
// however large the cover actually is.
describe("createBook: coverStoragePath reference (COVER-1)", () => {
  beforeEach(resetMocks);

  it("accepts a small cover via a temp reference -- the same new path a directly-uploaded cover now always takes, regression-tested", async () => {
    const bytes = buildPngBytesOfSize(1024);
    const tempPath = `${USER_ID}/tmp/cover/small.png`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithCoverPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockDownloadManuscript).toHaveBeenCalledWith(tempPath);
    expect(mockUploadCover).toHaveBeenCalledOnce();
    const [uploadedPath, uploadedBytes, uploadOpts] = mockUploadCover.mock.calls[0];
    expect(uploadedPath).toMatch(new RegExp(`^${USER_ID}/.+-cover\\.png$`));
    expect(Buffer.isBuffer(uploadedBytes) ? uploadedBytes.equals(bytes) : false).toBe(true);
    expect(uploadOpts).toMatchObject({ contentType: "image/png" });
    // Cleaned up only after the full save succeeded -- from the SAME
    // private "manuscripts" bucket the temp object was staged in.
    expect(mockRemoveManuscript).toHaveBeenCalledWith([tempPath]);
  });

  it("accepts a real cover between ~4.5MB and the app's own 5MB limit via a temp reference -- the exact confirmed architectural gap", async () => {
    const bytes = buildPngBytesOfSize(4.8 * 1024 * 1024);
    expect(bytes.length).toBeGreaterThan(4.5 * 1024 * 1024);
    expect(bytes.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    const tempPath = `${USER_ID}/tmp/cover/big.png`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithCoverPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockInsert).toHaveBeenCalledOnce();
    const [, uploadedBytes] = mockUploadCover.mock.calls[0];
    expect(uploadedBytes.length).toBeGreaterThan(4.5 * 1024 * 1024);
    expect(mockRemoveManuscript).toHaveBeenCalledWith([tempPath]);
  });

  it("rejects a cover over the 5MB limit even via a temp reference -- never trusts client-side File.size alone", async () => {
    const bytes = buildPngBytesOfSize(5.1 * 1024 * 1024);
    const tempPath = `${USER_ID}/tmp/cover/toobig.png`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithCoverPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/books/new?error=Cover+image+must+be+under+5MB");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUploadCover).not.toHaveBeenCalled();
  });

  it("still runs the authoritative byte-signature check -- an invalid image at a validly-shaped temp path is rejected", async () => {
    const tempPath = `${USER_ID}/tmp/cover/bad.png`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(Buffer.from("not an image at all")));

    const formData = await buildFormDataWithCoverPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+doesn%27t+look+like+a+valid+JPEG+or+PNG+image",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("createBook: create atomicity when the final cover write fails (COVER-1)", () => {
  beforeEach(resetMocks);

  it("never inserts a book row referencing a cover that failed to reach its permanent path", async () => {
    const bytes = buildPngBytesOfSize(1024);
    const tempPath = `${USER_ID}/tmp/cover/x.png`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));
    mockUploadCover.mockResolvedValueOnce({ error: { message: "storage write failed" } });

    const formData = await buildFormDataWithCoverPath(tempPath);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Could+not+upload+your+cover+image.+Please+try+again",
    );
    expect(mockInsert).not.toHaveBeenCalled();
    // Deliberately NOT cleaned up on failure -- same retry-friendly
    // reasoning as the manuscript temp cleanup (see actions.ts).
    expect(mockRemoveManuscript).not.toHaveBeenCalled();
  });
});

describe("updateBook: coverStoragePath reference (COVER-1)", () => {
  beforeEach(resetMocks);

  it("replaces the cover via a temp reference and cleans it up only after the update succeeds", async () => {
    const bytes = buildPngBytesOfSize(1024);
    const tempPath = `${USER_ID}/tmp/cover/replacement.png`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));

    const formData = await buildFormDataWithCoverPath(tempPath);
    formData.delete("manuscript");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Book+updated");
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ cover_path: `${USER_ID}/${BOOK_ID}-cover.png` });
    expect(mockRemoveManuscript).toHaveBeenCalledWith([tempPath]);
  });

  it("leaves the existing cover completely untouched when no replacement is submitted", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUploadCover).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      cover_path: "author-1/book-1-cover.png",
    });
  });
});

describe("updateBook: update atomicity when the final cover write fails (COVER-1)", () => {
  beforeEach(resetMocks);

  it("leaves the old cover authoritative -- no broken replacement -- when the final storage write fails", async () => {
    const bytes = buildPngBytesOfSize(1024);
    const tempPath = `${USER_ID}/tmp/cover/x.png`;
    mockDownloadManuscript.mockResolvedValueOnce(downloadResult(bytes));
    mockUploadCover.mockResolvedValueOnce({ error: { message: "storage write failed" } });

    const formData = await buildFormDataWithCoverPath(tempPath);
    formData.delete("manuscript");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/dashboard/books/${BOOK_ID}/edit?error=Could+not+upload+your+cover+image.+Please+try+again`,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRemoveManuscript).not.toHaveBeenCalled();
  });
});

describe("resolveCoverInput: temp-path authorization (COVER-1)", () => {
  beforeEach(resetMocks);

  it("rejects a temp path owned by a different user, without ever calling download", async () => {
    const formData = await buildFormDataWithCoverPath("someone-else/tmp/cover/x.png");
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+cover+reference+is+no+longer+valid.+Please+choose+your+file+again",
    );
    expect(mockDownloadManuscript).not.toHaveBeenCalled();
  });

  it("rejects a path outside the tmp/cover namespace (e.g. a permanent cover path)", async () => {
    const formData = await buildFormDataWithCoverPath(`${USER_ID}/${BOOK_ID}-cover.png`);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+cover+reference+is+no+longer+valid.+Please+choose+your+file+again",
    );
  });

  it("rejects a path in the wrong temp namespace (e.g. the manuscript's own tmp/epub namespace)", async () => {
    const formData = await buildFormDataWithCoverPath(`${USER_ID}/tmp/epub/x.png`);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+cover+reference+is+no+longer+valid.+Please+choose+your+file+again",
    );
  });

  it("rejects a path with an unsupported extension inside an otherwise-valid namespace (a spoofed non-image extension)", async () => {
    const formData = await buildFormDataWithCoverPath(`${USER_ID}/tmp/cover/x.svg`);
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=That+cover+reference+is+no+longer+valid.+Please+choose+your+file+again",
    );
  });

  it("fails with a controlled message when the referenced temp object is missing", async () => {
    const formData = await buildFormDataWithCoverPath(`${USER_ID}/tmp/cover/gone.png`);
    // resetMocks already defaults mockDownloadManuscript to "not found".

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Could+not+read+your+uploaded+cover.+Please+try+again",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
