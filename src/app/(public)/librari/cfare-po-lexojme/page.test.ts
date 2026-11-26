import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// LR1 patch 4 (lb3 a, lr4-2 a, lr4-3 a): Libraria's "Më shumë" page of
// picks, rendered against a small in-memory double.
type Row = Record<string, unknown>;

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("CREATE_CLIENT_CALLED");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("ADMIN_CLIENT_CALLED"); } }));

const { default: ReadingPicksPage, metadata } = await import("./page");

function tableStub(rows: Row[]) {
  let result = [...rows];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, value: unknown) => ((result = result.filter((r) => r[col] === value)), builder),
    is: (col: string, value: unknown) => ((result = result.filter((r) => (r[col] ?? null) === value)), builder),
    in: (col: string, values: unknown[]) => ((result = result.filter((r) => values.includes(r[col]))), builder),
    order: (col: string, opts?: { ascending?: boolean }) =>
      ((result = [...result].sort((a, b) =>
        opts?.ascending ? String(a[col]).localeCompare(String(b[col])) : String(b[col]).localeCompare(String(a[col])),
      )),
      builder),
    limit: (n: number) => ((result = result.slice(0, n)), builder),
    returns: () => builder,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: result, error: null }),
  };
  return builder;
}

function failing() {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "order", "limit", "returns"]) builder[m] = () => builder;
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "boom" } });
  return builder;
}

function book(n: number, priceAll: number, extra: Row = {}): Row {
  const d = String(n).padStart(2, "0");
  return {
    id: `book-${d}`, title: `Book ${d}`, status: "published", price_all: priceAll, cover_path: null,
    pen_name_id: "pen-1", original_author: null, is_adult: false, pen: { id: "pen-1", name: "An Author" }, ...extra,
  };
}

function pick(n: number, bookId: string, publishedAt: string, extra: Row = {}): Row {
  return {
    id: `pick-${n}`, book_id: bookId, badge: "Zgjedhja e Librum", note: `Note ${n}.`, quote: `Quote ${n}.`,
    quote_from: "book", published_at: publishedAt, ...extra,
  };
}

let pickRows: Row[] = [];
let failPicks = false;
let signedInUser: { id: string } | null = null;
let cartRows: Row[] = [];
const bookRows: Row[] = [book(1, 299), book(2, 0), book(3, 199, { is_adult: true })];

describe("ReadingPicksPage", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    pickRows = [];
    failPicks = false;
    signedInUser = null;
    cartRows = [];
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(() => ({
      auth: { getUser: () => Promise.resolve({ data: { user: signedInUser } }) },
      from: (table: string) => {
        if (table === "public_libraria_reading_picks") return failPicks ? failing() : tableStub(pickRows);
        return tableStub(
          table === "public_books" ? bookRows : table === "cart_items" ? cartRows : [],
        );
      },
      rpc: () => Promise.resolve({ data: false, error: null }),
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/c.png" } }) }) },
    }));
  });
  afterEach(() => vi.unstubAllEnvs());

  async function render() {
    const element = await ReadingPicksPage();
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  it("has its own title", () => {
    expect(metadata.title).toBe("Çfarë po lexojmë");
  });

  it("maintenance mode: the notice and no Supabase call", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    expect(await render()).toContain("Mirëmbajtje e planifikuar");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("every pick, newest first, each with its month (Tirana) and the full box (lr4-2 a)", async () => {
    pickRows = [
      pick(1, "book-01", "2026-09-20T09:00:00Z"),
      pick(2, "book-02", "2026-10-31T23:30:00Z", { quote_from: "author", badge: null }),
      pick(3, "book-03", "2026-11-24T09:00:00Z"),
    ];
    const html = await render();
    expect(html).toContain(">Çfarë po lexojmë</h1>");
    expect(html).toContain('href="/librari"');
    const order = ["Note 3.", "Note 2.", "Note 1."].map((t) => html.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain("Nëntor 2026");
    // 31 Oct 23:30 UTC is already 1 November in Tirana.
    expect(html.match(/Nëntor 2026/g)?.length).toBe(2);
    expect(html).toContain("Shtator 2026");
    expect(html).toContain("autori i librit");
    expect(html).toContain("nga <i>Book 01</i>");
    expect(html).toContain("Merre falas");
    // lr4-5 b: no 18+ tag on an adult pick.
    expect(html).not.toContain("18+");
    expect(html.match(/<h2/g)?.length).toBe(3);
  });

  it("a pick whose book can't be read is skipped (lr4-3 a)", async () => {
    pickRows = [pick(1, "book-01", "2026-09-20T09:00:00Z"), pick(2, "book-gone", "2026-10-20T09:00:00Z")];
    const html = await render();
    expect(html).toContain("Note 1.");
    expect(html).not.toContain("Note 2.");
  });

  it("no picks, or a failed read: an empty page with a way back", async () => {
    expect(await render()).toContain("Ende nuk ka zgjedhje.");
    pickRows = [pick(1, "book-01", "2026-09-20T09:00:00Z")];
    failPicks = true;
    const html = await render();
    expect(html).toContain("Ende nuk ka zgjedhje.");
    expect(html).toContain("Kthehu te Libraria");
  });

  it("a signed-in reader with the book in the cart sees Në shportë", async () => {
    signedInUser = { id: "reader-1" };
    cartRows = [{ reader_id: "reader-1", book_id: "book-01", gift_email: null }];
    pickRows = [pick(1, "book-01", "2026-09-20T09:00:00Z")];
    expect(await render()).toContain("Në shportë");
  });
});
