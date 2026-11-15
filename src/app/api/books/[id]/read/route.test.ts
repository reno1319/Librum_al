import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";
import {
  BOOK_FIXTURE_AUTHOR_ID,
  BOOK_FIXTURE_BOOK_ID,
  UNSAFE_MANUSCRIPT_PATHS,
} from "@/lib/book-storage-path-test-fixtures";

// Buyer reader (Renato 11-15, b): the whole book for its buyer. Fake
// Supabase clients record every call, so each test can prove what was
// (and was not) read, recorded or sent.

let recoveryActive = false;
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: (name: string) => (name === RECOVERY_COOKIE_NAME && recoveryActive ? { value: "1" } : undefined) }),
}));
const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));
const mockBuild = vi.fn();
vi.mock("@/lib/epub-reader", () => ({ buildReaderContent: (...a: unknown[]) => mockBuild(...a) }));
const mockReadLibrumPages = vi.fn();
vi.mock("@/lib/librum-download-pages", () => ({ readLibrumPages: (...a: unknown[]) => mockReadLibrumPages(...a) }));
const mockReadDownloadFilePath = vi.fn();
vi.mock("@/lib/book-reviews", () => ({ readDownloadFilePath: (...a: unknown[]) => mockReadDownloadFilePath(...a) }));

import { GET, HEAD } from "./route";

const BOOK = BOOK_FIXTURE_BOOK_ID;
const AUTHOR = BOOK_FIXTURE_AUTHOR_ID;
const READER = "e5f6a7b8-7777-4777-8777-abcdef777777";
const KEY = `${AUTHOR}/${BOOK}.epub`;
const FUTURE = "2999-01-01T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";

type Result = { data: unknown; error: unknown };
const ok = (data: unknown): Result => ({ data, error: null });
const bad: Result = { data: null, error: { code: "XX000" } };

let calls: string[];
let session: {
  user: { id: string; email: string | null } | null;
  publicBook: Result;
  authorRow: Result;
  owns: Result;
  states: Result;
};
let admin: { row: Result; file: Result; record: Result };

function chain(name: string, result: () => Result) {
  const q = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      calls.push(`${name}.eq(${col}=${String(val)})`);
      return q;
    },
    maybeSingle: () => Promise.resolve(result()),
  };
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  recoveryActive = false;
  calls = [];
  session = {
    user: { id: READER, email: "lexues@example.test" },
    publicBook: ok({ id: BOOK, title: "Libri prove", original_author: null, pen: { id: "p1", name: "Emri i autorit" } }),
    authorRow: ok(null),
    owns: ok(true),
    states: ok([{ book_id: BOOK, first_downloaded_at: PAST, cancel_open_until: null }]),
  };
  admin = { row: ok({ id: BOOK, author_id: AUTHOR, file_path: KEY }), file: ok(new Blob(["epub"])), record: ok("rec-1") };
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: () => Promise.resolve({ data: { user: session.user }, error: null }) },
    from: (table: string) => {
      calls.push(`session.from(${table})`);
      return chain(`session.${table}`, () => (table === "public_books" ? session.publicBook : session.authorRow));
    },
    rpc: (fn: string) => {
      calls.push(`session.rpc(${fn})`);
      return Promise.resolve(fn === "user_owns_book" ? session.owns : session.states);
    },
  }));
  mockCreateAdminClient.mockImplementation(() => ({
    from: (table: string) => {
      calls.push(`admin.from(${table})`);
      return chain(`admin.${table}`, () => admin.row);
    },
    storage: {
      from: (bucket: string) => ({
        download: (key: string) => {
          calls.push(`storage.download(${bucket}/${key})`);
          return Promise.resolve(admin.file);
        },
      }),
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push(`admin.rpc(${fn}:${args.p_reader_id}:${args.p_book_id}:${args.p_file_path})`);
      return Promise.resolve(admin.record);
    },
  }));
  mockReadDownloadFilePath.mockResolvedValue({ ok: true, filePath: KEY });
  mockBuild.mockResolvedValue({ available: true, html: "<section class=\"lb-sec\"><p>tekst</p></section>", toc: [], approximatePercent: 10 });
  mockReadLibrumPages.mockResolvedValue({
    front: { buyer: { email: "lexues@example.test", date: "15 nëntor 2026", code: "LB-1", free: false } },
    buyerLineMissing: false,
  });
});

const get = (query = "") =>
  GET(new Request(`https://librum.test/api/books/${BOOK}/read${query}`), { params: Promise.resolve({ id: BOOK }) });
const sentText = () => calls.some((c) => c.startsWith("storage.download"));
const recorded = () => calls.some((c) => c.startsWith("admin.rpc(record_book_download"));

