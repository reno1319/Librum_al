import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// CSV-1 (idea 35): GET /admin/finance/export -- every author's ledger
// moves for owner/admin (finance.view), with no buyer and no tax data.

class StaffRedirect extends Error {}
const mockRequireStaff = vi.fn(async (_permission: string) => ({ userId: "staff-1", role: "admin" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

type Page = { data: unknown; error: unknown };
let pages: Page[];
const reads: { table: string; columns: string; orders: string[]; range: [number, number] }[] = [];
const mockCreateAdminClient = vi.fn(() => ({
  from: (table: string) => {
    const call = { table, columns: "", orders: [] as string[], range: [0, 0] as [number, number] };
    const chain = {
      select: (columns: string) => ((call.columns = columns), chain),
      order: (column: string, options: { ascending: boolean }) => (
        call.orders.push(`${column}.${options.ascending ? "asc" : "desc"}`), chain
      ),
      range: (from: number, to: number) => ((call.range = [from, to]), chain),
      returns: async () => (reads.push(call), pages.shift() ?? { data: [], error: null }),
    };
    return chain;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const { GET } = await import("./route");

function row(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `e${i}`,
    entry_type: "sale",
    amount_minor: 35000,
    currency: "ALL",
    gross_amount_minor: 50000,
    librum_amount_minor: 15000,
    royalty_rate_bps: 7000,
    created_at: "2026-11-26T10:00:00Z",
    author: { display_name: "Arta Provë" },
    purchase: { book: { title: "Lumi i heshtur", pen_name: { name: "A. T. Hija" } } },
    ...overrides,
  };
}

beforeEach(() => {
  mockRequireStaff.mockReset().mockResolvedValue({ userId: "staff-1", role: "admin" });
  mockCreateAdminClient.mockClear();
  pages = [];
  reads.length = 0;
  delete process.env.ALL_CUTOVER_MAINTENANCE_MODE;
});

describe("GET /admin/finance/export", () => {
  it("requires finance.view before creating the service-role client", async () => {
    mockRequireStaff.mockRejectedValue(new StaffRedirect());
    await expect(GET()).rejects.toBeInstanceOf(StaffRedirect);
    expect(mockRequireStaff).toHaveBeenCalledWith("finance.view");
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("returns a never-cached CSV of every author's moves, with the author's name", async () => {
    pages = [
      {
        data: [
          row(0),
          row(1, {
            entry_type: "payout",
            amount_minor: -150000,
            gross_amount_minor: null,
            librum_amount_minor: null,
            royalty_rate_bps: null,
            author: { display_name: "=cmd" },
            purchase: null,
          }),
        ],
        error: null,
      },
    ];
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="librum-te-gjitha-shitjet-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(await response.arrayBuffer()));
    expect(text.startsWith("\uFEFF")).toBe(true);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe("Data,Autori,Pseudonimi,Lloji,Libri,Çmimi i paguar,Pjesa e Librum,Pjesa e autorit,%,Monedha");
    expect(lines[1]).toBe("2026-11-26,Arta Provë,A. T. Hija,Shitje,Lumi i heshtur,500,150,350,70,ALL");
    expect(lines[2]).toBe("2026-11-26,'=cmd,,Pagesë për autorin,,,,-1500,,ALL");
  });

  it("reads only named ledger columns, the author's display name and the book title -- no buyer, ids or tax data", async () => {
    pages = [{ data: [row(0)], error: null }];
    await GET();
    expect(reads).toHaveLength(1);
    expect(reads[0].table).toBe("author_ledger_entries");
    const columns = reads[0].columns;
    expect(columns).not.toContain("*");
    for (const forbidden of ["reader_id", "payment_id", "payout_id", "provider", "reference", "nid", "tax", "email", "iban"]) {
      expect(columns.toLowerCase()).not.toContain(forbidden);
    }
    expect(columns).toContain("author:profiles!author_id(display_name)");
    expect(columns).toContain("purchase:purchases!purchase_id(book:books!book_id(title, pen_name:pen_names!books_pen_name_id_fkey(name)))");
    expect(reads[0].orders).toEqual(["created_at.desc", "id.desc"]);
  });

  it("pages through the ledger 1000 rows at a time until a short page", async () => {
    pages = [
      { data: Array.from({ length: 1000 }, (_, i) => row(i)), error: null },
      { data: [row(1000)], error: null },
    ];
    const text = await (await GET()).text();
    expect(reads.map((r) => r.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(text.trimEnd().split("\r\n")).toHaveLength(1002);
  });

  it("a failed read is a plain error, never a partial file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    pages = [
      { data: Array.from({ length: 1000 }, (_, i) => row(i)), error: null },
      { data: null, error: { code: "57014", message: "timeout" } },
    ];
    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Couldn't build the file. Please try again.");
  });

  it("refuses a file over the row limit instead of cutting it short", async () => {
    pages = Array.from({ length: 31 }, () => ({ data: Array.from({ length: 1000 }, (_, i) => row(i)), error: null }));
    const response = await GET();
    expect(response.status).toBe(413);
  });

  it("maintenance mode answers 503 before requireStaff or any read", async () => {
    process.env.ALL_CUTOVER_MAINTENANCE_MODE = "active";
    const response = await GET();
    expect(response.status).toBe(503);
    expect(mockRequireStaff).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("calls requireStaff outside any try block (its redirect must not be swallowed)", () => {
    const source = readFileSync(path.join(__dirname, "route.ts"), "utf8");
    const gate = source.indexOf('await requireStaff("finance.view");');
    expect(gate).toBeGreaterThan(-1);
    expect(source.slice(0, gate)).not.toContain("try {");
  });
});
