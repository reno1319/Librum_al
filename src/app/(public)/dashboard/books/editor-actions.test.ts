import { beforeEach, describe, expect, it, vi } from "vitest";

// BD15 P2: the new editor's Details save. A small in-memory double of
// the author's session (RLS: own rows) and of the catalog writer.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const USER = "a1111111-1111-4111-8111-111111111111";
const OTHER = "b2222222-2222-4222-8222-222222222222";
const BOOK = "c3333333-3333-4333-8333-333333333333";
const PEN = "d4444444-4444-4444-8444-444444444444";
const PEN_2 = "d5555555-5555-4555-8555-555555555555";
const OTHER_PEN = "d6666666-6666-4666-8666-666666666666";
const SERIES = "e7777777-7777-4777-8777-777777777777";
const OTHER_SERIES = "e8888888-8888-4888-8888-888888888888";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let catalogWrites: { op: string; payload: Row; filters: [string, unknown][] }[];
let sessionContributorWrites: { op: string; payload: unknown }[];
let reviewPending: boolean;
// Audit r1, F4: what a re-read after a failed later step sees (sent from another tab).
let waitingAfterSave: boolean;
let rightsRecordOk: boolean;
let rightsBasis: string | null;
let recorded: string[];
let failContributorInsert: { code: string } | null;
let failBookUpdate: { code: string } | null;
let currentUser: string | null;
// BD15 P5b-2: the two writer RPCs of book_pending_changes.
let rpcCalls: { fn: string; args: Row }[];
let rpcError: { code?: string; message?: string } | null;
let removedCovers: string[];
// Audit r1 F3/M5: what the discard RPC answers, and what happens meanwhile.
let discardAnswer: boolean | null;
let afterRpc: (() => void) | null;
// P5b-3b: another tab's write landing between the action's read and its RPC.
let beforeCompare: (() => void) | null;
let failWriterReadAfterRpc: string | null;

