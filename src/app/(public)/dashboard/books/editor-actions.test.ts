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
let rightsBasis: string | null;
let recorded: string[];
let failContributorInsert: { code: string } | null;
let currentUser: string | null;

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
      rows.forEach((r) => Object.assign(r, payload));
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    if (op === "delete") {
      const rows = visible();
      sessionContributorWrites.push({ op, payload: rows.map((r) => r.id) });
      tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r));
      return { data: null, error: null };
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
  createCatalogWriteClient: () => ({ from: (table: string) => query(table, "writer") }),
}));
vi.mock("@/lib/pen-name-write-client", () => ({
  resolveOwnPenNameId: async () => ({ ok: true, penNameId: PEN }),
}));
vi.mock("@/lib/book-reviews", () => ({
  getBookReviewState: async () => ({ kind: "ok", pending: reviewPending, approvalValid: false, latestSentBack: null }),
}));
vi.mock("@/lib/book-rights", () => ({
  getRightsDeclarationState: async () =>
    rightsBasis ? { kind: "present", declaration: { basis: rightsBasis } } : { kind: "none" },
  recordRightsDeclaration: async (_bookId: string, basis: string) => {
    recorded.push(basis);
    return { ok: true, declaration: { basis } };
  },
}));

const { saveBookDetails, createSeriesFromEditor } = await import("./editor-actions");

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
  rightsBasis = null;
  recorded = [];
  failContributorInsert = null;
  currentUser = USER;
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

  it("a live book or a book in review stays on the existing edit page", async () => {
    seed({ status: "published", published_at: "2026-10-01T00:00:00Z" });
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T" })))).toMatch(
      new RegExp(`^/dashboard/books/${BOOK}/edit\\?error=`),
    );
    seed();
    reviewPending = true;
    expect(await redirectOf(saveBookDetails(BOOK, form({ title: "T" })))).toMatch(
      new RegExp(`^/dashboard/books/${BOOK}/edit\\?error=`),
    );
    expect(catalogWrites).toEqual([]);
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