describe("GET /api/books/[id]/read", () => {
  it("only answers GET", () => {
    expect(HEAD().status).toBe(405);
  });

  it("refuses a recovery-restricted session before any read", async () => {
    recoveryActive = true;
    const res = await get();
    expect(res.status).toBe(403);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("needs a signed-in user", async () => {
    session.user = null;
    expect((await get()).status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("a book the caller cannot see is 404, and a read error looks the same", async () => {
    session.publicBook = ok(null);
    expect((await get()).status).toBe(404);
    session.publicBook = { data: { id: BOOK, title: "x" }, error: { code: "XX000" } };
    expect((await get()).status).toBe(404);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("a reader who does not own the book gets nothing (refunds, lost disputes, an RPC error)", async () => {
    for (const owns of [ok(false), bad, ok("true")]) {
      session.owns = owns;
      const res = await get("?accept=1");
      expect(res.status).toBe(403);
    }
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("1a: while the 14 days run, the first open needs ?accept=1 (409, nothing read or recorded)", async () => {
    session.states = ok([{ book_id: BOOK, first_downloaded_at: null, cancel_open_until: FUTURE }]);
    const res = await get();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("confirm_needed");
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("1a: a failed state read asks for the check too (never skips it)", async () => {
    session.states = bad;
    expect((await get()).status).toBe(409);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("1a: confirmed, the open is recorded BEFORE the text is sent, for the file it reads", async () => {
    session.states = ok([{ book_id: BOOK, first_downloaded_at: null, cancel_open_until: FUTURE }]);
    const res = await get("?accept=1");
    expect(res.status).toBe(200);
    expect(calls).toContain(`admin.rpc(record_book_download:${READER}:${BOOK}:${KEY})`);
    expect(calls).not.toContain("session.rpc(my_purchase_download_states)");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.mode).toBe("owned");
    expect(body.author).toBe("Emri i autorit");
    expect(mockBuild.mock.calls[0][1]).toBe("owned");
  });

  it("after the window (or once downloaded) no check is needed, and the open is still recorded", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(recorded()).toBe(true);
  });

  it("2a: the book starts with the buyer line from the download's first page", async () => {
    const body = await (await get()).json();
    expect(body.html.startsWith('<p class="lb-c lb-i">Blerë nga lexues@example.test më 15 nëntor 2026 · Kodi i blerjes: LB-1</p><hr>')).toBe(true);
    expect(body.html).toContain("tekst");
  });

  it("2a: a missing buyer line still opens the book (like the download)", async () => {
    mockReadLibrumPages.mockResolvedValue(null);
    const body = await (await get()).json();
    expect(body.html.startsWith("<section")).toBe(true);
    mockReadLibrumPages.mockRejectedValue(new Error("boom"));
    expect((await get()).status).toBe(200);
  });

  it("audit r1 B2: a book too big for one answer is refused BEFORE the open is recorded", async () => {
    mockBuild.mockResolvedValue({ available: true, html: "x".repeat(4_100_000), toc: [], approximatePercent: 10 });
    const res = await get("?accept=1");
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("too_large");
    expect(recorded()).toBe(false);
  });

  it("an answer just under the limit is sent and recorded", async () => {
    mockBuild.mockResolvedValue({ available: true, html: "x".repeat(3_900_000), toc: [], approximatePercent: 10 });
    const res = await get();
    expect(res.status).toBe(200);
    expect(recorded()).toBe(true);
  });

  it("audit r1 M1: a buyer gets the readers' file choice (isAuthor false), never the author's", async () => {
    await get();
    expect(mockReadDownloadFilePath.mock.calls[0][1]).toEqual({ bookId: BOOK, isAuthor: false, currentFilePath: KEY });
  });

  it("a failed record sends no text", async () => {
    admin.record = bad;
    const res = await get();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.html).toBeUndefined();
  });

  it("the author reads their own book: no check, no record, no buyer line", async () => {
    session.authorRow = ok({ id: BOOK });
    session.states = ok([{ book_id: BOOK, first_downloaded_at: null, cancel_open_until: FUTURE }]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(recorded()).toBe(false);
    expect(calls).not.toContain("session.rpc(user_owns_book)");
    expect(mockReadLibrumPages).not.toHaveBeenCalled();
    expect(mockReadDownloadFilePath.mock.calls[0][1]).toMatchObject({ isAuthor: true });
  });

  it("reads only the file the download would give, at the book's own key", async () => {
    for (const [, unsafe] of UNSAFE_MANUSCRIPT_PATHS) {
      calls = [];
      mockReadDownloadFilePath.mockResolvedValue({ ok: true, filePath: unsafe });
      const res = await get();
      expect(res.status).toBe(404);
      expect(sentText()).toBe(false);
      expect(recorded()).toBe(false);
    }
  });

  it("an unreadable file, a failed file choice or an unusable book is 404 and records nothing", async () => {
    admin.file = bad;
    expect((await get()).status).toBe(404);
    admin.file = ok(new Blob(["epub"]));
    mockBuild.mockResolvedValue({ available: false });
    expect((await get()).status).toBe(404);
    mockReadDownloadFilePath.mockResolvedValue({ ok: false });
    expect((await get()).status).toBe(404);
    admin.row = ok({ id: "other", author_id: AUTHOR, file_path: KEY });
    expect((await get()).status).toBe(404);
    expect(recorded()).toBe(false);
  });
});
