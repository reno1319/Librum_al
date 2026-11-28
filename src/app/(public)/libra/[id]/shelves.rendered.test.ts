import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Amazon book page, patch 2 (design r7): the section bar (13), "Edhe në
// paketë" (9), the shelf with chips (11, 23, 24), stars and "I ri" on
// its cards (12, 20), the follow lines (14, 27) -- and the two P1 audit
// notes: the cover icons' tap area, and who never sees the heart, the
// seller rows or the report link. Rendered from the real page over a
// stubbed Supabase that answers each list by the filters it was given.

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("createClient not stubbed");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ insert: async () => ({ data: null }) }) }),
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
const NOW = new Date("2026-11-28T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const PEN = { id: "pen-an-author", name: "An Author", bio: "Bio.", avatar_path: null, links: [] };
const BOOK = {
  id: BOOK_ID, title: "Test Book", price_all: 250, author_id: "author",
  status: "published", cover_path: null, series_id: null, genre: "Romane",
  categories: ["Romane", "Histori"], description: "About it.", language: null,
  created_at: "2026-09-01T00:00:00Z", published_at: "2026-09-02T00:00:00Z",
  pen_name_id: PEN.id, pen: PEN,
};
const other = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, price_all: 199, status: "published", cover_path: null, genre: "Romane",
  pen_name_id: "pen-other", original_author: null, is_adult: false, release_date: null,
  published_at: daysAgo(100), pen: { id: "pen-other", name: "Other Writer" }, ...extra,
});
const SIMILAR = [
  other("b-new", "Brand New", { published_at: daysAgo(10) }),
  other("b-old", "Old One", { published_at: daysAgo(40) }),
  other("b-pre", "Coming Soon", { status: "preorder", published_at: null, release_date: "2027-01-10" }),
];
const BY_AUTHOR = [other("b-mine", "Second Book", { pen_name_id: PEN.id, pen: PEN })];
const HISTORY = [other("b-hist", "A History")];

type Calls = { method: string; args: unknown[] }[];
type Options = {
  user?: { id: string } | null;
  owns?: boolean;
  book?: Record<string, unknown>;
  similar?: unknown[];
  byAuthor?: unknown[];
  romane?: unknown[];
  history?: unknown[];
  bundleIds?: string[];
  bundles?: unknown[];
  reviews?: { book_id: string; rating: number }[];
};

