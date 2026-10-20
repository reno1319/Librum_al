import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { STAGING_SUPABASE_URL } from "@/lib/protected-staging";
import { CATALOG_ROW_CHANGED_MESSAGE } from "@/lib/paid-repricing";

// F4: the Add a book / Edit server side of the pen name, the Translator
// field, the rights choice and the publish gate (actions.ts), against a
// recording double. Every query records which client ran it (the
// author's session or the trusted catalog writer), its table and its
// builder calls; `respond` decides each result. The rights helpers
// (src/lib/book-rights.ts, tested on their own) are mocked, so these
// tests see exactly which basis each action hands them.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
// ADMIN-3-REVIEW: book_reviews reads/writes replaced by a settable
// double (default: nothing pending, approval valid); see
// src/lib/book-reviews-test-double.ts.
vi.mock("@/lib/book-reviews", async (importOriginal) => {
  const { bookReviewsDouble } = await import("@/lib/book-reviews-test-double");
  return bookReviewsDouble(await importOriginal<object>());
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ __admin: true }) }));
vi.mock("@/lib/email", () => ({ sendNewBookEmails: vi.fn(async () => undefined) }));

type RightsState =
  | { kind: "present"; declaration: { basis: "own_rights" | "public_domain" } }
  | { kind: "none" }
  | { kind: "unavailable" };
const mockRightsState = vi.fn<(bookId: string) => Promise<RightsState>>();
const mockRecordRights = vi.fn<(bookId: string, basis: unknown) => Promise<{ ok: boolean; reason?: string }>>();
vi.mock("@/lib/book-rights", () => ({
  getRightsDeclarationState: (bookId: string) => mockRightsState(bookId),
  recordRightsDeclaration: (bookId: string, basis: unknown) => mockRecordRights(bookId, basis),
}));

// D1: the probes decide rendering only. They say "off" here, and no
// action may consult them (P1: a submitted pen name is always written).
const mockFeatures = vi.fn(async () => ({ penName: false, rights: false }));
// ADMIN-2-TAKEDOWN: performPublish reads the book's active takedown;
// none here (its own cases are in publish.test.ts).
vi.mock("@/lib/book-takedowns", () => ({ getActiveTakedownState: async () => ({ kind: "none" }) }));
vi.mock("@/lib/catalog-schema-features", () => ({ getCatalogSchemaFeatures: () => mockFeatures() }));

type Op = { method: string; args: unknown[] };
type Query = { client: "session" | "writer"; table: string; ops: Op[] };
type Result = { data: unknown; error: { code?: string; message?: string } | null };

let queries: Query[] = [];
let respond: (q: Query) => Result;
let uploads: string[] = [];

function method(q: Query, name: string): Op | undefined {
  return q.ops.find((op) => op.method === name);
}

