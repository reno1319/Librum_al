import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// CSV-1 (idea 35): GET /dashboard/balance/export -- the signed-in
// author's own ledger as a CSV, read only through the RPC that derives
// the author from auth.uid().

class Redirect extends Error {
  constructor(public url: string) {
    super(url);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));

let user: { id: string } | null;
let pages: { data: unknown; error: unknown }[];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return pages.shift() ?? { data: [], error: null };
    },
    from: () => {
      throw new Error("no table reads allowed");
    },
  }),
}));

const { GET } = await import("./route");

function row(i: number) {
  return {
    id: `e${i}`,
    entry_type: "sale",
    amount_minor: 35000,
    currency: "ALL",
    gross_amount_minor: 50000,
    librum_amount_minor: 15000,
    royalty_rate_bps: 7000,
    available_at: null,
    created_at: new Date(Date.UTC(2026, 10, 26) - i * 60000).toISOString(),
    book_id: "b1",
    book_title: "Lumi i heshtur",
  };
}

const call = (url = "https://librum.example/dashboard/balance/export") => GET(new Request(url));

beforeEach(() => {
  user = { id: "author-1" };
  pages = [];
  rpcCalls.length = 0;
  delete process.env.ALL_CUTOVER_MAINTENANCE_MODE;
});

describe("GET /dashboard/balance/export", () => {
  it("sends a signed-out visitor to sign in, without reading anything", async () => {
    user = null;
    await expect(call()).rejects.toEqual(new Redirect("/login?next=/dashboard/balance"));
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns a never-cached CSV attachment of the author's rows", async () => {
    pages = [{ data: [row(0)], error: null }];
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="librum-bilanci-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("Data,Lloji,Libri,Çmimi i paguar,Pjesa e Librum,Pjesa juaj,%,Monedha\r\n");
    expect(text).toContain("2026-11-26,Shitje,Lumi i heshtur,500,150,350,70,ALL\r\n");
  });

  it("only ever calls list_author_financial_activity, with no author id, ignoring the URL", async () => {
    pages = [{ data: [row(0)], error: null }];
    await call("https://librum.example/dashboard/balance/export?author_id=someone-else");
    expect(rpcCalls).toEqual([
      { fn: "list_author_financial_activity", args: { p_limit: 100, p_cursor_created_at: null, p_cursor_id: null } },
    ]);
  });

  it("follows the RPC's cursor until a short page, so the file has every row", async () => {
    const first = Array.from({ length: 100 }, (_, i) => row(i));
    pages = [
      { data: first, error: null },
      { data: [row(100), row(101)], error: null },
    ];
    const response = await call();
    const text = await response.text();
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[1].args).toEqual({
      p_limit: 100,
      p_cursor_created_at: first[99].created_at,
      p_cursor_id: "e99",
    });
    expect(text.trimEnd().split("\r\n")).toHaveLength(103);
  });

  it("a failed read sends the author back to Bilanci with a message, never a partial file", async () => {
    pages = [
      { data: Array.from({ length: 100 }, (_, i) => row(i)), error: null },
      { data: null, error: { message: "boom" } },
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call();
    expect(response.status).toBe(307);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toBe(
      "https://librum.example/dashboard/balance?error=Skedari nuk u krijua. Provoni përsëri.",
    );
  });

  it("refuses a file over the row limit instead of cutting it short", async () => {
    pages = Array.from({ length: 301 }, () => ({ data: Array.from({ length: 100 }, (_, i) => row(i)), error: null }));
    const response = await call();
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
      "?error=Ka shumë lëvizje për një skedar. Na shkruani te support@librum.al.",
    );
    expect(rpcCalls.length).toBeLessThanOrEqual(301);
  });

  it("maintenance mode redirects before any Supabase call", async () => {
    process.env.ALL_CUTOVER_MAINTENANCE_MODE = "active";
    await expect(call()).rejects.toBeInstanceOf(Redirect);
    expect(rpcCalls).toHaveLength(0);
  });

  it("never uses the service-role client", () => {
    const source = readFileSync(path.join(__dirname, "route.ts"), "utf8");
    expect(source).not.toContain("createAdminClient");
    expect(source).not.toContain("@/lib/supabase/admin");
  });
});
