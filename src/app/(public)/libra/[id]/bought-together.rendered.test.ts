import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Amazon book page, patch 5 (item 10 + real data for 11; bp9 b, bp10 b,
// fb1 a, fb2 b, fb3 b, fb4 a): "Blihen shpesh bashkë" and the
// "Blerë bashkë me këtë" chip. Rendered from the real page over a
// stubbed Supabase: the pairs come from the admin client's
// books_bought_together (ids only), read back through public_books.

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("createClient not stubbed");
});
let pairRpc: () => Promise<{ data: unknown; error: unknown }> = async () => ({ data: [], error: null });
const rpcCalls: { name: string; args: unknown }[] = [];
let paidCheckout = false;
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async () => ({ data: null }) }),
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return name === "books_bought_together" ? pairRpc() : Promise.resolve({ data: [], error: null });
    },
  }),
}));
vi.mock("@/lib/paid-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paid-readiness")>()),
  canStartPaidCheckout: () => paidCheckout,
}));
vi.mock("../../shporta/actions", () => ({
  addToCart: vi.fn(), addBothToCart: vi.fn(), saveGift: vi.fn(), removeFromCart: vi.fn(), pressPay: vi.fn(), addToCartFromLibraria: vi.fn(),
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
  status: "published", cover_path: null, series_id: null, genre: "Romane",
  categories: ["Romane"], description: "About it.", language: null,
  created_at: "2026-09-01T00:00:00Z", published_at: "2026-09-02T00:00:00Z",
  pen_name_id: PEN.id, pen: PEN,
};
const other = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, price_all: 199, status: "published", cover_path: null, genre: "Romane",
  pen_name_id: "pen-other", original_author: null, is_adult: false, release_date: null,
  published_at: "2026-01-01T00:00:00Z", pen: { id: "pen-other", name: "Other Writer" }, ...extra,
});
const SIMILAR = [other("g-1", "Same Genre One"), other("g-2", "Same Genre Two")];
const PAIRED = [other("p-2", "Paired Two", { price_all: 349 }), other("p-1", "Paired One", { price_all: 299 })];

type Options = { user?: { id: string } | null; owns?: boolean; book?: Record<string, unknown>; similar?: unknown[]; paired?: unknown[] };
const pairedReads: { method: string; args: unknown[] }[][] = [];

function stub(table: string, opts: Options) {
  const calls: { method: string; args: unknown[] }[] = [];
  const book = opts.book ?? BOOK;
  const has = (method: string, ...args: unknown[]) =>
    calls.some((c) => c.method === method && args.every((a, i) => JSON.stringify(c.args[i]) === JSON.stringify(a)));
  const resolve = (single: boolean) => {
    if (table === "public_books") {
      if (single) {
        const publicPart: Record<string, unknown> = { ...book };
        delete publicPart.author_id;
        return { data: publicPart };
      }
      if (has("in", "id")) {
        pairedReads.push(calls);
        const ids = calls.find((c) => c.method === "in" && c.args[0] === "id")!.args[1] as string[];
        return { data: (opts.paired ?? PAIRED).filter((b) => ids.includes((b as { id: string }).id)) };
      }
      if (has("overlaps")) return { data: opts.similar ?? SIMILAR };
      return { data: [], count: 1 };
    }
    if (table === "books") {
      const mine = !!opts.user && opts.user.id === book.author_id;
      return { data: single ? (mine ? { id: book.id } : null) : [] };
    }
    return { data: single ? null : [] };
  };
  let single = false;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (done: (v: unknown) => unknown) => done(resolve(single));
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return (...args: unknown[]) => (calls.push({ method: String(prop), args }), chain);
    },
  });
  return chain;
}

async function render(opts: Options = {}) {
  const user = opts.user === undefined ? { id: "reader" } : opts.user;
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async (name: string) => ({ data: name === "user_owns_book" ? (opts.owns ?? false) : null }),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => stub(table, { ...opts, user }),
  }));
  const element = await BookDetailPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

const pairs = (...ids: string[]) => async () => ({ data: ids.map((book_id, i) => ({ book_id, sort_order: i + 1 })), error: null });
const block = (html: string) => {
  const m = html.match(/<section data-bought-together=""[\s\S]*?<\/section>/);
  return m ? m[0] : null;
};
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const chipLabels = (html: string) =>
  [...html.matchAll(/data-shelf-chip=""[^>]*>([\s\S]*?)<\/a>/g)].map((m) => text(m[1]));

beforeEach(() => {
  mockCreateClient.mockReset();
  rpcCalls.length = 0;
  pairedReads.length = 0;
  pairRpc = async () => ({ data: [], error: null });
  paidCheckout = false;
});