function recordingClient(client: Query["client"]) {
  return {
    from(table: string) {
      const q: Query = { client, table, ops: [] };
      const proxy: object = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") {
              return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
                queries.push(q);
                return Promise.resolve(respond(q)).then(onFulfilled, onRejected);
              };
            }
            return (...args: unknown[]) => {
              q.ops.push({ method: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
}

const USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
const BOOK_ID = "c3d4e5f6-2222-4222-8222-abcdef222222";

const sessionClient = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  ...recordingClient("session"),
  storage: {
    from: (bucket: string) => ({
      upload: async (path: string) => (uploads.push(`${bucket}:${path}`), { error: null }),
      remove: async () => ({ error: null }),
      download: async () => ({ data: null, error: { message: "not used" } }),
    }),
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient }));
// PEN-2 (L10): covers are uploaded and removed through the writer.
const writerClient = { ...recordingClient("writer"), storage: sessionClient.storage };
vi.mock("@/lib/catalog-write-client", () => ({ createCatalogWriteClient: () => writerClient }));
// PEN-NAMES-1: the box resolves through the server-only pen name writer
// (src/lib/pen-name-write-client.ts, find-or-create by name).
const DEFAULT_PEN_ID = "f0000000-0000-4000-8000-000000000001";
const JO_PEN_ID = "f0000000-0000-4000-8000-000000000002";
type PenResolution = { ok: true; penNameId: string } | { ok: false; reason: "invalid"; message: string } | { ok: false; reason: "failed" };
const mockResolvePenName = vi.fn<(authorId: string, name: string | null) => Promise<PenResolution>>();
vi.mock("@/lib/pen-name-write-client", () => ({
  resolveOwnPenNameId: (authorId: string, name: string | null) => mockResolvePenName(authorId, name),
}));

const { createBook, updateBook, publishBook } = await import("./actions");

// The session's performPublish read and updateBook's ownership read.
let publishRead: Record<string, unknown>;
let existingRow: Record<string, unknown>;
let writerUpdateRows: number;
let writerError: Result["error"];
let contributorError: Result["error"];

function defaultRespond(q: Query): Result {
  if (q.client === "session" && q.table === "books" && method(q, "select")) {
    const columns = String(method(q, "select")!.args[0]);
    if (columns.startsWith("id, cover_path")) return { data: existingRow, error: null };
    return { data: publishRead, error: null };
  }
  if (q.client === "session" && q.table === "book_contributors") return { data: null, error: contributorError };
  if (q.client === "writer" && q.table === "books" && method(q, "insert")) {
    if (writerError) return { data: null, error: writerError };
    const payload = method(q, "insert")!.args[0] as { id: string };
    return { data: [{ id: payload.id }], error: null };
  }
  if (q.client === "writer" && q.table === "books" && method(q, "update")) {
    if (writerError) return { data: null, error: writerError };
    const id = (q.ops.find((op) => op.method === "eq" && op.args[0] === "id")?.args[1] as string) ?? BOOK_ID;
    return { data: Array.from({ length: writerUpdateRows }, () => ({ id })), error: null };
  }
  throw new Error(`unexpected query: ${q.client} ${q.table} ${q.ops.map((op) => op.method).join(".")}`);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
let epubBytes: Buffer;

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

function createForm(fields: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set("title", "Libri im");
  formData.set("description", "A description.");
  formData.set("keywords", "");
  formData.set("isbn", "");
  formData.set("genre", "Fiction");
  formData.set("price", "0");
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  formData.set("cover", new File([new Uint8Array(PNG_SIGNATURE)], "cover.png", { type: "image/png" }));
  formData.set("manuscript", new File([new Uint8Array(epubBytes)], "book.epub", { type: "application/epub+zip" }));
  return formData;
}

function editForm(fields: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set("title", "Libri im");
  formData.set("description", "A description.");
  formData.set("keywords", "");
  formData.set("isbn", "");
  formData.set("genre", "Fiction");
  formData.set("price", "0");
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

async function redirectOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return decodeURIComponent(error.target.replace(/\+/g, " "));
    throw error;
  }
  throw new Error("expected a redirect");
}

const writerInserts = () => queries.filter((q) => q.client === "writer" && method(q, "insert"));
const writerUpdates = () => queries.filter((q) => q.client === "writer" && method(q, "update"));
const contributorInserts = () => queries.filter((q) => q.table === "book_contributors");
const publishWrites = () =>
  writerUpdates().filter((q) => (method(q, "update")!.args[0] as { status?: string }).status === "published");

beforeEach(async () => {
  epubBytes ??= await buildValidEpubBytes();
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STAGING_SUPABASE_URL);
  vi.stubEnv("PAID_PUBLISHING_MODE", "controlled_staging_publishing_test");
  queries = [];
  uploads = [];
  respond = defaultRespond;
  publishRead = { status: "draft", price_all: 0, published_at: null, description: "A real description." };
  existingRow = {
    id: BOOK_ID,
    cover_path: null,
    file_path: null,
    author_id: USER_ID,
    language: null,
    status: "draft",
    price_all: 0,
    isbn: null,
  };
  writerUpdateRows = 1;
  writerError = null;
  contributorError = null;
  mockRedirect.mockClear();
  mockRightsState.mockReset().mockResolvedValue({ kind: "present", declaration: { basis: "own_rights" } });
  mockRecordRights.mockReset().mockResolvedValue({ ok: true });
  mockFeatures.mockClear();
  mockResolvePenName.mockReset().mockImplementation(async (_authorId, name) => ({
    ok: true,
    penNameId: name ? JO_PEN_ID : DEFAULT_PEN_ID,
  }));
});