function stub(table: string, opts: Options) {
  const calls: Calls = [];
  const book = opts.book ?? BOOK;
  const resolve = (single: boolean) => {
    const has = (method: string, ...args: unknown[]) =>
      calls.some((c) => c.method === method && args.every((a, i) => JSON.stringify(c.args[i]) === JSON.stringify(a)));
    if (table === "public_books") {
      if (single) {
        const publicPart: Record<string, unknown> = { ...book };
        delete publicPart.author_id;
        return { data: publicPart };
      }
      if (has("overlaps")) return { data: opts.similar ?? SIMILAR };
      if (has("contains", "categories", ["Romane"])) return { data: opts.romane ?? [] };
      if (has("contains", "categories", ["Histori"])) return { data: opts.history ?? HISTORY };
      if (has("eq", "pen_name_id", PEN.id) && has("neq", "id", BOOK_ID)) return { data: opts.byAuthor ?? BY_AUTHOR };
      return { data: [], count: 2 };
    }
    if (table === "books") {
      const mine = !!opts.user && opts.user.id === book.author_id;
      return { data: single ? (mine ? { id: book.id } : null) : [] };
    }
    if (table === "bundle_books") return { data: (opts.bundleIds ?? []).map((bundle_id) => ({ bundle_id })) };
    if (table === "public_bundles") return { data: opts.bundles ?? [] };
    if (table === "public_reviews") {
      // The page's own reviews read has .order(); the shelf's ratings read
      // asks with .in("book_id", ...).
      return { data: has("in") ? (opts.reviews ?? []) : [] };
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

const between = (html: string, start: string, end: string) => {
  const from = html.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = html.indexOf(end, from + start.length);
  return html.slice(from, to === -1 ? undefined : to);
};
const chipLabels = (html: string) =>
  [...html.matchAll(/<a [^>]*data-shelf-chip=""[^>]*>(?:<span[^>]*>[^<]*<\/span>|<img[^>]*\/>)?([^<]*)<\/a>/g)].map((m) => m[1]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.unstubAllEnvs();
  mockCreateClient.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("item 13: the section bar", () => {
  it("links to each part that exists, in page order, with the small title; computer and tablet only", async () => {
    const html = await render();
    const bar = between(html, 'data-section-bar=""', "</nav>");
    expect(html).toMatch(/<nav aria-label="Pjesët e faqes" data-section-bar="" class="sticky top-0 [^"]*max-md:hidden"/);
    const links = [...bar.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(links).toEqual([
      "# ↑ Lart",
      "#rreth-librit Rreth librit",
      "#te-ngjashem Të ngjashëm",
      "#rreth-autorit Rreth autorit",
      "#vleresimet Vlerësimet",
    ]);
    expect(bar).toContain("Test Book");
    expect(bar).not.toContain("lekë");
    // Every target exists on the page.
    for (const id of ["rreth-librit", "te-ngjashem", "rreth-autorit", "vleresimet"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("leaves out a part the page does not have", async () => {
    const html = await render({
      book: { ...BOOK, description: null },
      similar: [], byAuthor: [], romane: [], history: [],
    });
    const bar = between(html, 'data-section-bar=""', "</nav>");
    expect(bar).not.toContain("Rreth librit");
    expect(bar).not.toContain("Të ngjashëm");
    expect(bar).toContain("Rreth autorit");
    expect(bar).toContain("Vlerësimet");
  });
});

describe("items 11, 23, 24: the shelf with chips", () => {
  it("heading \"Lexuesit blenë edhe\" (P5, fb3 b), chips: similar, the author, each category; the old bottom row is gone", async () => {
    const html = await render();
    expect(html.match(/<h2[^>]*>Lexuesit blenë edhe<\/h2>/g)).toHaveLength(1);
    expect(html).not.toContain("Mund t&#x27;ju pëlqejnë edhe");
    // Romane's row is empty here, so only Histori gets a chip.
    expect(chipLabels(html)).toEqual(["Libra të ngjashëm", "Nga An Author", "Histori"]);
    expect(html).toMatch(/<a href="\/autore\/pen-an-author" data-shelf-chip=""/);
    // The shelf sits above "Të dhënat e librit".
    expect(html.indexOf('id="te-ngjashem"')).toBeLessThan(html.indexOf('id="te-dhenat"'));
  });

  it("a category chip with exactly the first chip's books is left out", async () => {
    const html = await render({ romane: SIMILAR, history: [] });
    expect(chipLabels(html)).toEqual(["Libra të ngjashëm", "Nga An Author"]);
  });

  it("no author chip when the byline is an original author (the pen name is the translator)", async () => {
    const html = await render({ book: { ...BOOK, original_author: "Arthur Machen" } });
    expect(chipLabels(html)).not.toContain("Nga An Author");
  });

  it("one list only: no chips, the row alone", async () => {
    const html = await render({ byAuthor: [], romane: [], history: [] });
    expect(chipLabels(html)).toEqual([]);
    expect(html).toContain("Brand New");
  });
});

describe("items 12 + 20: the shelf cards", () => {
  it("stars with the count for a reviewed book, none without a review", async () => {
    const html = await render({ reviews: [{ book_id: "b-old", rating: 4 }, { book_id: "b-old", rating: 5 }] });
    const shelf = between(html, 'id="te-ngjashem"', 'id="te-dhenat"');
    expect(shelf).toContain("4,5 nga 5 yje, 2 vlerësime");
    expect(shelf.split("nga 5 yje").length - 1).toBe(1);
  });

  it('"I ri" only on a live book published in the last 30 days (bp5 a)', async () => {
    const html = await render();
    const shelf = between(html, 'id="te-ngjashem"', 'id="te-dhenat"');
    const cards = shelf.split('data-book-page-card=""').slice(1);
    const card = (title: string) => cards.find((c) => c.includes(title)) ?? "";
    expect(card("Brand New")).toContain("data-new-tag");
    expect(card("Old One")).not.toContain("data-new-tag");
    expect(card("Coming Soon")).not.toContain("data-new-tag");
    expect(card("Coming Soon")).toContain("data-preorder-badge");
  });
});

describe('item 9: "Edhe në paketë"', () => {
  const BUNDLE = {
    id: "bundle-1", title: "Trilogjia", price_all: 500,
    bundle_books: [
      { books: { id: BOOK_ID, title: "Test Book", cover_path: null, price_all: 250, status: "published", is_adult: false } },
      { books: { id: "b2", title: "Two", cover_path: null, price_all: 199, status: "published", is_adult: false } },
      { books: { id: "b3", title: "Three", cover_path: null, price_all: 149, status: "published", is_adult: false } },
    ],
  };

  it("a bundle that holds the book: its link, books, price and saving, under the buy box", async () => {
    const html = await render({ bundleIds: ["bundle-1"], bundles: [BUNDLE] });
    const box = between(html, 'data-bundle-box=""', "</section>");
    expect(box).toContain("Edhe në paketë");
    expect(box).toContain('href="/paketa/bundle-1"');
    expect(box).toContain("Trilogjia");
    expect(box).toContain("3 libra · 500 lekë");
    expect(box).toContain("Kurseni 98 lekë");
    expect(html.indexOf('id="blerja"')).toBeLessThan(html.indexOf("data-bundle-box"));
  });

  it("no saving line when a book's price is unknown", async () => {
    const html = await render({
      bundleIds: ["bundle-1"],
      bundles: [{ ...BUNDLE, bundle_books: [...BUNDLE.bundle_books, { books: null }] }],
    });
    expect(between(html, 'data-bundle-box=""', "</section>")).not.toContain("Kurseni");
  });

  it("nothing when the book is in no bundle", async () => {
    expect(await render()).not.toContain("data-bundle-box");
  });
});

describe("items 14 + 27: why follow", () => {
  it("a signed-in reader: the line and the link to the followed authors", async () => {
    const html = await render();
    const line = between(html, 'data-follow-why=""', "</p>");
    expect(line).toContain("Ndiqni autorin dhe ju dërgojmë email kur del një libër i ri.");
    expect(line).toContain('href="/following"');
  });

  it("signed out: the line, no link", async () => {
    const html = await render({ user: null });
    const line = between(html, 'data-follow-why=""', "</p>");
    expect(line).not.toContain("/following");
  });

  it("the author: no line", async () => {
    expect(await render({ user: { id: "author" } })).not.toContain("data-follow-why");
  });
});

describe("P1 audit notes", () => {
  it("note 1: the cover icons get a 44px tap area on phones, nothing visible", async () => {
    const html = await render();
    const icons = between(html, 'data-cover-actions=""', "</div>");
    expect(icons).toContain("before:-inset-[0.4375rem]");
    expect(icons).toContain("before:content-[&#x27;&#x27;]");
    expect(icons).toContain("md:before:hidden");
    expect(icons).toContain("size-[1.875rem]");
  });

  it("note 2: an owner sees no heart and no seller rows", async () => {
    const html = await render({ owns: true });
    expect(html).not.toContain("Ruaje për më vonë");
    expect(html).not.toContain("Hiqe nga Lista e dëshirave");
    expect(html).not.toContain("data-seller-rows");
  });

  it("note 2: the author sees no heart and no report link", async () => {
    const html = await render({ user: { id: "author" } });
    expect(html).not.toContain("Ruaje për më vonë");
    expect(html).not.toContain("Hiqe nga Lista e dëshirave");
    expect(html).not.toContain("data-report-link");
    expect(html).not.toContain("/report");
  });

  it("control: a reader does see the heart, the seller rows and the report link", async () => {
    const html = await render();
    expect(html).toContain("Ruaje për më vonë");
    expect(html).toContain("data-seller-rows");
    expect(html).toContain("data-report-link");
  });
});
