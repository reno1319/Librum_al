import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// G4 batch 3 (g4q9 a, b3e3 a): the four site totals, counts only.
const filters: Record<string, string[]> = {};
let answers: Record<string, { count?: number | null; error?: unknown }> = {};
let peopleAnswer: Record<string, { data: unknown; error: unknown }> = {};
const peopleCalls: unknown[] = [];

function chain(table: string) {
  filters[table] = [];
  const builder = {
    select: (cols: string, opts: unknown) => {
      filters[table].push(`select:${cols}:${JSON.stringify(opts)}`);
      return builder;
    },
    eq: (col: string, v: unknown) => (filters[table].push(`eq:${col}=${String(v)}`), builder),
    gt: (col: string, v: unknown) => (filters[table].push(`gt:${col}=${String(v)}`), builder),
    is: (col: string, v: unknown) => (filters[table].push(`is:${col}=${String(v)}`), builder),
    then: (resolve: (v: unknown) => void) => resolve({ error: null, count: null, ...answers[table] }),
  };
  return builder;
}

const mockRequireStaff = vi.fn((_p: string) => Promise.resolve({ userId: "u", role: "admin" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (p: string) => mockRequireStaff(p) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: chain }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: { p_kind: string }) => {
      peopleCalls.push([fn, args]);
      return peopleAnswer[args.p_kind];
    },
  }),
}));

const { SiteTotals, loadSiteTotals, formatSiteTotal, SITE_TOTALS_NOTE } = await import("./site-totals");

beforeEach(() => {
  mockRequireStaff.mockClear();
  peopleCalls.length = 0;
  answers = { books: { count: 24 }, purchases: { count: 362 } };
  peopleAnswer = {
    authors: { data: [{ total_count: 31 }], error: null },
    readers: { data: [{ total_count: "1284" }], error: null },
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("site totals", () => {
  it("live books = published; sales = paid and not refunded; people = the People page totals", async () => {
    expect(await loadSiteTotals()).toEqual({ liveBooks: 24, authors: 31, readers: 1284, sales: 362 });
    expect(mockRequireStaff.mock.calls.map((c) => c[0])).toEqual(["people.view", "finance.view"]);
    expect(filters.books).toEqual(['select:id:{"count":"exact","head":true}', "eq:status=published"]);
    expect(filters.purchases).toEqual([
      'select:id:{"count":"exact","head":true}',
      "gt:amount_cents=0",
      "is:refunded_at=null",
    ]);
    expect(peopleCalls).toEqual([
      ["admin_list_people", { p_kind: "authors", p_limit: 1 }],
      ["admin_list_people", { p_kind: "readers", p_limit: 1 }],
    ]);
  });

  it("no account of a kind is 0; a failed read is a dash for that number only", async () => {
    peopleAnswer.authors = { data: [], error: null };
    answers.purchases = { error: { code: "42501" } };
    expect(await loadSiteTotals()).toEqual({ liveBooks: 24, authors: 0, readers: 1284, sales: null });
    expect(formatSiteTotal(null)).toBe("—");
    expect(formatSiteTotal(1284)).toBe("1,284");
  });

  it("renders the card as pictured: four labels, the numbers and the note", async () => {
    const html = renderToStaticMarkup((await SiteTotals()) as ReactElement);
    for (const text of ["Site totals", "Live books", "Authors", "Readers", "Sales", "1,284", "362", SITE_TOTALS_NOTE]) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/lek|ALL|€/);
  });
});
