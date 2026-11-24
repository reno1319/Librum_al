import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffRole } from "@/lib/types";

// G4 batch 3 (g4q8 a): the menu count bubbles' reads. The same filters
// as the Today tiles; each read only for a role that can open the page;
// zero and failed reads give no bubble.
type Call = { client: "session" | "admin"; kind: "rpc" | "from"; name: string; filters: string[] };
const calls: Call[] = [];
let answers: Record<string, { data?: unknown; count?: number | null; error?: unknown }> = {};

function chain(client: Call["client"], name: string) {
  const call: Call = { client, kind: "from", name, filters: [] };
  calls.push(call);
  const builder = {
    select: (_cols: string, opts: unknown) => {
      call.filters.push(`select:${JSON.stringify(opts)}`);
      return builder;
    },
    eq: (col: string, value: unknown) => {
      call.filters.push(`eq:${col}=${String(value)}`);
      return builder;
    },
    not: (col: string, op: string, value: unknown) => {
      call.filters.push(`not:${col} ${op} ${String(value)}`);
      return builder;
    },
    then: (resolve: (v: unknown) => void) => resolve({ error: null, count: null, ...answers[name] }),
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => chain("session", table),
    rpc: async (fn: string, args?: unknown) => {
      calls.push({ client: "session", kind: "rpc", name: fn, filters: args ? [JSON.stringify(args)] : [] });
      return { data: null, error: null, ...answers[fn] };
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (table: string) => chain("admin", table) }) }));

const { loadAdminNavCounts, buildNavCounts } = await import("./admin-nav-counts");

const feedbackRow = (id: string) => ({
  id,
  kind: "idea",
  body: "x",
  page_path: "/",
  sender_email: null,
  created_at: "2026-11-15T17:40:00Z",
  done_at: null,
});

beforeEach(() => {
  calls.length = 0;
  answers = {
    staff_list_pending_reader_reviews: { data: [{}, {}, {}] },
    book_reports: { count: 2 },
    staff_list_reader_feedback: { data: [feedbackRow("f1")] },
    refund_requests: { count: 1 },
    book_reviews: { count: 5 },
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadAdminNavCounts", () => {
  it("owner: all five counts, with the Today tiles' filters", async () => {
    expect(await loadAdminNavCounts("owner")).toEqual({
      "/admin/reader-reviews": 3,
      "/admin/reports": 2,
      "/admin/feedback": 1,
      "/admin/refunds": 1,
      "/admin/books": 5,
    });
    const byName = Object.fromEntries(calls.map((c) => [c.name, c]));
    expect(byName.book_reports.filters).toContain("eq:status=open");
    expect(byName.refund_requests.filters).toContain("eq:status=requested");
    expect(byName.staff_list_reader_feedback.filters).toEqual([JSON.stringify({ p_status: "open" })]);
    expect(byName.book_reviews).toMatchObject({ client: "admin" });
    expect(byName.book_reviews.filters).toEqual(
      expect.arrayContaining(["eq:status=pending", "not:book_id is null"]),
    );
    // Counts only: the table reads ask for no rows.
    expect(byName.book_reports.filters).toContain(`select:${JSON.stringify({ count: "exact", head: true })}`);
  });

  it.each<[StaffRole, string[]]>([
    ["admin", ["/admin/reader-reviews", "/admin/reports", "/admin/feedback", "/admin/refunds", "/admin/books"]],
    // A moderator sees Books but cannot review a book: no Books bubble.
    ["moderator", ["/admin/reader-reviews", "/admin/reports", "/admin/feedback"]],
    ["support", ["/admin/refunds"]],
    ["editor", []],
  ])("%s: only the pages that role can open, and no other read", async (role, hrefs) => {
    expect(Object.keys(await loadAdminNavCounts(role)).sort()).toEqual([...hrefs].sort());
    expect(calls).toHaveLength(hrefs.length);
  });

  it("hides zero and failed reads", async () => {
    answers.book_reports = { count: 0 };
    answers.refund_requests = { count: null, error: { code: "42501" } };
    answers.staff_list_pending_reader_reviews = { data: null, error: { code: "42501" } };
    const counts = await loadAdminNavCounts("owner");
    expect(counts).toEqual({ "/admin/feedback": 1, "/admin/books": 5 });
  });
});

describe("buildNavCounts", () => {
  it("keeps whole positive numbers only", () => {
    expect(buildNavCounts([["/a", 3], ["/b", 0], ["/c", null], ["/d", -1], ["/e", 1.5]])).toEqual({ "/a": 3 });
  });
});
