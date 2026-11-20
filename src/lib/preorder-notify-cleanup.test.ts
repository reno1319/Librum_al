import { beforeEach, describe, expect, it, vi } from "vitest";

// NOTIFY-CLEANUP (Renato 11-20: Q1 a, Q2 a): which «Më njofto» requests
// the daily job deletes. A small in-memory fake of the two tables
// answers the PostgREST chains the code uses (SQL null rules: a
// comparison with null is false). All ids are made up.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

type Req = {
  book_id: string;
  user_id: string;
  created_at: string;
  notified_at: string | null;
  book_cancelled_at: string | null;
};
type Book = { id: string; status: string; release_date: string | null; published_at: string | null };

let reqs: Req[] = [];
let books: Book[] = [];
let failOn: string | null = null; // "delete:1".."delete:3" or "read"
let deleteCalls = 0;

type R = Record<string, unknown>;

function query(table: string) {
  const filters: ((r: R) => boolean)[] = [];
  let mode: "select" | "delete" = "select";
  const field = (r: R, column: string) => {
    if (column.startsWith("books.")) {
      const book = books.find((b) => b.id === r.book_id) as unknown as R | undefined;
      return book?.[column.slice(6)];
    }
    return r[column];
  };
  const run = () => {
    if (mode === "delete") {
      deleteCalls += 1;
      if (failOn === `delete:${deleteCalls}`) return { data: null, error: { code: "XX000" } };
      const hit = (reqs as unknown as R[]).filter((r) => filters.every((f) => f(r)));
      reqs = reqs.filter((r) => !hit.includes(r as unknown as R));
      return { data: hit.map((r) => ({ book_id: r.book_id })), error: null };
    }
    if (failOn === "read") return { data: null, error: { code: "57014" } };
    const hit = (reqs as unknown as R[]).filter(
      (r) => books.some((b) => b.id === r.book_id) && filters.every((f) => f(r)),
    );
    // The embedded book (books!inner(...)), as PostgREST returns it.
    return {
      data: hit.map((r) => {
        const book = books.find((b) => b.id === r.book_id)!;
        return {
          book_id: r.book_id,
          books: { status: book.status, release_date: book.release_date, published_at: book.published_at },
        };
      }),
      error: null,
    };
  };
  const chain = {
    delete: () => ((mode = "delete"), chain),
    select: () => chain,
    is: (c: string, v: null) => (filters.push((r) => field(r, c) === v), chain),
    not: (c: string, _op: "is", v: null) => (filters.push((r) => field(r, c) !== v), chain),
    lt: (c: string, v: string) => (filters.push((r) => field(r, c) != null && String(field(r, c)) < v), chain),
    neq: (c: string, v: string) => (filters.push((r) => field(r, c) != null && field(r, c) !== v), chain),
    in: (c: string, v: string[]) => (filters.push((r) => v.includes(String(field(r, c)))), chain),
    returns: () => Promise.resolve(run()),
  };
  expect(table).toBe("preorder_notify_requests");
  return chain;
}

const admin = { from: query } as never;

const { deleteOldNotifyRequests, NOTIFY_REQUEST_KEEP_DAYS } = await import("./preorder-notify-cleanup");

const NOW = new Date("2026-12-31T08:00:00.000Z");
// The cutoff is 2026-12-01T08:00:00.000Z.
const OLD = "2026-11-30T08:00:00.000Z"; // 31 days before NOW
const EDGE = "2026-12-01T08:00:00.000Z"; // exactly 30 days: kept
const DAY29 = "2026-12-02T08:00:00.000Z"; // 29 days before NOW: kept
const NEW = "2026-12-20T08:00:00.000Z";
// Realistic: a released pre-order KEEPS its release_date (audit r1 F1);
// it came out on that day at 08:00 Tirana (07:00 UTC in winter).
const OLD_DAY = "2026-11-30";
const DAY29_DAY = "2026-12-02";

function req(bookId: string, userId: string, over: Partial<Req> = {}): Req {
  return { book_id: bookId, user_id: userId, created_at: OLD, notified_at: null, book_cancelled_at: null, ...over };
}
const left = () => reqs.map((r) => `${r.book_id}/${r.user_id}`).sort();

