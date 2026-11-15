import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// K8 + K10 (Renato 11-15): the marks route. A fake Supabase client
// records every call, so each test proves what was (and was not) read or
// written, and that nothing uses the service key.

let recoveryActive = false;
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: (name: string) => (name === RECOVERY_COOKIE_NAME && recoveryActive ? { value: "1" } : undefined) }),
}));
const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

import { GET, HEAD, POST } from "./route";

const BOOK = "b0000000-0000-4000-8000-000000000003";
const HL = "c0000000-0000-4000-8000-000000000001";
type Result = { data: unknown; error: { code?: string; message?: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });

let calls: string[];
let user: { id: string } | null;
let owns: Result;
// What each table call answers, in order.
let answers: Record<string, Result[]>;

function chain(table: string) {
  const next = () => (answers[table]?.length ? answers[table].shift()! : ok(null));
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "order"]) {
    q[m] = (...a: unknown[]) => {
      calls.push(`${table}.${m}(${a.map((x) => JSON.stringify(x)).join(",")})`);
      return q;
    };
  }
  for (const m of ["insert", "update", "upsert", "delete"]) {
    q[m] = (...a: unknown[]) => {
      calls.push(`${table}.${m}(${a.map((x) => JSON.stringify(x)).join(",")})`);
      return q;
    };
  }
  q.maybeSingle = () => Promise.resolve(next());
  q.single = () => Promise.resolve(next());
  q.then = (res: (r: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next()).then(res, rej);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  recoveryActive = false;
  calls = [];
  user = { id: "a0000000-0000-4000-8000-000000000009" };
  owns = ok(true);
  answers = {};
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: () => Promise.resolve({ data: { user }, error: null }) },
    from: (table: string) => chain(table),
    rpc: (fn: string, args: unknown) => {
      calls.push(`rpc.${fn}(${JSON.stringify(args)})`);
      return Promise.resolve(fn === "user_owns_book" ? owns : (answers[`rpc.${fn}`]?.shift() ?? ok(null)));
    },
  }));
});

const ctx = (id = BOOK) => ({ params: Promise.resolve({ id }) });
const get = (id = BOOK) => GET(new Request(`https://librum.test/api/books/${id}/marks`), ctx(id));
const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  POST(new Request(`https://librum.test/api/books/${BOOK}/marks`, { method: "POST", headers, body: JSON.stringify(body) }), ctx());
const wrote = () => calls.some((c) => /\.(insert|update|upsert|delete)\(|rpc\.reader_highlights_reanchor/.test(c));

describe("/api/books/[id]/marks gates", () => {
  it("answers only GET and POST", () => {
    expect(HEAD().status).toBe(405);
  });
  it("a recovery session, no user, a bad id: refused before any read", async () => {
    recoveryActive = true;
    expect((await get()).status).toBe(403);
    recoveryActive = false;
    user = null;
    expect((await get()).status).toBe(401);
    expect((await get("not-a-uuid")).status).toBe(404);
    expect(calls.filter((c) => !c.startsWith("rpc.user_owns_book"))).toEqual([]);
  });
  it("Q4 a: someone who doesn't own the book (the author too) gets 403 and nothing", async () => {
    owns = ok(false);
    expect((await get()).status).toBe(403);
    expect((await post({ op: "bookmark_add", offset: 5 })).status).toBe(403);
    expect(wrote()).toBe(false);
    owns = { data: null, error: { code: "XX000" } };
    expect((await get()).status).toBe(503);
  });
  it("never uses the service key", async () => {
    await get();
    await post({ op: "bookmark_add", offset: 5 });
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });
  it("POST takes JSON only and refuses another site", async () => {
    expect((await post({ op: "bookmark_add", offset: 5 }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ op: "bookmark_add", offset: 5 }, { "content-type": "application/json", origin: "https://evil.test" })).status).toBe(403);
    expect((await post({ op: "copy" })).status).toBe(400);
    expect(wrote()).toBe(false);
    answers = { reader_bookmarks: [ok({ id: HL })] };
    expect((await post({ op: "bookmark_add", offset: 5 }, { "content-type": "application/json", origin: "https://librum.test" })).status).toBe(200);
  });
});