describe("performPublish: order price -> description -> rights -> paid (P4)", () => {
  it("a missing price is refused before the rights are read", async () => {
    publishRead = { ...publishRead, price_all: null };
    mockRightsState.mockResolvedValue({ kind: "none" });
    expect(await redirectOf(publishBook(BOOK_ID))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=Set this book's price in lek before publishing it.`,
    );
    expect(mockRightsState).not.toHaveBeenCalled();
  });

  it("a missing description is refused before the rights are read", async () => {
    publishRead = { ...publishRead, description: "  " };
    mockRightsState.mockResolvedValue({ kind: "none" });
    expect(await redirectOf(publishBook(BOOK_ID))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=Add a description before publishing.`,
    );
    expect(mockRightsState).not.toHaveBeenCalled();
  });

  it("no declaration -> missing_rights, on the Edit page, before the paid check", async () => {
    publishRead = { ...publishRead, price_all: 199 };
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockRightsState.mockResolvedValue({ kind: "none" });
    expect(await redirectOf(publishBook(BOOK_ID))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=Choose the rights before publishing.`,
    );
    expect(mockRightsState).toHaveBeenCalledWith(BOOK_ID);
    expect(publishWrites()).toEqual([]);
  });

  it("an unreadable declaration -> rights_unavailable: the existing generic sentence on the dashboard", async () => {
    mockRightsState.mockResolvedValue({ kind: "unavailable" });
    expect(await redirectOf(publishBook(BOOK_ID))).toBe(
      "/dashboard?error=We couldn't publish your book yet. Please try again from your dashboard",
    );
    expect(publishWrites()).toEqual([]);
  });

  it("with a declaration, a paid book without paid permission is refused by the paid check", async () => {
    publishRead = { ...publishRead, price_all: 199 };
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    expect(await redirectOf(publishBook(BOOK_ID))).toBe("/dashboard?error=Paid publishing isn't available right now");
    expect(publishWrites()).toEqual([]);
  });

  it("with a declaration, publishes", async () => {
    expect(await redirectOf(publishBook(BOOK_ID))).toBe("/dashboard?success=Your book is now live");
    expect(publishWrites()).toHaveLength(1);
  });

  it("N1: the publish write also requires a non-null, non-empty description", async () => {
    await redirectOf(publishBook(BOOK_ID));
    const write = publishWrites()[0];
    expect(write.ops).toContainEqual({ method: "not", args: ["description", "is", null] });
    expect(write.ops).toContainEqual({ method: "neq", args: ["description", ""] });
    expect(write.ops.at(-1)).toEqual({ method: "select", args: ["id"] });
  });

  it("N1: zero rows (the description was cleared in between) is update_failed, never live", async () => {
    writerUpdateRows = 0;
    expect(await redirectOf(publishBook(BOOK_ID))).toBe("/dashboard");
  });
});

describe("createBook: the rights choice (P3/P4)", () => {
  it("Save as draft without a choice saves the book and records nothing", async () => {
    expect(await redirectOf(createBook(createForm({ intent: "draft" })))).toBe("/dashboard");
    expect(writerInserts()).toHaveLength(1);
    expect(mockRecordRights).not.toHaveBeenCalled();
  });

  it("Publish without a choice keeps the draft and refuses with Saved as draft", async () => {
    mockRightsState.mockResolvedValue({ kind: "none" });
    expect(await redirectOf(createBook(createForm({ intent: "publish" })))).toBe(
      "/dashboard?success=Saved as draft&error=Choose the rights before publishing.",
    );
    expect(writerInserts()).toHaveLength(1);
    expect(publishWrites()).toEqual([]);
  });

  it("Publish while the declaration cannot be read: the existing generic sentence, draft kept", async () => {
    mockRightsState.mockResolvedValue({ kind: "unavailable" });
    mockRecordRights.mockResolvedValue({ ok: false, reason: "feature_off" });
    expect(await redirectOf(createBook(createForm({ intent: "publish", rightsBasis: "own_rights" })))).toBe(
      "/dashboard?success=Saved as draft&error=We couldn't publish your book yet. Please try again from your dashboard",
    );
    expect(writerInserts()).toHaveLength(1);
  });

  it.each(["own_rights", "public_domain"])(
    "records exactly one declaration, for the new book's server id and the submitted basis (%s)",
    async (basis) => {
      const form = createForm({ intent: "publish", rightsBasis: basis, bookId: "client-chosen-id" });
      expect(await redirectOf(createBook(form))).toBe("/dashboard?success=Your book is now live");
      const insertedId = (method(writerInserts()[0], "insert")!.args[0] as { id: string }).id;
      expect(mockRecordRights).toHaveBeenCalledTimes(1);
      expect(mockRecordRights).toHaveBeenCalledWith(insertedId, basis);
      expect(insertedId).not.toBe("client-chosen-id");
    },
  );

  it("an unknown basis is never recorded", async () => {
    await redirectOf(createBook(createForm({ intent: "draft", rightsBasis: "i_promise" })));
    expect(mockRecordRights).not.toHaveBeenCalled();
  });

  it("a failed record never loses the book; Publish then refuses", async () => {
    mockRecordRights.mockResolvedValue({ ok: false, reason: "error" });
    mockRightsState.mockResolvedValue({ kind: "none" });
    expect(await redirectOf(createBook(createForm({ intent: "publish", rightsBasis: "own_rights" })))).toBe(
      "/dashboard?success=Saved as draft&error=Choose the rights before publishing.",
    );
    expect(writerInserts()).toHaveLength(1);
  });
});