function query(table: string, scope: "session" | "writer") {
  const filters: [string, unknown][] = [];
  let inFilter: [string, unknown[]] | null = null;
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | Row[] | null = null;
  const visible = () =>
    (tables[table] ?? []).filter((r) => {
      if (scope === "session" && "author_id" in r && r.author_id !== currentUser) return false;
      if (!filters.every(([c, v]) => r[c] === v)) return false;
      if (inFilter && !inFilter[1].includes(r[inFilter[0]])) return false;
      return true;
    });
  const run = () => {
    if (op === "insert") {
      const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ ...r }));
      if (scope === "writer") catalogWrites.push({ op, payload: rows[0], filters: [] });
      else {
        sessionContributorWrites.push({ op, payload: rows });
        if (table === "book_contributors" && failContributorInsert) return { data: null, error: failContributorInsert };
        rows.forEach((r, i) => (r.id ??= `new-${i}-${Math.random()}`));
      }
      tables[table] = [...(tables[table] ?? []), ...rows];
      return { data: rows.map((r) => ({ id: r.id, title: r.title, pen_name_id: r.pen_name_id })), error: null };
    }
    if (op === "update") {
      const rows = visible();
      catalogWrites.push({ op, payload: payload as Row, filters: [...filters] });
      if (table === "books" && failBookUpdate) return { data: null, error: failBookUpdate };
      rows.forEach((r) => Object.assign(r, payload));
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    if (op === "delete") {
      const rows = visible();
      sessionContributorWrites.push({ op, payload: rows.map((r) => r.id) });
      tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r));
      return { data: null, error: null };
    }
    // Audit P5b-2 r2, R2-1 N3/N4: a writer read of this table after the
    // RPC (the discard's re-read) fails -- with the rows still beside the
    // error, so only the error check can keep the ballinë.
    if (scope === "writer" && failWriterReadAfterRpc === table && rpcCalls.length > 0) {
      return { data: visible(), error: { code: "XX000", message: "read failed" } };
    }
    return { data: visible(), error: null };
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), chain),
    update: (p: Row) => ((op = "update"), (payload = p), chain),
    delete: () => ((op = "delete"), chain),
    eq: (c: string, v: unknown) => (filters.push([c, v]), chain),
    in: (c: string, v: unknown[]) => ((inFilter = [c, v]), chain),
    order: () => chain,
    returns: () => chain,
    maybeSingle: async () => {
      const { data, error } = run();
      return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
    },
    single: async () => {
      const { data, error } = run();
      return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
    },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser ? { id: currentUser } : null } }) },
    from: (table: string) => query(table, "session"),
  }),
}));
vi.mock("@/lib/catalog-write-client", () => ({
  createCatalogWriteClient: () => ({
    from: (table: string) => query(table, "writer"),
    // save/discard_book_pending_changes, as the database would, with
    // P5b-3b's compare of the version read (LB496).
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      if (rpcError) return { data: null, error: rpcError };
      const current = (tables.book_pending_changes ?? []).find((r) => r.book_id === args.p_book_id);
      const others = (tables.book_pending_changes ?? []).filter((r) => r.book_id !== args.p_book_id);
      const had = current !== undefined;
      beforeCompare?.();
      const now = (tables.book_pending_changes ?? []).find((r) => r.book_id === args.p_book_id);
      if ((now?.version ?? null) !== args.p_expected_version) {
        return { data: null, error: { code: "LB496", message: "The waiting changes changed since they were read." } };
      }
      if (fn === "discard_book_pending_changes") {
        tables.book_pending_changes = others;
        afterRpc?.();
        return { data: discardAnswer ?? had, error: null };
      }
      tables.book_pending_changes = [
        ...others,
        {
          book_id: args.p_book_id,
          file_path: args.p_file_path,
          cover_path: args.p_cover_path,
          description: args.p_description,
          is_adult: args.p_is_adult,
          original_author: args.p_original_author,
          version: ((current?.version as number | undefined) ?? 0) + 1,
        },
      ];
      return { data: ((current?.version as number | undefined) ?? 0) + 1, error: null };
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removedCovers.push(...paths);
          return { error: null };
        },
      }),
    },
  }),
}));
const retentionCalls: unknown[] = [];
vi.mock("@/lib/pen-name-write-client", () => ({
  resolveOwnPenNameId: async () => ({ ok: true, penNameId: PEN }),
}));
vi.mock("@/lib/book-reviews", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBookReviewState: async () => ({ kind: "ok", pending: reviewPending, approvalValid: false, latestSentBack: null }),
  isWaitingForReview: async () => waitingAfterSave,
  removeUnretainedManuscripts: async (...args: unknown[]) => {
    retentionCalls.push(args[2]);
  },
}));
vi.mock("@/lib/book-rights", () => ({
  getRightsDeclarationState: async () =>
    rightsBasis ? { kind: "present", declaration: { basis: rightsBasis } } : { kind: "none" },
  recordRightsDeclaration: async (_bookId: string, basis: string) => {
    if (!rightsRecordOk) return { ok: false, reason: "error" };
    recorded.push(basis);
    return { ok: true, declaration: { basis } };
  },
}));

const { saveBookDetails, createSeriesFromEditor, discardBookPendingChanges } = await import("./editor-actions");
const { LIVE_PARTLY_SAVED_MESSAGE } = await import("@/lib/book-editor-copy");
const { BOOK_CHANGED_WHILE_EDITING_MESSAGE } = await import("@/lib/book-review-copy");
const { pageErrorMessage } = await import("@/lib/page-messages");

function seed(book: Row = {}) {
  tables = {
    books: [
      {
        id: BOOK,
        author_id: USER,
        status: "draft",
        published_at: null,
        title: "Old title",
        pen_name_id: PEN,
        ...book,
      },
    ],
    pen_names: [
      { id: PEN, author_id: USER },
      { id: PEN_2, author_id: USER },
      { id: OTHER_PEN, author_id: OTHER },
    ],
    series: [
      { id: SERIES, author_id: USER },
      { id: OTHER_SERIES, author_id: OTHER },
    ],
    book_contributors: [],
    book_pending_changes: [],
  };
}

function form(values: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
  throw new Error("no redirect");
}

const bookRow = () => tables.books.find((b) => b.id === BOOK)!;

