import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Amazon book page, patch 4 (items 2 + 7; bp6 a, bp8 a, rk1 b, rk2 a,
// rk3 a): the "Nr. 1 në ..." and "Zgjedhja e Librum" badges under the
// title and the "Renditja" line in the details. Rendered from the real
// page over a stubbed Supabase: the ranks come from the admin client's
// book_sales_ranks, the pick from public_libraria_reading_picks.

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("createClient not stubbed");
});
let rankRpc: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }> = async () => ({ data: [], error: null });
const rpcCalls: { name: string; args: unknown }[] = [];
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async () => ({ data: null }) }),
    rpc: (name: string, args: unknown) => (rpcCalls.push({ name, args }), rankRpc(name, args)),
  }),
}));
vi.mock("../../shporta/actions", () => ({
  addToCart: vi.fn(), saveGift: vi.fn(), removeFromCart: vi.fn(), pressPay: vi.fn(), addToCartFromLibraria: vi.fn(),
}));
vi.mock("./actions", () => ({
  buyBook: vi.fn(), getFreeBook: vi.fn(), submitReview: vi.fn(),
  addToWishlist: vi.fn(), removeFromWishlist: vi.fn(),
}));

const { default: BookDetailPage } = await import("./page");

const BOOK_ID = "11111111-1111-4111-8111-111111111111";
const PEN = { id: "pen-an-author", name: "An Author", bio: "Bio.", avatar_path: null, links: [] };
const BOOK = {
  id: BOOK_ID, title: "Test Book", price_all: 250, author_id: "author",
  status: "published", cover_path: null, series_id: null, genre: "Romancë",
  categories: ["Romancë", "Histori"], description: "About it.", language: null,
  created_at: "2026-09-01T00:00:00Z", published_at: "2026-09-02T00:00:00Z",
  pen_name_id: PEN.id, pen: PEN,
};

type Options = { picks?: unknown[] | "error"; pickThrows?: boolean };
const pickCalls: { method: string; args: unknown[] }[] = [];

function stub(table: string, opts: Options) {
  let single = false;
  const resolve = () => {
    if (table === "public_books" && single) {
      const publicPart: Record<string, unknown> = { ...BOOK };
      delete publicPart.author_id;
      return { data: publicPart };
    }
    if (table === "public_libraria_reading_picks") {
      if (opts.pickThrows) throw new Error("network");
      return opts.picks === "error" ? { data: null, error: { message: "x" } } : { data: opts.picks ?? [], error: null };
    }
    return { data: single ? null : [], count: 0 };
  };
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (done: (v: unknown) => unknown, fail: (e: unknown) => unknown) => {
        try { return done(resolve()); } catch (e) { return fail(e); }
      };
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return (...args: unknown[]) => {
        if (table === "public_libraria_reading_picks") pickCalls.push({ method: String(prop), args });
        return chain;
      };
    },
  });
  return chain;
}

async function render(opts: Options = {}) {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    rpc: async () => ({ data: null }),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => stub(table, opts),
  }));
  const element = await BookDetailPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

const ranks = (...rows: [string | null, number][]) => async () => ({
  data: rows.map(([category, sales_rank], i) => ({ category, sales_rank, sort_order: i })),
  error: null,
});
const badges = (html: string) => {
  const m = html.match(/<p data-title-badges=""[^>]*>([\s\S]*?)<\/p>/);
  return m ? m[1].replace(/<[^>]+>/g, "") : null;
};
const rankLine = (html: string) => {
  const m = html.match(/<span data-rank-line="">([\s\S]*?)<\/span><\/dd>/);
  return m ? m[1] : null;
};

beforeEach(() => {
  mockCreateClient.mockReset();
  rpcCalls.length = 0;
  pickCalls.length = 0;
  rankRpc = async () => ({ data: [], error: null });
});

describe("item 7: the Renditja line", () => {
  it("lists Libraria then each category, each linking to that list", async () => {
    rankRpc = ranks([null, 14], ["Romancë", 1], ["Histori", 3]);
    const html = await render();
    // P5 adds a second admin call (books_bought_together); this checks the rank call.
    expect(rpcCalls.filter((c) => c.name === "book_sales_ranks")).toEqual([{ name: "book_sales_ranks", args: { p_book_id: BOOK_ID } }]);
    expect(html).toContain('<dt class="font-semibold text-foreground">Renditja:</dt>');
    const line = rankLine(html)!;
    expect(line.replace(/<[^>]+>/g, "")).toBe("Nr. 14 në Librari · Nr. 1 në Romancë · Nr. 3 në Histori");
    const hrefs = [...line.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/librari", "/librari?genre=Romanc%C3%AB", "/librari?genre=Histori"]);
  });

  it("is not there when the book has no rank, or the read fails or throws", async () => {
    for (const rpc of [
      async () => ({ data: [], error: null }),
      async () => ({ data: null, error: { message: "boom" } }),
      async () => { throw new Error("network"); },
    ]) {
      rankRpc = rpc;
      const html = await render();
      expect(html).not.toContain("Renditja");
      expect(html).not.toContain("data-rank-line");
      expect(badges(html)).toBeNull();
    }
  });
});

describe("item 2: the badges under the title", () => {
  it("shows Nr. 1 in the first category where the book is first", async () => {
    rankRpc = ranks([null, 2], ["Romancë", 3], ["Histori", 1]);
    expect(badges(await render())).toBe("Nr. 1 në Histori");
  });

  it("prefers a category over all of Libraria", async () => {
    rankRpc = ranks([null, 1], ["Romancë", 1]);
    expect(badges(await render())).toBe("Nr. 1 në Romancë");
  });

  it("says Nr. 1 në Librari when first overall and in no shown category", async () => {
    rankRpc = ranks([null, 1], ["Romancë", 2]);
    expect(badges(await render())).toBe("Nr. 1 në Librari");
  });

  it("shows no rank badge when the book is first nowhere", async () => {
    rankRpc = ranks([null, 2], ["Romancë", 2]);
    const html = await render();
    expect(badges(html)).toBeNull();
    expect(rankLine(html)).not.toBeNull();
  });

  it("shows Zgjedhja e Librum for a picked book (any pick), asking only for this book", async () => {
    const html = await render({ picks: [{ id: "p1" }] });
    expect(badges(html)).toBe("Zgjedhja e Librum");
    expect(pickCalls).toContainEqual({ method: "eq", args: ["book_id", BOOK_ID] });
  });

  it("shows both badges, rank first", async () => {
    rankRpc = ranks([null, 1], ["Romancë", 1]);
    expect(badges(await render({ picks: [{ id: "p1" }] }))).toBe("Nr. 1 në RomancëZgjedhja e Librum");
  });

  it("shows no pick badge when there is no pick, or the read fails or throws", async () => {
    expect(badges(await render({ picks: [] }))).toBeNull();
    expect(badges(await render({ picks: "error" }))).toBeNull();
    expect(badges(await render({ pickThrows: true }))).toBeNull();
  });
});
