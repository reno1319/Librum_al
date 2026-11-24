import { beforeEach, describe, expect, it, vi } from "vitest";

// LBN (lbnq9 a): /lbn/<code> sends a live book's visitors to its page and
// shows "not found" for everything else.
const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
  redirect: (to: string) => {
    redirects.push(to);
    throw new Error("NEXT_REDIRECT");
  },
}));

type Call = { table: string; select?: string; eq: [string, unknown][]; inList: [string, unknown[]][] };
let calls: Call[] = [];
let result: { data: unknown; error: unknown } = { data: null, error: null };
const mockCreateClient = vi.fn(async () => ({
  from(table: string) {
    const call: Call = { table, eq: [], inList: [] };
    calls.push(call);
    const q = {
      select(cols: string) {
        call.select = cols;
        return q;
      },
      eq(col: string, value: unknown) {
        call.eq.push([col, value]);
        return q;
      },
      in(col: string, values: unknown[]) {
        call.inList.push([col, values]);
        return q;
      },
      maybeSingle: async () => result,
    };
    return q;
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: LbnPage } = await import("./page");
const BOOK = "b0000000-0000-4000-8000-000000000001";
const open = (code: string) => LbnPage({ params: Promise.resolve({ code }) });

describe("/lbn/<code>", () => {
  beforeEach(() => {
    calls = [];
    redirects.length = 0;
    result = { data: null, error: null };
    mockCreateClient.mockClear();
  });

  it("sends a live book's LBN to its book page, looking up only live books", async () => {
    result = { data: { id: BOOK }, error: null };
    await expect(open("LE7K4M9X2D")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects).toEqual([`/libra/${BOOK}`]);
    expect(calls).toEqual([
      { table: "public_books", select: "id", eq: [["lbn", "LE7K4M9X2D"]], inList: [["status", ["published", "preorder"]]] },
    ]);
  });

  it("accepts small letters (and an encoded space around it)", async () => {
    result = { data: { id: BOOK }, error: null };
    await expect(open("le7k4m9x2d")).rejects.toThrow("NEXT_REDIRECT");
    await expect(open("%20LE7K4M9X2D")).rejects.toThrow("NEXT_REDIRECT");
    expect(calls.map((c) => c.eq)).toEqual([[["lbn", "LE7K4M9X2D"]], [["lbn", "LE7K4M9X2D"]]]);
  });

  it("not found, without a database read, for a code that is not a valid LBN", async () => {
    for (const code of ["LE7K4M9X2E", "LE7K4M9X2", BOOK, "%E0%A4%A", "x"]) {
      await expect(open(code)).rejects.toBe(NOT_FOUND);
    }
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("not found when no live book has it, or the read fails", async () => {
    await expect(open("LE7K4M9X2D")).rejects.toBe(NOT_FOUND);
    result = { data: null, error: { code: "57014" } };
    await expect(open("LE7K4M9X2D")).rejects.toBe(NOT_FOUND);
    expect(redirects).toEqual([]);
  });
});
