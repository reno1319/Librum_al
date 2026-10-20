import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHOR_TAKEDOWN_COLUMNS } from "./takedown-reasons";
import { getActiveTakedownState, loadAuthorTakedownNoticeForBook, loadAuthorTakedownNotices } from "./book-takedowns";

// ADMIN-2-TAKEDOWN (R1, G): the author-side reads. Every read of
// book_takedowns names exactly the granted columns (an author session
// gets 42501 for `*` or `id`), filters to the ACTIVE takedown, and the
// publish/delete gate fails closed on a read error.
type Result = { data: unknown; error: { code?: string; message: string } | null };
let results: Record<string, Result> = {};
const calls: { table: string; select: string; filters: [string, string, unknown][] }[] = [];

function client() {
  return {
    from(table: string) {
      const call = { table, select: "", filters: [] as [string, string, unknown][] };
      calls.push(call);
      const done = () => Promise.resolve(results[table] ?? { data: null, error: null });
      const chain = {
        select(cols: string) {
          call.select = cols;
          return chain;
        },
        eq(col: string, value: unknown) {
          call.filters.push(["eq", col, value]);
          return chain;
        },
        is(col: string, value: unknown) {
          call.filters.push(["is", col, value]);
          return chain;
        },
        in(col: string, value: unknown) {
          call.filters.push(["in", col, value]);
          return chain;
        },
        maybeSingle: done,
        returns: done,
      };
      return chain;
    },
  } as never;
}

const ROW = {
  book_id: "book-1",
  book_title: "Kënga e fundit",
  author_id: "author-1",
  reason: "copyright",
  message_to_author: "Send proof.",
  bundle_ids: ["bundle-1", "bundle-2"],
  taken_down_at: "2026-10-19T10:00:00Z",
  lifted_at: null,
};

describe("author takedown reads", () => {
  beforeEach(() => {
    results = {};
    calls.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("selects exactly the granted columns, for the active takedown only", async () => {
    await getActiveTakedownState(client(), "book-1");
    expect(calls[0]).toEqual({
      table: "book_takedowns",
      select: AUTHOR_TAKEDOWN_COLUMNS,
      filters: [
        ["eq", "book_id", "book-1"],
        ["is", "lifted_at", null],
      ],
    });
    expect(calls[0].select).not.toMatch(/\*|\bid\b/);
  });

  it("is none, active, or unavailable (fail closed) on a read error", async () => {
    expect(await getActiveTakedownState(client(), "book-1")).toEqual({ kind: "none" });
    results.book_takedowns = { data: ROW, error: null };
    expect(await getActiveTakedownState(client(), "book-1")).toEqual({ kind: "active", takedown: ROW });
    results.book_takedowns = { data: null, error: { code: "42501", message: "permission denied" } };
    expect(await getActiveTakedownState(client(), "book-1")).toEqual({ kind: "unavailable" });
  });

  it("builds the dashboard's notices with the bundle titles, by book", async () => {
    results.book_takedowns = { data: [ROW, { ...ROW, book_id: null }], error: null };
    results.public_bundles = { data: [{ id: "bundle-2", title: "Set B" }, { id: "bundle-1", title: "Set A" }], error: null };
    const notices = await loadAuthorTakedownNotices(client(), "author-1");
    expect([...notices.keys()]).toEqual(["book-1"]);
    expect(notices.get("book-1")).toEqual({
      takenDownAt: ROW.taken_down_at,
      reason: "copyright",
      message: "Send proof.",
      bundleTitles: ["Set A", "Set B"],
    });
    expect(calls[0].select).toBe(AUTHOR_TAKEDOWN_COLUMNS);
    expect(calls[0].filters).toEqual([
      ["eq", "author_id", "author-1"],
      ["is", "lifted_at", null],
    ]);
    // PEN-NAMES-2: bundle titles come from the account-free view.
    expect(calls[1]).toEqual({
      table: "public_bundles",
      select: "id, title",
      filters: [["in", "id", ["bundle-1", "bundle-2"]]],
    });
  });

  it("shows no notice when the read fails (the gate still refuses on its own)", async () => {
    results.book_takedowns = { data: null, error: { message: "boom" } };
    expect((await loadAuthorTakedownNotices(client(), "author-1")).size).toBe(0);
  });

  it("gives the Edit page the gate's state and the notice", async () => {
    results.book_takedowns = { data: { ...ROW, bundle_ids: [] }, error: null };
    const { state, notice } = await loadAuthorTakedownNoticeForBook(client(), "book-1");
    expect(state.kind).toBe("active");
    expect(notice?.bundleTitles).toEqual([]);
    expect(calls.some((c) => c.table === "public_bundles" || c.table === "bundles")).toBe(false);
  });
});
