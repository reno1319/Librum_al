import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// ADMIN-2-TAKEDOWN (B): the admin books list. Its own gate, the
// filters' queries (Live / Draft / Taken down), the escaped search and
// the rows, rendered to static HTML.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRequireStaff = vi.fn((permission: string): Promise<{ userId: string; role: string }> => {
  void permission;
  return Promise.resolve({ userId: "staff-1", role: "moderator" });
});
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

let takenDown: Set<string> | null = new Set();
// ADMIN-3-REVIEW: books with a pending review.
let inReview: Set<string> | null = new Set();
vi.mock("./admin-book-reads", () => ({
  readActiveTakedownBookIds: () => Promise.resolve(takenDown),
  readPendingReviewBookIds: () => Promise.resolve(inReview),
}));

type Result = { data: unknown; error: { message: string } | null; count?: number };
let rows: Record<string, Result> = {};
const calls: { table: string; ops: [string, ...unknown[]][] }[] = [];
const mockAdminFrom = vi.fn((table: string) => {
  const call = { table, ops: [] as [string, ...unknown[]][] };
  calls.push(call);
  const done = () => Promise.resolve(rows[table] ?? { data: [], error: null, count: 0 });
  const chain: Record<string, unknown> = {};
  for (const op of ["select", "eq", "not", "in", "or", "ilike", "order", "range", "limit"]) {
    chain[op] = (...args: unknown[]) => {
      call.ops.push([op, ...args]);
      return chain;
    };
  }
  chain.returns = done;
  return chain;
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));

const { default: AdminBooksPage } = await import("./page");

const BOOK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function render(search: Record<string, string> = {}): Promise<string> {
  const element = await AdminBooksPage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(element as ReactElement);
}

function booksCall() {
  return calls.find((c) => c.table === "books");
}

describe("AdminBooksPage", () => {
  beforeEach(() => {
    calls.length = 0;
    mockAdminFrom.mockClear();
    takenDown = new Set([BOOK_B]);
    inReview = new Set();
    rows = {
      books: {
        data: [
          { id: BOOK_A, title: "Kënga e fundit", status: "published", published_at: "2026-09-01T10:00:00Z", created_at: "x", pen: { name: "Ana Pena" } },
          { id: BOOK_B, title: "Draft one", status: "draft", published_at: null, created_at: "x", pen: null },
        ],
        error: null,
        count: 2,
      },
    };
  });

  it("gates on requireStaff('reports.view') and reads nothing when denied", async () => {
    mockRequireStaff.mockImplementationOnce(() => {
      throw new RedirectSignal("/?denied");
    });
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.view");
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("lists every book with its state, author and published date, newest first", async () => {
    const html = await render();
    expect(html).toContain(`href="/admin/books/${BOOK_A}"`);
    expect(html).toContain("Ana Pena");
    expect(html).toMatch(/>Live</);
    expect(html).toMatch(/>Taken down</);
    expect(html).toContain("Never published");
    expect(html).toContain("2 books");
    expect(booksCall()?.ops).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(booksCall()?.ops).toContainEqual(["range", 0, 49]);
  });

  it("Live is published; Draft leaves out the taken-down books; Taken down is exactly them", async () => {
    await render({ status: "live" });
    expect(booksCall()?.ops).toContainEqual(["eq", "status", "published"]);

    calls.length = 0;
    await render({ status: "draft" });
    expect(booksCall()?.ops).toContainEqual(["eq", "status", "draft"]);
    expect(booksCall()?.ops).toContainEqual(["not", "id", "in", `(${BOOK_B})`]);

    calls.length = 0;
    await render({ status: "taken_down" });
    expect(booksCall()?.ops).toContainEqual(["in", "id", [BOOK_B]]);
  });

  it("Taken down with none reads no books", async () => {
    takenDown = new Set();
    const html = await render({ status: "taken_down" });
    expect(booksCall()).toBeUndefined();
    expect(html).toContain("No books match.");
  });

  it("searches title, pen name and public author name with escaped patterns", async () => {
    rows.pen_names = { data: [{ id: PEN }], error: null };
    rows.profiles = { data: [], error: null };
    await render({ q: "50%_" });
    expect(calls.find((c) => c.table === "pen_names")?.ops).toContainEqual(["ilike", "name", "%50\\%\\_%"]);
    expect(calls.find((c) => c.table === "profiles")?.ops).toContainEqual(["ilike", "public_author_name", "%50\\%\\_%"]);
    expect(booksCall()?.ops).toContainEqual(["or", `title.ilike."%50\\\\%\\\\_%",pen_name_id.in.(${PEN})`]);
  });

  it("shows an error, never a false empty list, when a read fails", async () => {
    takenDown = null;
    const html = await render();
    expect(html).toContain("Couldn&#x27;t load the books. Please try again.");
    expect(html).not.toContain("No books match.");
  });

  // ADMIN-3-REVIEW (G)
  it("In review is the drafts with a pending review; Draft leaves them out too; the row shows the chip", async () => {
    const BOOK_C = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    inReview = new Set([BOOK_C]);
    rows.books = {
      data: [{ id: BOOK_C, title: "Waiting one", status: "draft", published_at: null, created_at: "x", pen: { name: "Ana Pena" } }],
      error: null,
      count: 1,
    };
    const html = await render({ status: "in_review" });
    expect(booksCall()?.ops).toContainEqual(["eq", "status", "draft"]);
    expect(booksCall()?.ops).toContainEqual(["in", "id", [BOOK_C]]);
    expect(html).toMatch(/>In review</);
    expect(html).toContain('aria-current="true"');

    calls.length = 0;
    await render({ status: "draft" });
    expect(booksCall()?.ops).toContainEqual(["not", "id", "in", `(${BOOK_B},${BOOK_C})`]);
  });

  it("In review with none reads no books, and a failed review read is an error", async () => {
    inReview = new Set();
    const html = await render({ status: "in_review" });
    expect(booksCall()).toBeUndefined();
    expect(html).toContain("No books match.");

    inReview = null;
    const failed = await render();
    expect(failed).toContain("Couldn&#x27;t load the books. Please try again.");
  });

  it("offers the In review filter between Live and Draft", async () => {
    const html = await render();
    const order = ["All", "Live", "In review", "Draft", "Taken down"].map((label) => html.indexOf(`>${label}</a>`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
