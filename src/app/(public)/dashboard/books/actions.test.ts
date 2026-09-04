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

// LIBRUM 2.0 PUBLISHING-UX-1 PART B: subtitle/language/publisher/
// edition/original_publication_date -- the five new author-editable
// bibliographic fields. buildFormData() never sets any of these, so
// every existing test above already covers "absent -> null" for the
// preview_text scenarios it exists for; these describe blocks are the
// dedicated coverage for the new fields themselves.
describe("createBook: bibliographic metadata (PUBLISHING-UX-1 Part B)", () => {
  beforeEach(resetMocks);

  it("persists subtitle/language/publisher/edition/original_publication_date when supplied", async () => {
    const formData = await buildFormData();
    formData.set("subtitle", "A Subtitle");
    formData.set("language", "sq");
    formData.set("publisher", "Some Press");
    formData.set("edition", "First edition");
    formData.set("originalPublicationDate", "2020-01-01");

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockInsert.mock.calls[0][0]).toMatchObject({
      subtitle: "A Subtitle",
      language: "sq",
      publisher: "Some Press",
      edition: "First edition",
      original_publication_date: "2020-01-01",
    });
  });

  it("stores null for every new field when absent -- the current (pre-Part-C) wizard's own FormData shape", async () => {
    const formData = await buildFormData();

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockInsert.mock.calls[0][0]).toMatchObject({
      subtitle: null,
      language: null,
      publisher: null,
      edition: null,
      original_publication_date: null,
    });
  });

  it("trims whitespace and treats an empty/whitespace-only value as null", async () => {
    const formData = await buildFormData();
    formData.set("subtitle", "   ");
    formData.set("publisher", "  ");
    formData.set("edition", "");

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockInsert.mock.calls[0][0]).toMatchObject({
      subtitle: null,
      publisher: null,
      edition: null,
    });
  });

  it("rejects a subtitle over 300 characters", async () => {
    const formData = await buildFormData();
    formData.set("subtitle", "x".repeat(301));

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Subtitle+must+be+300+characters+or+fewer",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts a subtitle at exactly the 300 character limit", async () => {
    const formData = await buildFormData();
    formData.set("subtitle", "x".repeat(300));

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsert.mock.calls[0][0]).toMatchObject({ subtitle: "x".repeat(300) });
  });

  it("rejects a publisher over 200 characters", async () => {
    const formData = await buildFormData();
    formData.set("publisher", "x".repeat(201));

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Publisher+must+be+200+characters+or+fewer",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts a publisher at exactly the 200 character limit", async () => {
    const formData = await buildFormData();
    formData.set("publisher", "x".repeat(200));

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockInsert.mock.calls[0][0]).toMatchObject({ publisher: "x".repeat(200) });
  });

  it("rejects an edition over 100 characters", async () => {
    const formData = await buildFormData();
    formData.set("edition", "x".repeat(101));

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Edition+must+be+100+characters+or+fewer",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts an edition at exactly the 100 character limit", async () => {
    const formData = await buildFormData();
    formData.set("edition", "x".repeat(100));

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockInsert.mock.calls[0][0]).toMatchObject({ edition: "x".repeat(100) });
  });

  it("accepts every currently supported language code", async () => {
    for (const code of ["sq", "en", "it"]) {
      resetMocks();
      const formData = await buildFormData();
      formData.set("language", code);

      await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

      expect(mockInsert.mock.calls[0][0]).toMatchObject({ language: code });
    }
  });

  it("rejects an unsupported language code, distinctly from a missing one", async () => {
    const formData = await buildFormData();
    formData.set("language", "fr");

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Please+choose+a+supported+language",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts a valid original publication date", async () => {
    const formData = await buildFormData();
    formData.set("originalPublicationDate", "1999-12-31");

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockInsert.mock.calls[0][0]).toMatchObject({
      original_publication_date: "1999-12-31",
    });
  });

  it("rejects a malformed original publication date", async () => {
    const formData = await buildFormData();
    formData.set("originalPublicationDate", "not-a-date");

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Enter+a+valid+original+publication+date",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid calendar date shaped like a real date (e.g. February 30th)", async () => {
    const formData = await buildFormData();
    formData.set("originalPublicationDate", "2024-02-30");

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Enter+a+valid+original+publication+date",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects a future original publication date", async () => {
    const formData = await buildFormData();
    const oneYearFromNow = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    formData.set("originalPublicationDate", oneYearFromNow.toISOString().slice(0, 10));

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/books/new?error=Original+publication+date+can%27t+be+in+the+future",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("never accepts published_at from FormData -- no such form field is ever read by createBook()", async () => {
    const formData = await buildFormData();
    formData.set("published_at", "2020-01-01T00:00:00.000Z");
    formData.set("publishedAt", "2020-01-01T00:00:00.000Z");

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockInsert.mock.calls[0][0]).not.toHaveProperty("published_at");
  });
});