beforeEach(() => {
  seed();
  catalogWrites = [];
  sessionContributorWrites = [];
  reviewPending = false;
  waitingAfterSave = false;
  rightsRecordOk = true;
  rightsBasis = null;
  recorded = [];
  failContributorInsert = null;
  failBookUpdate = null;
  currentUser = USER;
  rpcCalls = [];
  rpcError = null;
  removedCovers = [];
  retentionCalls.length = 0;
  discardAnswer = null;
  afterRpc = null;
  beforeCompare = null;
  failWriterReadAfterRpc = null;
});

describe("saveBookDetails: the first save creates the draft", () => {
  it("creates a draft from a title alone, with the default pen name, and opens it", async () => {
    const target = await redirectOf(saveBookDetails(null, form({ title: "Libri im", intent: "save" })));
    expect(catalogWrites).toHaveLength(1);
    const insert = catalogWrites[0];
    expect(insert.op).toBe("insert");
    expect(insert.payload).toMatchObject({ author_id: USER, title: "Libri im", pen_name_id: PEN, categories: null, keywords: "" });
    expect(insert.payload).not.toHaveProperty("status");
    expect(insert.payload).not.toHaveProperty("file_path");
    expect(insert.payload).not.toHaveProperty("cover_path");
    expect(insert.payload).not.toHaveProperty("price_all");
    expect(target).toBe(`/dashboard/books/${insert.payload.id}/editor?tab=details&success=U%20ruajt%20si%20draft`);
  });

  // BD15 cleanup (ported from the removed createBook's Patch 8 test): the
  // one trusted books insert takes its identity from the server only.
  it("client-supplied id, author, status, path and price fields cannot control the inserted row", async () => {
    const hostile = form({ title: "Libri im", intent: "save" });
    for (const [key, value] of [
      ["id", "00000000-0000-4000-8000-000000000bad"],
      ["bookId", "00000000-0000-4000-8000-000000000bad"],
      ["author_id", "00000000-0000-4000-8000-0000000000aa"],
      ["authorId", "00000000-0000-4000-8000-0000000000aa"],
      ["status", "published"],
      ["published_at", "2020-01-01T00:00:00Z"],
      ["cover_path", "x/cover.png"],
      ["file_path", "x/book.epub"],
      ["price_all", "199"],
    ]) {
      hostile.set(key, value);
    }
    await redirectOf(saveBookDetails(null, hostile));
    expect(catalogWrites).toHaveLength(1);
    const { payload } = catalogWrites[0];
    expect(payload.author_id).toBe(USER);
    expect(payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(payload.id).not.toBe("00000000-0000-4000-8000-000000000bad");
    for (const key of ["status", "published_at", "cover_path", "file_path", "price_all"]) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it("every book id is freshly generated per request", async () => {
    await redirectOf(saveBookDetails(null, form({ title: "Libri im", intent: "save" })));
    await redirectOf(saveBookDetails(null, form({ title: "Libri im", intent: "save" })));
    const ids = catalogWrites.filter((w) => w.op === "insert").map((w) => w.payload.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("\"Ruaj dhe vazhdo\" lands on the Content tab", async () => {
    const target = await redirectOf(saveBookDetails(null, form({ title: "Libri im", intent: "next" })));
    expect(target).toMatch(/\/editor\?tab=content&success=/);
  });

  it("writes the details the form chose", async () => {
    await redirectOf(
      saveBookDetails(
        null,
        form({
          title: "Libri im",
          language: "en",
          penNameId: PEN_2,
          seriesId: SERIES,
          seriesPosition: "2",
          editionNumber: "3",
          description: "**Hyrje**",
          isAdult: "yes",
          categories: ["Romancë", "Poezi"],
          keywords: "a, b",
        }),
      ),
    );
    expect(catalogWrites[0].payload).toMatchObject({
      language: "en",
      pen_name_id: PEN_2,
      series_id: SERIES,
      series_position: 2,
      edition_number: 3,
      description: "**Hyrje**",
      is_adult: true,
      reading_age_min: 18,
      categories: ["Romancë", "Poezi"],
      keywords: "a, b",
    });
  });

  it("refuses another author's pen name or series before any write", async () => {
    expect(await redirectOf(saveBookDetails(null, form({ title: "T", penNameId: OTHER_PEN })))).toMatch(
      /^\/dashboard\/books\/new\?error=/,
    );
    expect(await redirectOf(saveBookDetails(null, form({ title: "T", seriesId: OTHER_SERIES })))).toBe(
      `/dashboard/books/new?error=${encodeURIComponent("Zgjidhni një nga seritë tuaja")}`,
    );
    expect(catalogWrites).toEqual([]);
  });

  it("refuses a form that breaks the rules before any write", async () => {
    const target = await redirectOf(saveBookDetails(null, form({ title: "T", isAdult: "yes", categories: ["Për fëmijë"] })));
    expect(target).toMatch(/^\/dashboard\/books\/new\?error=/);
    expect(catalogWrites).toEqual([]);
  });

  it("sends a signed-out caller to log in", async () => {
    currentUser = null;
    expect(await redirectOf(saveBookDetails(null, form({ title: "T" })))).toBe("/login");
    expect(catalogWrites).toEqual([]);
  });
});

describe("saveBookDetails: an existing draft", () => {
  it("updates only the caller's own draft, bound by id, author and status", async () => {
    await redirectOf(saveBookDetails(BOOK, form({ title: "New title", categories: ["Histori"] })));
    expect(catalogWrites).toHaveLength(1);
    expect(catalogWrites[0].op).toBe("update");
    expect(catalogWrites[0].filters).toEqual([
      ["id", BOOK],
      ["author_id", USER],
      ["status", "draft"],
    ]);
    expect(bookRow()).toMatchObject({ title: "New title", categories: ["Histori"] });
  });

  it("another author's book, a bad id or no book goes back to the dashboard, unwritten", async () => {
    seed({ author_id: OTHER });
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T" })))).toBe("/dashboard");
    expect(await redirectOf(saveBookDetails("not-a-uuid", form({ title: "T" })))).toBe("/dashboard");
    expect(catalogWrites).toEqual([]);
  });

  // BD15 P5b-3a: the old edit page is retired; a book in review (draft
  // or live) shows read-only in the editor.
  it("a book in review (draft or live) goes to the read-only editor; any other status to the dashboard", async () => {
    const inReview = `/dashboard/books/${BOOK}/editor?tab=details&error=${encodeURIComponent("Ky libër është në shqyrtim, prandaj nuk ndryshohet. Anuloni shqyrtimin për ta ndryshuar.")}`;
    seed({ status: "archived" });
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T" })))).toBe("/dashboard");
    seed({ status: "published", published_at: "2026-10-01T00:00:00Z" });
    reviewPending = true;
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T" })))).toBe(inReview);
    seed();
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T" })))).toBe(inReview);
    expect(catalogWrites).toEqual([]);
  });

  // BD15 P5a (P3 audit F3): sent for review from another tab after the
  // check; the database refuses the write (LB490).
  it("a write refused as in review (LB490) goes to the read-only editor; contributors untouched", async () => {
    failBookUpdate = { code: "LB490" };
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T" })))).toBe(
      `/dashboard/books/${BOOK}/editor?tab=details&error=${encodeURIComponent("Ky libër është në shqyrtim, prandaj nuk ndryshohet. Anuloni shqyrtimin për ta ndryshuar.")}`,
    );
    expect(sessionContributorWrites).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("keeps the title and pen name of a book that was published once (N1 lock)", async () => {
    seed({ published_at: "2026-10-01T00:00:00Z" });
    await redirectOf(saveBookDetails(BOOK, form({ title: "Changed", penNameId: PEN_2, subtitle: "Ok" })));
    expect(catalogWrites[0].payload).not.toHaveProperty("title");
    expect(catalogWrites[0].payload).not.toHaveProperty("pen_name_id");
    expect(bookRow()).toMatchObject({ title: "Old title", pen_name_id: PEN, subtitle: "Ok" });
  });

  it("clears the categories to none (null), never to an empty list", async () => {
    seed({ categories: ["Poezi"] });
    await redirectOf(saveBookDetails(BOOK, form({ title: "T" })));
    expect(catalogWrites[0].payload).toMatchObject({ categories: null });
  });
});

describe("saveBookDetails: contributors and rights", () => {
  it("makes the contributors exactly the submitted list", async () => {
    tables.book_contributors = [
      { id: "keep", book_id: BOOK, name: "A", role: "Editor" },
      { id: "drop", book_id: BOOK, name: "B", role: "Translator" },
    ];
    await redirectOf(
      saveBookDetails(
        BOOK,
        form({
          title: "T",
          contributorId: ["keep", "", "forged-id"],
          contributorName: ["A", "C", "D"],
          contributorRole: ["Editor", "Illustrator", "Foreword"],
        }),
      ),
    );
    expect(tables.book_contributors.map((c) => [c.name, c.role])).toEqual([
      ["A", "Editor"],
      ["C", "Illustrator"],
      ["D", "Foreword"],
    ]);
    expect(tables.book_contributors.every((c) => c.book_id === BOOK)).toBe(true);
    expect(tables.book_contributors.some((c) => c.id === "forged-id")).toBe(false);
  });

  it("reports a contributor failure on the Details tab; the book is saved", async () => {
    failContributorInsert = { code: "LB486" };
    const target = await redirectOf(
      saveBookDetails(BOOK, form({ title: "Saved", contributorId: [""], contributorName: ["X"], contributorRole: ["Editor"] })),
    );
    expect(target).toMatch(new RegExp(`^/dashboard/books/${BOOK}/editor\\?tab=details&error=`));
    expect(bookRow()).toMatchObject({ title: "Saved" });
  });

  const IN_REVIEW_EDIT = `/dashboard/books/${BOOK}/editor?tab=details&error=${encodeURIComponent("Ky libër është në shqyrtim, prandaj nuk ndryshohet. Anuloni shqyrtimin për ta ndryshuar.")}`;

  it("a contributor failure on a book sent for review meanwhile goes to the read-only edit page", async () => {
    failContributorInsert = { code: "LB490" };
    waitingAfterSave = true;
    expect(
      await redirectOf(
        saveBookDetails(BOOK, form({ title: "T", contributorId: [""], contributorName: ["X"], contributorRole: ["Editor"] })),
      ),
    ).toBe(IN_REVIEW_EDIT);
  });

  it("a rights failure on a book sent for review meanwhile goes to the read-only edit page", async () => {
    rightsRecordOk = false;
    waitingAfterSave = true;
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T", rightsBasis: "own_rights" })))).toBe(IN_REVIEW_EDIT);
  });

  it("a rights failure on a book not in review stays on the Details tab", async () => {
    rightsRecordOk = false;
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T", rightsBasis: "own_rights" })))).toMatch(
      new RegExp(`^/dashboard/books/${BOOK}/editor\\?tab=details&error=`),
    );
  });

  it("records the rights choice only when it changes", async () => {
    await redirectOf(saveBookDetails(BOOK, form({ title: "T", rightsBasis: "own_rights" })));
    expect(recorded).toEqual(["own_rights"]);
    rightsBasis = "own_rights";
    await redirectOf(saveBookDetails(BOOK, form({ title: "T", rightsBasis: "own_rights" })));
    expect(recorded).toEqual(["own_rights"]);
  });
});

describe("createSeriesFromEditor", () => {
  it("creates the series under the caller's chosen pen name and returns it", async () => {
    const result = await createSeriesFromEditor("  Kronikat ", PEN_2);
    expect(result).toEqual({ ok: true, series: { id: expect.any(String), title: "Kronikat", pen_name_id: PEN_2 } });
  });

  it("refuses another author's pen name and an empty title", async () => {
    expect((await createSeriesFromEditor("Seri", OTHER_PEN)).ok).toBe(false);
    expect((await createSeriesFromEditor("   ", PEN)).ok).toBe(false);
    expect(tables.series).toHaveLength(2);
  });
});

// BD15 P5b-2: a live book saved from the editor stays live.
const COVER_LIVE = "11111111-1111-4111-8111-aaaaaaaaaaaa/cover.jpg";
const COVER_WAITING = "22222222-2222-4222-8222-bbbbbbbbbbbb/cover.jpg";
const FILE_LIVE = `${USER}/${BOOK}/v1.epub`;
const FILE_WAITING = `${USER}/${BOOK}/v2.epub`;

function seedLive(pending: Row | null = null) {
  seed({
    status: "published",
    published_at: "2026-10-01T00:00:00Z",
    title: "Libri",
    file_path: FILE_LIVE,
    cover_path: COVER_LIVE,
    description: "Live text",
    is_adult: false,
    original_author: null,
    categories: ["Romancë"],
  });
  rightsBasis = "own_rights";
  if (pending) {
    tables.book_pending_changes = [
      {
        book_id: BOOK,
        file_path: FILE_LIVE,
        cover_path: COVER_LIVE,
        description: "Live text",
        is_adult: false,
        original_author: null,
        version: 1,
        ...pending,
      },
    ];
  }
}

const liveForm = (values: Record<string, string | string[]> = {}) =>
  form({ title: "Libri", description: "Live text", categories: ["Romancë"], rightsBasis: "own_rights", ...values });

describe("saveBookDetails: a live book (P5b-2)", () => {
  it("writes the fields that need no review onto the live row, bound to status published", async () => {
    seedLive();
    const target = await redirectOf(saveBookDetails(BOOK, liveForm({ subtitle: "Nën", keywords: "a, b", categories: ["Poezi"] })));
    const update = catalogWrites.find((w) => w.op === "update")!;
    expect(update.filters).toEqual(expect.arrayContaining([["id", BOOK], ["author_id", USER], ["status", "published"]]));
    expect(update.payload).toMatchObject({ subtitle: "Nën", keywords: "a, b", categories: ["Poezi"] });
    for (const key of ["title", "pen_name_id", "description", "is_adult", "original_author", "file_path", "cover_path", "price_all", "status"]) {
      expect(update.payload).not.toHaveProperty(key);
    }
    // Nothing that needs review changed: no waiting row is written.
    expect(rpcCalls).toEqual([]);
    expect(target).toMatch(/editor\?tab=details&success=/);
    expect(decodeURIComponent(target)).toContain("Ndryshimet u ruajtën");
  });

  it("a new description waits for review with the live files; the live row keeps its text", async () => {
    seedLive();
    const target = await redirectOf(saveBookDetails(BOOK, liveForm({ description: "New text" })));
    expect(bookRow().description).toBe("Live text");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({
      fn: "save_book_pending_changes",
      args: {
        p_author_id: USER,
        p_book_id: BOOK,
        p_expected_version: null,
        p_file_path: FILE_LIVE,
        p_cover_path: COVER_LIVE,
        p_description: "New text",
        p_is_adult: false,
        p_original_author: null,
      },
    });
    expect(decodeURIComponent(target)).toContain("nuk dalin te lexuesit");
  });

  it("keeps a waiting manuscript and ballinë when the description changes again", async () => {
    seedLive({ file_path: FILE_WAITING, cover_path: COVER_WAITING, description: "Waiting text" });
    await redirectOf(saveBookDetails(BOOK, liveForm({ description: "Newer text" })));
    expect(rpcCalls[0].args).toMatchObject({ p_file_path: FILE_WAITING, p_cover_path: COVER_WAITING, p_description: "Newer text" });
  });

  // BD15 P5b-3b (audit P5b-2 r1 F4; Renato 11-05, Q1 a).
  it("passes the version it read; a save that came in meanwhile wins and this one is refused", async () => {
    seedLive({ file_path: FILE_WAITING, cover_path: COVER_WAITING, description: "Waiting text" });
    const other = { ...tables.book_pending_changes[0], cover_path: "9f9f9f9f-0000-4000-8000-000000000001/cover.jpg", version: 2 };
    beforeCompare = () => (tables.book_pending_changes = [other]);
    const target = await redirectOf(saveBookDetails(BOOK, liveForm({ description: "Edited text" })));
    expect(rpcCalls[0].args).toMatchObject({ p_expected_version: 1, p_cover_path: COVER_WAITING });
    // The other tab's row stands: never the stale ballinë back.
    expect(tables.book_pending_changes).toEqual([other]);
    expect(decodeURIComponent(target)).toContain(LIVE_PARTLY_SAVED_MESSAGE);
  });

  it("dropping the waiting row is refused too when another save came in meanwhile", async () => {
    seedLive({ description: "Waiting text" });
    const other = { ...tables.book_pending_changes[0], description: "Other tab", version: 2 };
    beforeCompare = () => (tables.book_pending_changes = [other]);
    const target = await redirectOf(saveBookDetails(BOOK, liveForm()));
    expect(rpcCalls).toEqual([
      { fn: "discard_book_pending_changes", args: { p_author_id: USER, p_book_id: BOOK, p_expected_version: 1 } },
    ]);
    expect(tables.book_pending_changes).toEqual([other]);
    expect(decodeURIComponent(target)).toContain(LIVE_PARTLY_SAVED_MESSAGE);
  });

  it("putting everything back as it is live drops the waiting row instead", async () => {
    seedLive({ description: "Waiting text" });
    await redirectOf(saveBookDetails(BOOK, liveForm()));
    expect(rpcCalls.map((c) => c.fn)).toEqual(["discard_book_pending_changes"]);
    expect(tables.book_pending_changes).toEqual([]);
  });

  it("a new 18+ label waits; the reading age is not written early", async () => {
    seedLive();
    await redirectOf(saveBookDetails(BOOK, liveForm({ isAdult: "yes" })));
    const update = catalogWrites.find((w) => w.op === "update")!;
    expect(update.payload).not.toHaveProperty("reading_age_min");
    expect(rpcCalls[0].args).toMatchObject({ p_is_adult: true });
  });

  it("refuses a different rights basis before any write (Q4 a)", async () => {
    seedLive();
    const target = await redirectOf(saveBookDetails(BOOK, liveForm({ rightsBasis: "public_domain", originalAuthor: "Naim Frashëri" })));
    expect(decodeURIComponent(target)).toContain("Të drejtat e një libri në shitje nuk ndryshohen");
    expect(catalogWrites).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("audit r1 F1: an older live book with no rights record saves as own rights and records it", async () => {
    seedLive();
    rightsBasis = null;
    await redirectOf(saveBookDetails(BOOK, liveForm({ subtitle: "Nën" })));
    expect(recorded).toEqual(["own_rights"]);
  });

  it("refuses an empty description on a live book before any write", async () => {
    seedLive();
    const target = await redirectOf(saveBookDetails(BOOK, liveForm({ description: "" })));
    expect(target).toMatch(/error=/);
    expect(catalogWrites).toEqual([]);
  });

  it("maps the database's refusals: LB490 to the read-only page, LB493 and LB491 to their messages", async () => {
    seedLive();
    rpcError = { code: "LB490" };
    expect(await redirectOf(saveBookDetails(BOOK, liveForm({ description: "X" })))).toMatch(
      new RegExp(`^/dashboard/books/${BOOK}/editor\\?tab=details&error=`),
    );
    seedLive();
    rpcError = { code: "LB493" };
    expect(decodeURIComponent(await redirectOf(saveBookDetails(BOOK, liveForm({ isAdult: "yes" }))))).toContain(
      "Një libër 18+ nuk mund të jetë",
    );
    seedLive();
    rpcError = { code: "LB491" };
    // Audit r1 F5: the live fields were already saved; it says what was not.
    expect(decodeURIComponent(await redirectOf(saveBookDetails(BOOK, liveForm({ description: "X" }))))).toContain(
      "Ndryshimet e tjera u ruajtën, por përshkrimi",
    );
  });

  it("a live row that is no longer live (zero rows) writes no waiting change", async () => {
    seedLive();
    failBookUpdate = null;
    bookRow().status = "published";
    // The write's status filter misses once the book went offline meanwhile.
    const original = bookRow();
    original.status = "published";
    tables.books = [{ ...original, status: "draft" }];
    reviewPending = false;
    const target = await redirectOf(saveBookDetails(BOOK, liveForm({ description: "X" })));
    // readOwnBook now sees a draft: the draft path runs instead, never the RPC.
    expect(rpcCalls).toEqual([]);
    expect(target).toMatch(/editor\?tab=/);
  });
});

describe("discardBookPendingChanges (P5b-2)", () => {
  it("drops the waiting row and removes only the files only it named", async () => {
    seedLive({ file_path: FILE_WAITING, cover_path: COVER_WAITING, description: "Waiting" });
    const target = await redirectOf(discardBookPendingChanges(BOOK));
    expect(rpcCalls).toEqual([
      { fn: "discard_book_pending_changes", args: { p_author_id: USER, p_book_id: BOOK, p_expected_version: 1 } },
    ]);
    expect(removedCovers).toEqual([COVER_WAITING]);
    expect(retentionCalls).toEqual([
      expect.objectContaining({ authorId: USER, bookId: BOOK, superseded: [FILE_WAITING] }),
    ]);
    expect(decodeURIComponent(target)).toContain("Ndryshimet që prisnin u hodhën");
  });

  it("P5b-3b: a newer save from another tab is not discarded and none of its files are removed", async () => {
    seedLive({ file_path: FILE_WAITING, cover_path: COVER_WAITING, description: "Waiting" });
    const other = { ...tables.book_pending_changes[0], description: "Other tab", version: 2 };
    beforeCompare = () => (tables.book_pending_changes = [other]);
    const target = await redirectOf(discardBookPendingChanges(BOOK));
    expect(tables.book_pending_changes).toEqual([other]);
    expect(removedCovers).toEqual([]);
    expect(retentionCalls).toEqual([]);
    expect(decodeURIComponent(target)).toContain(BOOK_CHANGED_WHILE_EDITING_MESSAGE);
    expect(pageErrorMessage(new URL(target, "http://x").searchParams.get("error") ?? undefined)).toBe(
      BOOK_CHANGED_WHILE_EDITING_MESSAGE,
    );
  });

  it("never removes the live ballinë or manuscript", async () => {
    seedLive({ description: "Waiting" });
    await redirectOf(discardBookPendingChanges(BOOK));
    expect(removedCovers).toEqual([]);
    expect(retentionCalls).toEqual([]);
  });

  it("nothing discarded (another tab already did): nothing removed", async () => {
    seedLive({ file_path: FILE_WAITING, cover_path: COVER_WAITING });
    discardAnswer = false;
    const target = await redirectOf(discardBookPendingChanges(BOOK));
    expect(removedCovers).toEqual([]);
    expect(retentionCalls).toEqual([]);
    expect(decodeURIComponent(target)).toContain("Nuk kishte ndryshime për të hedhur.");
  });

  it.each(["books", "book_pending_changes"])(
    "audit P5b-2 r2, R2-1 N3/N4: the re-read of %s fails after the discard: the ballinë is kept",
    async (table) => {
      seedLive({ cover_path: COVER_WAITING });
      failWriterReadAfterRpc = table;
      vi.spyOn(console, "error").mockImplementation(() => {});
      await redirectOf(discardBookPendingChanges(BOOK));
      expect(tables.book_pending_changes).toEqual([]);
      expect(removedCovers).toEqual([]);
      vi.restoreAllMocks();
    },
  );

  it("audit r1 F3: a waiting ballinë that became the live one meanwhile is kept", async () => {
    seedLive({ cover_path: COVER_WAITING });
    // A new row object, so the action's own earlier read is not changed.
    afterRpc = () => (tables.books = tables.books.map((b) => (b.id === BOOK ? { ...b, cover_path: COVER_WAITING } : b)));
    await redirectOf(discardBookPendingChanges(BOOK));
    expect(removedCovers).toEqual([]);
  });

  it("audit r1 F3: a waiting ballinë a new waiting row names (another tab) is kept", async () => {
    seedLive({ cover_path: COVER_WAITING });
    afterRpc = () =>
      (tables.book_pending_changes = [
        { book_id: BOOK, file_path: FILE_LIVE, cover_path: COVER_WAITING, description: "X", is_adult: false, original_author: null, version: 1 },
      ]);
    await redirectOf(discardBookPendingChanges(BOOK));
    expect(removedCovers).toEqual([]);
  });

  it("in review (LB490) goes to the read-only edit page, nothing removed", async () => {
    seedLive({ cover_path: COVER_WAITING });
    rpcError = { code: "LB490" };
    expect(await redirectOf(discardBookPendingChanges(BOOK))).toMatch(
      new RegExp(`^/dashboard/books/${BOOK}/editor\\?tab=details&error=`),
    );
    expect(removedCovers).toEqual([]);
  });

  it("another author's book goes back to the dashboard, untouched", async () => {
    seedLive({ cover_path: COVER_WAITING });
    currentUser = OTHER;
    expect(await redirectOf(discardBookPendingChanges(BOOK))).toBe("/dashboard");
    expect(rpcCalls).toEqual([]);
  });
});