describe("updateBook: the rights choice is recorded only when it changes (P3)", () => {
  it("no declaration yet -> recorded, after the proven save", async () => {
    mockRightsState.mockResolvedValue({ kind: "none" });
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ rightsBasis: "public_domain" })))).toBe(
      "/dashboard?success=Book updated",
    );
    expect(mockRecordRights).toHaveBeenCalledWith(BOOK_ID, "public_domain");
    expect(writerUpdates()).toHaveLength(1);
  });

  it("a different basis -> recorded", async () => {
    await redirectOf(updateBook(BOOK_ID, editForm({ rightsBasis: "public_domain" })));
    expect(mockRecordRights).toHaveBeenCalledTimes(1);
  });

  it("the same basis resubmitted -> nothing recorded", async () => {
    await redirectOf(updateBook(BOOK_ID, editForm({ rightsBasis: "own_rights" })));
    expect(mockRecordRights).not.toHaveBeenCalled();
  });

  it("unavailable -> nothing recorded, the save stands", async () => {
    mockRightsState.mockResolvedValue({ kind: "unavailable" });
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ rightsBasis: "public_domain" })))).toBe(
      "/dashboard?success=Book updated",
    );
    expect(mockRecordRights).not.toHaveBeenCalled();
  });

  it("no rightsBasis in the form -> the declarations are not even read", async () => {
    await redirectOf(updateBook(BOOK_ID, editForm()));
    expect(mockRightsState).not.toHaveBeenCalled();
    expect(mockRecordRights).not.toHaveBeenCalled();
  });

  it("a save that fails records nothing", async () => {
    writerUpdateRows = 0;
    mockRightsState.mockResolvedValue({ kind: "none" });
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ rightsBasis: "own_rights" })))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=${CATALOG_ROW_CHANGED_MESSAGE}`,
    );
    expect(mockRecordRights).not.toHaveBeenCalled();
  });

  it("a failed record never undoes the save", async () => {
    mockRightsState.mockResolvedValue({ kind: "none" });
    mockRecordRights.mockResolvedValue({ ok: false, reason: "error" });
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ rightsBasis: "own_rights" })))).toBe(
      "/dashboard?success=Book updated",
    );
  });
});

describe("pen name (P1, PEN-NAMES-1 10a/14a/11a)", () => {
  const insertPayload = () => method(writerInserts()[0], "insert")!.args[0] as Record<string, unknown>;
  const updatePayload = () => method(writerUpdates()[0], "update")!.args[0] as Record<string, unknown>;

  it("createBook: absent -> the author's default pen name, by id; the legacy text is never written", async () => {
    await redirectOf(createBook(createForm({ intent: "draft" })));
    expect(mockResolvePenName).toHaveBeenCalledWith(USER_ID, null);
    expect(insertPayload().pen_name_id).toBe(DEFAULT_PEN_ID);
    expect(insertPayload()).not.toHaveProperty("pen_name");
  });

  it("createBook: empty after trimming -> the default", async () => {
    await redirectOf(createBook(createForm({ intent: "draft", penName: "   " })));
    expect(mockResolvePenName).toHaveBeenCalledWith(USER_ID, null);
    expect(insertPayload().pen_name_id).toBe(DEFAULT_PEN_ID);
  });

  it("createBook: trimmed name, resolved for the SESSION user, written by id through the trusted writer, before any upload", async () => {
    await redirectOf(createBook(createForm({ intent: "draft", penName: "  Jo Pen \t", authorId: "someone-else" })));
    expect(mockResolvePenName).toHaveBeenCalledTimes(1);
    expect(mockResolvePenName).toHaveBeenCalledWith(USER_ID, "Jo Pen");
    expect(insertPayload().pen_name_id).toBe(JO_PEN_ID);
    expect(writerInserts()[0].client).toBe("writer");
    expect(mockFeatures).not.toHaveBeenCalled();
  });

  it("createBook: an invalid name is refused with its own message, before any upload or insert", async () => {
    mockResolvePenName.mockResolvedValue({ ok: false, reason: "invalid", message: "A pen name must be 120 characters or fewer." });
    expect(await redirectOf(createBook(createForm({ intent: "draft", penName: "x".repeat(121) })))).toBe(
      "/dashboard/books/new?error=A pen name must be 120 characters or fewer.",
    );
    expect(uploads).toEqual([]);
    expect(writerInserts()).toEqual([]);
  });

  it("createBook: a failed resolution -> the existing save-failure message, nothing uploaded", async () => {
    mockResolvePenName.mockResolvedValue({ ok: false, reason: "failed" });
    expect(await redirectOf(createBook(createForm({ intent: "draft", penName: "Jo Pen" })))).toBe(
      "/dashboard/books/new?error=Something went wrong saving your book. Please try again",
    );
    expect(uploads).toEqual([]);
  });

  it("createBook: 11a -- the database refuses a series of another pen name (LB451) with a clear message", async () => {
    writerError = { code: "LB451", message: "pen names: a series holds books of one pen name only" };
    expect(await redirectOf(createBook(createForm({ intent: "draft", penName: "Jo Pen" })))).toBe(
      "/dashboard/books/new?error=A series or bundle holds books of one pen name only. Choose books under the same pen name.",
    );
  });

  it("createBook: any other write error -> the existing save-failure message", async () => {
    writerError = { code: "PGRST204", message: "Could not find the 'pen_name_id' column" };
    expect(await redirectOf(createBook(createForm({ intent: "draft", penName: "Jo Pen" })))).toBe(
      "/dashboard/books/new?error=Something went wrong saving your book. Please try again",
    );
  });

  it("updateBook: absent -> untouched (no resolution, no pen key)", async () => {
    await redirectOf(updateBook(BOOK_ID, editForm()));
    expect(mockResolvePenName).not.toHaveBeenCalled();
    expect(updatePayload()).not.toHaveProperty("pen_name_id");
    expect(updatePayload()).not.toHaveProperty("pen_name");
  });

  it("updateBook: present and empty -> the default pen name", async () => {
    await redirectOf(updateBook(BOOK_ID, editForm({ penName: "  " })));
    expect(mockResolvePenName).toHaveBeenCalledWith(USER_ID, null);
    expect(updatePayload().pen_name_id).toBe(DEFAULT_PEN_ID);
    expect(updatePayload()).not.toHaveProperty("pen_name");
  });

  it("updateBook: trimmed name -> that pen name by id", async () => {
    await redirectOf(updateBook(BOOK_ID, editForm({ penName: " Jo Pen " })));
    expect(mockResolvePenName).toHaveBeenCalledWith(USER_ID, "Jo Pen");
    expect(updatePayload().pen_name_id).toBe(JO_PEN_ID);
  });

  it("updateBook: 14a -- a book in a series or bundle keeps its pen name (LB452): take it out first", async () => {
    writerError = { code: "LB452", message: "pen names: the book is in a series or bundle" };
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ penName: "Jo Pen" })))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=This book is in a series or bundle. Take it out first, then change its pen name.`,
    );
  });

  it("updateBook: any other write error -> the existing save-failure message", async () => {
    writerError = { code: "23514", message: "violates check constraint" };
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ penName: "Jo Pen" })))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=Something went wrong saving your changes. Please try again`,
    );
  });
});

describe("Translator (P2) and the one error slot", () => {
  it("inserts one Translator contributor on the author's session after the book row", async () => {
    expect(await redirectOf(createBook(createForm({ intent: "draft", translator: "  Ana Translator " })))).toBe(
      "/dashboard",
    );
    const [insert] = contributorInserts();
    expect(insert.client).toBe("session");
    const insertedId = (method(writerInserts()[0], "insert")!.args[0] as { id: string }).id;
    expect(method(insert, "insert")!.args[0]).toEqual({ book_id: insertedId, name: "Ana Translator", role: "Translator" });
    expect(queries.indexOf(writerInserts()[0])).toBeLessThan(queries.indexOf(insert));
  });

  it("an empty Translator inserts nothing", async () => {
    await redirectOf(createBook(createForm({ intent: "draft", translator: "  " })));
    expect(contributorInserts()).toEqual([]);
  });

  it("121 characters: no insert, the book is kept, the contributor message shows", async () => {
    expect(await redirectOf(createBook(createForm({ intent: "draft", translator: "t".repeat(121) })))).toBe(
      "/dashboard?error=We couldn't add the contributor. Please try again.",
    );
    expect(contributorInserts()).toEqual([]);
    expect(writerInserts()).toHaveLength(1);
  });

  it("120 characters are inserted", async () => {
    await redirectOf(createBook(createForm({ intent: "draft", translator: "t".repeat(120) })));
    expect(contributorInserts()).toHaveLength(1);
  });

  it("an insert failure keeps the book and shows the contributor message", async () => {
    contributorError = { code: "42501", message: "denied" };
    expect(await redirectOf(createBook(createForm({ intent: "draft", translator: "Ana" })))).toBe(
      "/dashboard?error=We couldn't add the contributor. Please try again.",
    );
    expect(writerInserts()).toHaveLength(1);
  });

  it("a successful publish keeps its success line and adds the contributor message", async () => {
    contributorError = { code: "42501", message: "denied" };
    expect(await redirectOf(createBook(createForm({ intent: "publish", translator: "Ana", rightsBasis: "own_rights" })))).toBe(
      "/dashboard?success=Your book is now live&error=We couldn't add the contributor. Please try again.",
    );
  });

  it("a publish refusal wins the one error slot; the translator failure is only logged", async () => {
    contributorError = { code: "42501", message: "denied" };
    mockRightsState.mockResolvedValue({ kind: "none" });
    expect(await redirectOf(createBook(createForm({ intent: "publish", translator: "Ana" })))).toBe(
      "/dashboard?success=Saved as draft&error=Choose the rights before publishing.",
    );
  });
});

describe("updateBook: a published book keeps its description (P6, FIX1 A5)", () => {
  it("a published book with the description cleared: refused before any upload or write", async () => {
    existingRow = { ...existingRow, status: "published" };
    const form = editForm({ description: "   " });
    form.set("cover", new File([new Uint8Array(PNG_SIGNATURE)], "cover.png", { type: "image/png" }));
    expect(await redirectOf(updateBook(BOOK_ID, form))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=A published book needs a description.`,
    );
    expect(uploads).toEqual([]);
    expect(writerUpdates()).toEqual([]);
  });

  it("a draft may clear it, and that write also requires the row to still be a draft", async () => {
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ description: "" })))).toBe("/dashboard?success=Book updated");
    expect(writerUpdates()[0].ops).toContainEqual({ method: "eq", args: ["status", "draft"] });
  });

  it("a race with Publish (zero rows) ends in CATALOG_ROW_CHANGED_MESSAGE", async () => {
    writerUpdateRows = 0;
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ description: "" })))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=${CATALOG_ROW_CHANGED_MESSAGE}`,
    );
  });

  it("a published book with a description saves normally, with no draft condition added", async () => {
    existingRow = { ...existingRow, status: "published" };
    expect(await redirectOf(updateBook(BOOK_ID, editForm({ description: "Still here." })))).toBe(
      "/dashboard?success=Book updated",
    );
    expect(writerUpdates()[0].ops).not.toContainEqual({ method: "eq", args: ["status", "draft"] });
  });
});