describe("item 10: Blihen shpesh bashkë", () => {
  it("with no real pair, shows the first same-genre book under the same heading (bp9 b, fb2 b)", async () => {
    const html = await render();
    expect(rpcCalls).toContainEqual({ name: "books_bought_together", args: { p_book_id: BOOK_ID } });
    const b = block(html)!;
    expect(b).toContain(">Blihen shpesh bashkë</h2>");
    expect(text(b)).toContain("Ky libër 250 lekë");
    expect(text(b)).toContain("Same Genre One 199 lekë");
    expect(b).not.toContain("Same Genre Two");
    expect(b).toContain('href="/libra/g-1"');
    expect(text(b)).toContain("Gjithsej: 449 lekë");
    // No paired read when there are no ids.
    expect(pairedReads).toHaveLength(0);
  });

  it("with real pairs, shows the best one, in pair order (not the read's order)", async () => {
    pairRpc = pairs("p-1", "p-2");
    const html = await render();
    const b = block(html)!;
    expect(text(b)).toContain("Paired One 299 lekë");
    expect(b).not.toContain("Same Genre One");
    expect(text(b)).toContain("Gjithsej: 549 lekë");
  });

  it("the paired read keeps the listing rules, and on a children's book never an 18+ book", async () => {
    pairRpc = pairs("p-1");
    await render();
    const read = pairedReads[0];
    expect(read).toContainEqual({ method: "in", args: ["status", ["published", "preorder"]] });
    expect(read).toContainEqual({ method: "not", args: ["price_all", "is", null] });
    expect(read.some((c) => c.method === "eq" && c.args[0] === "is_adult")).toBe(false);
    pairedReads.length = 0;
    await render({ book: { ...BOOK, categories: ["Për fëmijë"], genre: "Për fëmijë" } });
    expect(pairedReads[0]).toContainEqual({ method: "eq", args: ["is_adult", false] });
  });

  it("a paired id the read leaves out falls back to the next one, then to the same-genre book", async () => {
    pairRpc = pairs("gone", "p-2");
    expect(text(block(await render())!)).toContain("Paired Two 349 lekë");
    pairRpc = pairs("gone");
    expect(text(block(await render())!)).toContain("Same Genre One");
  });

  it("is not there with no pair and no same-genre book, or when the read fails", async () => {
    expect(block(await render({ similar: [] }))).toBeNull();
    pairRpc = async () => ({ data: null, error: { message: "x" } });
    expect(text(block(await render())!)).toContain("Same Genre One");
  });

  it("no add-both button while card payment is closed (bp10 b), for anyone", async () => {
    pairRpc = pairs("p-1");
    for (const user of [{ id: "reader" }, null]) {
      const html = await render({ user });
      expect(html).not.toContain("data-add-both");
      expect(html).not.toContain("Shto të dyja në shportë");
    }
  });

  it("once card payment is open: a button for a reader, a log-in link when signed out, nothing for an owner", async () => {
    paidCheckout = true;
    pairRpc = pairs("p-1");
    expect(block(await render())!).toMatch(/<form[^>]*><button type="submit" data-add-both=""[^>]*>Shto të dyja në shportë<\/button><\/form>/);
    expect(block(await render({ user: null }))!).toMatch(
      new RegExp(`<a data-add-both=""[^>]*href="/login\\?next=/libra/${BOOK_ID}">Shto të dyja në shportë</a>`),
    );
    expect(block(await render({ owns: true }))!).not.toContain("data-add-both");
  });
});

describe("item 11: the shelf with real data (fb3 b)", () => {
  it("heading is \"Lexuesit blenë edhe\"; with no pairs there is no new chip", async () => {
    const html = await render();
    expect(html.match(/<h2[^>]*>Lexuesit blenë edhe<\/h2>/g)).toHaveLength(1);
    expect(chipLabels(html)).not.toContain("Blerë bashkë me këtë");
    expect(html).not.toContain("Blerë bashkë me këtë");
  });

  it("with pairs, \"Blerë bashkë me këtë\" is the first chip and lists them in pair order", async () => {
    pairRpc = pairs("p-1", "p-2");
    const html = await render();
    expect(chipLabels(html)[0]).toBe("Blerë bashkë me këtë");
    expect(html).toContain(`href="/libra/${BOOK_ID}#te-ngjashem" data-shelf-chip=""`);
    const shelf = html.slice(html.indexOf('id="te-ngjashem"'));
    expect(shelf.indexOf("Paired One")).toBeLessThan(shelf.indexOf("Paired Two"));
  });

  it("the block sits between the bar and the shelf", async () => {
    const html = await render();
    expect(html.indexOf("data-bought-together")).toBeGreaterThan(html.indexOf("data-section-bar"));
    expect(html.indexOf("data-bought-together")).toBeLessThan(html.indexOf('id="te-ngjashem"'));
  });
});