describe("updateBook: bibliographic metadata (PUBLISHING-UX-1 Part B FINAL PRE-COMMIT ROLLOUT-COMPATIBILITY CORRECTION)", () => {
  beforeEach(resetMocks);

  it("persists supplied metadata on update", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    formData.set("subtitle", "Updated Subtitle");
    formData.set("language", "en");
    formData.set("publisher", "New Press");
    formData.set("edition", "Second edition");
    formData.set("originalPublicationDate", "2010-06-15");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      subtitle: "Updated Subtitle",
      language: "en",
      publisher: "New Press",
      edition: "Second edition",
      original_publication_date: "2010-06-15",
    });
  });

  // Test A: all five new fields absent entirely from FormData (the
  // exact shape of the still-old, pre-Part-D Edit form) -- none of the
  // five keys may appear in the update payload at all, so a Supabase
  // `.update()` (which only ever touches keys actually present in the
  // object it's given) can never overwrite an existing value for any
  // of them.
  it("none of the five new metadata keys appear in the update payload when all five are absent from FormData", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    // subtitle/language/publisher/edition/originalPublicationDate are
    // never set on this FormData at all -- buildFormData() doesn't add
    // them, and nothing here does either.

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockUpdate.mock.calls[0][0];
    expect(payload).not.toHaveProperty("subtitle");
    expect(payload).not.toHaveProperty("language");
    expect(payload).not.toHaveProperty("publisher");
    expect(payload).not.toHaveProperty("edition");
    expect(payload).not.toHaveProperty("original_publication_date");
  });

  // Test B: this is the staged-rollout scenario the correction exists
  // for, spelled out explicitly (PUBLISHING-UX-1 Part B brief section
  // 1): a book conceptually already has bibliographic metadata (set by
  // some earlier save this test doesn't need to simulate directly,
  // since payload behavior alone proves the guarantee) -- the
  // still-old Edit form submits none of the five new fields, and edits
  // only an ordinary legacy field (title). The update payload must
  // touch title but must not include ANY of the five new keys -- so
  // updateBook() can never erase them, regardless of what value they
  // actually hold in the database.
  it("staged rollout: an old Edit form editing only a legacy field never touches any new metadata column", async () => {
    const formData = await buildFormData({ title: "A Retitled Book" });
    formData.delete("cover");
    formData.delete("manuscript");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockUpdate.mock.calls[0][0];
    expect(payload).toMatchObject({ title: "A Retitled Book" });
    expect(payload).not.toHaveProperty("subtitle");
    expect(payload).not.toHaveProperty("language");
    expect(payload).not.toHaveProperty("publisher");
    expect(payload).not.toHaveProperty("edition");
    expect(payload).not.toHaveProperty("original_publication_date");
  });

  // Test B (partial-absence variant): only ONE field absent, the rest
  // supplied -- proves the presence check is genuinely per-field, not
  // an all-or-nothing shortcut.
  it("one field absent while the others are supplied: only the absent one is left out of the payload", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    formData.set("subtitle", "Present Subtitle");
    formData.set("publisher", "Present Press");
    formData.set("edition", "Present Edition");
    formData.set("originalPublicationDate", "2015-05-05");
    // language deliberately left unset -- the one absent field.

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockUpdate.mock.calls[0][0];
    expect(payload).not.toHaveProperty("language");
    expect(payload).toMatchObject({
      subtitle: "Present Subtitle",
      publisher: "Present Press",
      edition: "Present Edition",
      original_publication_date: "2015-05-05",
    });
  });

  // Test C: present as an empty string is an INTENTIONAL clear, and
  // must be distinguished from absence above -- the whole point of the
  // correction is that these two are no longer conflated.
  it("clears an optional field back to null when the field is submitted as an empty string (an intentional clear, distinct from absence)", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    // Each field explicitly SET to an empty string -- formData.has()
    // is true for all five, unlike the "absent" tests above.
    formData.set("subtitle", "");
    formData.set("language", "");
    formData.set("publisher", "");
    formData.set("edition", "");
    formData.set("originalPublicationDate", "");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      subtitle: null,
      language: null,
      publisher: null,
      edition: null,
      original_publication_date: null,
    });
  });

  // Tests E/F/G: language specifically -- absent (no update), present
  // empty (cleared to null), present valid (updated).
  it("language: absent from FormData -- no language key in the payload", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate.mock.calls[0][0]).not.toHaveProperty("language");
  });

  it("language: present but empty -- cleared to null", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    formData.set("language", "");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ language: null });
  });

  it("language: present and valid -- updated to the submitted code", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    formData.set("language", "it");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ language: "it" });
  });

  // Tests H/I: original_publication_date -- absent (no update),
  // present empty (cleared to null). "present valid" is already
  // covered by "persists supplied metadata on update" above.
  it("original_publication_date: absent from FormData -- no date key in the payload", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate.mock.calls[0][0]).not.toHaveProperty("original_publication_date");
  });

  it("original_publication_date: present but empty -- cleared to null", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    formData.set("originalPublicationDate", "");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ original_publication_date: null });
  });

  it("rejects an over-limit subtitle on update, the same as on create", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    formData.set("subtitle", "x".repeat(301));

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/dashboard/books/${BOOK_ID}/edit?error=Subtitle+must+be+300+characters+or+fewer`,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects an unsupported language code on update", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    formData.set("language", "de");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/dashboard/books/${BOOK_ID}/edit?error=Please+choose+a+supported+language`,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a future original publication date on update", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    const oneYearFromNow = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    formData.set("originalPublicationDate", oneYearFromNow.toISOString().slice(0, 10));

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/dashboard/books/${BOOK_ID}/edit?error=Original+publication+date+can%27t+be+in+the+future`,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("never accepts published_at from FormData -- no such form field is ever read by updateBook(), regardless of what's submitted", async () => {
    const formData = await buildFormData();
    formData.delete("cover");
    formData.delete("manuscript");
    formData.set("published_at", "2020-01-01T00:00:00.000Z");
    formData.set("publishedAt", "2099-01-01T00:00:00.000Z");

    await expect(updateBook(BOOK_ID, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdate.mock.calls[0][0]).not.toHaveProperty("published_at");
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