beforeEach(() => {
  reqs = [];
  books = [];
  failOn = null;
  deleteCalls = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("deleteOldNotifyRequests", () => {
  it("keeps 30 days", () => {
    expect(NOTIFY_REQUEST_KEEP_DAYS).toBe(30);
  });

  it("1. deletes a request whose email went out more than 30 days ago, keeps a newer one", async () => {
    books = [{ id: "b1", status: "published", release_date: OLD_DAY, published_at: OLD }];
    reqs = [
      req("b1", "old", { notified_at: OLD }),
      req("b1", "edge", { notified_at: EDGE }),
      req("b1", "day29", { notified_at: DAY29 }),
      req("b1", "new", { notified_at: NEW }),
      req("b1", "cancel-sent", { notified_at: OLD, book_cancelled_at: OLD }),
    ];
    const counts = await deleteOldNotifyRequests(admin, NOW);
    expect(left()).toEqual(["b1/day29", "b1/edge", "b1/new"]);
    expect(counts.sent).toBe(2);
  });

  it("2. deletes a cancelled request never emailed 30 days after the cancel", async () => {
    books = [{ id: "b2", status: "draft", release_date: null, published_at: null }];
    reqs = [
      req("b2", "old", { book_cancelled_at: OLD }),
      req("b2", "edge", { book_cancelled_at: EDGE }),
      req("b2", "day29", { book_cancelled_at: DAY29 }),
      req("b2", "new", { book_cancelled_at: NEW }),
    ];
    const counts = await deleteOldNotifyRequests(admin, NOW);
    expect(left()).toEqual(["b2/day29", "b2/edge", "b2/new"]);
    expect(counts).toEqual({ sent: 0, cancelled: 1, released: 0 });
  });

  it("3. deletes a waiting request on a book that came out more than 30 days ago and is no pre-order now", async () => {
    books = [
      // Released pre-orders keep their release_date (audit r1 F1).
      { id: "down", status: "draft", release_date: OLD_DAY, published_at: OLD }, // taken down after release
      { id: "live", status: "published", release_date: OLD_DAY, published_at: OLD }, // never emailed
      // Final file approved at 00:30 Tirana on release day: 23:30 UTC the day before.
      { id: "early", status: "published", release_date: OLD_DAY, published_at: "2026-11-29T23:30:00.000Z" },
      { id: "edge", status: "published", release_date: "2026-12-01", published_at: EDGE },
      { id: "day29", status: "published", release_date: DAY29_DAY, published_at: DAY29 },
      { id: "recent", status: "published", release_date: "2026-12-20", published_at: NEW },
    ];
    reqs = [
      req("down", "u1"),
      req("live", "u2"),
      req("early", "u3"),
      req("edge", "u4"),
      req("day29", "u5"),
      req("recent", "u6"),
    ];
    const counts = await deleteOldNotifyRequests(admin, NOW);
    expect(left()).toEqual(["day29/u5", "edge/u4", "recent/u6"]);
    expect(counts.released).toBe(3);
  });

  it("never touches a live or paused pre-order, or a request made since the cutoff", async () => {
    books = [
      { id: "pre", status: "preorder", release_date: "2027-02-01", published_at: null },
      // A pre-order of a book that was out once (published_at kept).
      { id: "again", status: "preorder", release_date: "2027-02-01", published_at: OLD },
      // Paused by a suspension or a pending account deletion: draft, its
      // dates kept, never came out.
      { id: "paused", status: "draft", release_date: "2027-02-01", published_at: null },
      // The same, on a book that was out once (the app refuses this
      // listing; the database does not): its release day is after it came out.
      { id: "paused-again", status: "draft", release_date: "2027-02-01", published_at: OLD },
      { id: "fresh", status: "draft", release_date: null, published_at: OLD },
    ];
    reqs = [
      req("pre", "u1"),
      req("again", "u2"),
      req("paused", "u3"),
      req("paused-again", "u5"),
      req("fresh", "u4", { created_at: NEW }),
    ];
    const counts = await deleteOldNotifyRequests(admin, NOW);
    expect(left()).toEqual(["again/u2", "fresh/u4", "paused-again/u5", "paused/u3", "pre/u1"]);
    expect(counts).toEqual({ sent: 0, cancelled: 0, released: 0 });
  });

  it("a failed step reports null and the other steps still run; never throws", async () => {
    books = [{ id: "b", status: "draft", release_date: OLD_DAY, published_at: OLD }];
    reqs = [req("b", "sent", { notified_at: OLD }), req("b", "cancelled", { book_cancelled_at: OLD }), req("b", "stuck")];
    failOn = "delete:1";
    const counts = await deleteOldNotifyRequests(admin, NOW);
    expect(counts).toEqual({ sent: null, cancelled: 1, released: 1 });
    expect(left()).toEqual(["b/sent"]);
  });

  it("a failed read of step 3 deletes nothing there", async () => {
    books = [{ id: "b", status: "draft", release_date: OLD_DAY, published_at: OLD }];
    reqs = [req("b", "stuck")];
    failOn = "read";
    const counts = await deleteOldNotifyRequests(admin, NOW);
    expect(counts.released).toBeNull();
    expect(left()).toEqual(["b/stuck"]);
  });

  it("a thrown client is caught", async () => {
    const throwing = {
      from: () => {
        throw new Error("down");
      },
    } as never;
    await expect(deleteOldNotifyRequests(throwing, NOW)).resolves.toEqual({ sent: null, cancelled: null, released: null });
  });
});