describe("GET", () => {
  it("returns the place, bookmarks and highlights of this book (no-store)", async () => {
    answers = {
      reading_places: [ok({ char_offset: 120, progress: "0.2500", updated_at: "2026-11-15T10:00:00Z" })],
      reader_bookmarks: [ok([{ id: HL, char_offset: 7 }])],
      reader_highlights: [
        ok([{ id: HL, start_offset: 1, end_offset: 3, quote: "ab", prefix: "", suffix: "", color: "pink", note: null, orphaned_at: null }]),
      ],
    };
    const res = await get();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      place: { offset: 120, progress: 0.25, updatedAt: "2026-11-15T10:00:00Z" },
      bookmarks: [{ id: HL, offset: 7 }],
      highlights: [{ id: HL, start: 1, end: 3, quote: "ab", prefix: "", suffix: "", color: "pink", note: null, orphaned: false }],
    });
    expect(calls.filter((c) => c.includes(".eq(")).every((c) => c.includes(`"book_id","${BOOK}"`))).toBe(true);
  });
  it("a failed read is 503", async () => {
    answers = { reader_bookmarks: [{ data: null, error: { code: "XX000" } }] };
    expect((await get()).status).toBe(503);
  });
});

describe("POST", () => {
  it("place: updates the row, else inserts it; answers the server time", async () => {
    answers = { reading_places: [ok([]), ok({ updated_at: "2026-11-15T11:00:00Z" })] };
    const res = await post({ op: "place", offset: 300, progress: 0.3 });
    expect(await res.json()).toEqual({ updatedAt: "2026-11-15T11:00:00Z" });
    expect(calls.some((c) => c.startsWith("reading_places.update("))).toBe(true);
    expect(calls.some((c) => c.startsWith(`reading_places.insert({"book_id":"${BOOK}","char_offset":300,"progress":0.3`))).toBe(true);
    expect(calls.some((c) => c.includes("upsert"))).toBe(false);
  });
  it("place: an existing row is only updated", async () => {
    answers = { reading_places: [ok([{ updated_at: "2026-11-15T12:00:00Z" }])] };
    expect(await (await post({ op: "place", offset: 1, progress: 0 })).json()).toEqual({ updatedAt: "2026-11-15T12:00:00Z" });
    expect(calls.some((c) => c.startsWith("reading_places.insert("))).toBe(false);
  });
  it("the per-book limit reads as 409 limit", async () => {
    answers = { reader_highlights: [{ data: null, error: { code: "23514", message: "reader_marks_limit" } }] };
    const res = await post({ op: "highlight_add", start: 1, end: 3, quote: "ab", prefix: "", suffix: "", color: "blue" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "limit" });
  });
  it("another check failure is 503, not 409", async () => {
    answers = { reader_highlights: [{ data: null, error: { code: "23514", message: "reader_highlights_note_check" } }] };
    expect((await post({ op: "highlight_add", start: 1, end: 3, quote: "ab", prefix: "", suffix: "", color: "blue" })).status).toBe(503);
  });
  it("the same page bookmarked twice answers the existing bookmark", async () => {
    answers = { reader_bookmarks: [{ data: null, error: { code: "23505" } }, ok({ id: HL })] };
    expect(await (await post({ op: "bookmark_add", offset: 5 })).json()).toEqual({ id: HL });
  });
  it("highlight_update writes only colour/note (+ time), scoped to the book; a missing row is 404", async () => {
    answers = { reader_highlights: [ok([{ id: HL }]), ok([])] };
    expect((await post({ op: "highlight_update", id: HL, note: "Shënim" })).status).toBe(200);
    const upd = calls.find((c) => c.startsWith("reader_highlights.update("))!;
    expect(Object.keys(JSON.parse(upd.slice("reader_highlights.update(".length, -1))).sort()).toEqual(["note", "updated_at"]);
    expect((await post({ op: "highlight_update", id: HL, color: "green" })).status).toBe(404);
  });
  it("reanchor is one call to the reader's own function", async () => {
    expect((await post({ op: "reanchor", moves: [{ id: HL, start: 4, end: 6 }], orphaned: [] })).status).toBe(200);
    expect(calls).toContain(
      `rpc.reader_highlights_reanchor(${JSON.stringify({ p_book_id: BOOK, p_moves: [{ id: HL, start_offset: 4, end_offset: 6 }], p_orphaned: [] })})`,
    );
  });
  it("removes are scoped to the book", async () => {
    await post({ op: "highlight_remove", id: HL });
    await post({ op: "bookmark_remove", ids: [HL] });
    expect(calls).toContain(`reader_highlights.eq("book_id","${BOOK}")`);
    expect(calls).toContain(`reader_bookmarks.eq("book_id","${BOOK}")`);
  });
});
