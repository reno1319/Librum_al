import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Amazon book page, patch 3 (design r7, bp3 a, bp4 a, rv1 a): the star
// pop-up trigger (21), the 5 -> 1 rows linking to the all-reviews page
// (15, 26), "Si funksionojnë vlerësimet" (25), "Shkruani një vlerësim"
// for everyone but the author (16), initials (18), and the newest 3 +
// "Shiko të gjitha vlerësimet (N)" (19). Rendered from the real page
// over a stubbed Supabase (same stub as the P2 shelves test).

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
  pageReviews?: unknown[];
  myReview?: unknown;
  searchParams?: Record<string, string>;
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
      if (has("in")) return { data: opts.reviews ?? [] };
      return { data: opts.pageReviews ?? [] };
    }
    if (table === "reviews") return { data: single ? (opts.myReview ?? null) : [], error: null };
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
    searchParams: Promise.resolve(opts.searchParams ?? {}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

const review = (n: number, rating: number, extra: Record<string, unknown> = {}) => ({
  id: `r${n}`, book_id: BOOK_ID, rating, body: `Text ${n}`, created_at: daysAgo(n),
  reviewer_name: `Reader Number${n}`, verified: n % 2 === 0, reviewer_is_author: false, ...extra,
});
// 5 reviews: 5,5,4,3,1 -> average 3,6; 40% / 20% / 20% / 0% / 20%.
const FIVE = [review(1, 5), review(2, 5), review(3, 4), review(4, 3, { reviewer_name: null }), review(5, 1)];

const between = (html: string, start: string, end: string) => {
  const from = html.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = html.indexOf(end, from + start.length);
  return html.slice(from, to === -1 ? undefined : to);
};
const section = (html: string) => {
  const from = html.indexOf('id="vleresimet"');
  expect(from).toBeGreaterThan(-1);
  return html.slice(from, html.indexOf("</section>", from));
};

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

describe("Amazon book page P3: reviews block", () => {
  it("5 -> 1 rows with rounded percents; rows with reviews link to the all-reviews page filtered, an empty row is text", async () => {
    const s = section(await render({ pageReviews: FIVE }));
    expect(s).toContain("3,6 nga 5");
    expect(s).toContain("5 vlerësime");
    const rows = [...s.matchAll(/<li class="grid grid-cols-\[3\.25rem[^"]*">(.*?)<\/li>/g)].map((m) => m[1]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain(`href="/libra/${BOOK_ID}/vleresimet?yjet=5"`);
    expect(rows[0]).toContain(">40%<");
    expect(rows[1]).toContain(`href="/libra/${BOOK_ID}/vleresimet?yjet=4"`);
    expect(rows[3]).not.toContain("href=");
    expect(rows[3]).toContain(">2 yje<");
    expect(rows[3]).toContain(">0%<");
    expect(rows[4]).toContain(">1 yll<");
    expect(s).toContain("Klikoni një rresht yjesh për të parë vetëm ato vlerësime.");
  });

  it("shows the newest 3 with initials, then 'Shiko të gjitha vlerësimet (N)'", async () => {
    const s = section(await render({ pageReviews: FIVE }));
    expect(s).toContain("Më të rejat · 3 nga 5");
    expect((s.match(/data-review=""/g) ?? []).length).toBe(3);
    expect(s).toContain(">RN<");
    expect(s).toContain("Text 3");
    expect(s).not.toContain("Text 4");
    expect(s).toContain(`href="/libra/${BOOK_ID}/vleresimet"`);
    expect(s).toContain("Shiko të gjitha vlerësimet (5)");
  });

  it("no 'Shiko të gjitha' when every review is already shown; a nameless review's circle says L", async () => {
    const s = section(await render({ pageReviews: [review(4, 3, { reviewer_name: null })] }));
    expect(s).toContain("Më të rejat · 1 nga 1");
    expect(s).not.toContain("Shiko të gjitha vlerësimet");
    expect(s).toContain(">L<");
    expect(s).toContain("Një lexues i Librum");
  });

  it("'Si funksionojnë vlerësimet' opens the rules, which match how reviews work", async () => {
    const s = section(await render({ pageReviews: FIVE }));
    expect(s).toMatch(/<details class="group[^"]*"><summary[^>]*>Si funksionojnë vlerësimet/);
    expect(s).toContain("Çdo vlerësim kontrollohet nga stafi para se të shfaqet.");
    expect(s).toContain("Autori nuk mund ta vlerësojë librin e vet.");
  });

  it("the rating line opens the star pop-up and its count still jumps to the reviews", async () => {
    const html = await render({ pageReviews: FIVE });
    const line = between(html, 'data-rating-line=""', "</div>");
    expect(line).toContain('aria-expanded="false"');
    expect(line).toContain('href="#vleresimet"');
    expect(line).toContain("5 vlerësime");
    expect(line).toContain("(5)");
    // the pop-up is drawn only once opened (needs the browser)
    expect(html).not.toContain("data-rating-popover");
  });

  it("no rating line and no rows before the first review; the write block still shows", async () => {
    const html = await render({ pageReviews: [] });
    expect(html).not.toContain("data-rating-line");
    const s = section(html);
    expect(s).not.toContain("data-review-histogram");
    expect(s).toContain("Vlerësoni këtë libër");
  });
});

describe("Amazon book page P3: 'Shkruani një vlerësim' (bp3 a, rv1 a)", () => {
  it("signed out: the button signs in first, then back to the book", async () => {
    const s = section(await render({ user: null, pageReviews: FIVE }));
    expect(s).toMatch(new RegExp(`<a[^>]*href="/login\\?next=/libra/${BOOK_ID}"[^>]*>Shkruani një vlerësim</a>`));
    expect(s).not.toContain('name="rating"');
  });

  it("signed in without the book: the button shows the one-line rule, no form", async () => {
    const s = section(await render({ pageReviews: FIVE }));
    expect(s).toMatch(/<details class="mt-3"><summary[^>]*>Shkruani një vlerësim<\/summary><p data-review-owners-only=""[^>]*>Vlerësimet i shkruajnë lexuesit që e kanë librin\.<\/p>/);
    expect(s).not.toContain('name="rating"');
  });

  it("owner: the button opens the form, closed by default", async () => {
    const s = section(await render({ owns: true, pageReviews: FIVE }));
    expect(s).toMatch(/<details class="mt-3"><summary[^>]*>Shkruani një vlerësim<\/summary><form/);
    expect(s).toContain('name="rating"');
    expect(s).not.toContain("data-review-owners-only");
  });

  it("owner: already open when coming from the reader's stars, after a save, or after a review error", async () => {
    const cases: Record<string, string>[] = [{ yje: "4" }, { review: "unchanged" }, { error: "Zgjidhni yjet." }];
    for (const searchParams of cases) {
      const s = section(await render({ owns: true, pageReviews: FIVE, searchParams }));
      expect(s, JSON.stringify(searchParams)).toContain('<details class="mt-3" open="">');
    }
    const other = section(await render({ owns: true, pageReviews: FIVE, searchParams: { error: "Diçka tjetër" } }));
    expect(other).toContain('<details class="mt-3">');
  });

  it("owner with a rejected review: the notice shows and the form is open; a pending one stays closed with its notice", async () => {
    const rejected = section(await render({
      owns: true, pageReviews: FIVE,
      myReview: { id: "m", rating: 2, body: "x", status: "rejected", rejection_reason: "abusive", rejection_note: null },
    }));
    expect(rejected).toContain('<details class="mt-3" open="">');
    expect(rejected).toContain("Përditësoni vlerësimin tuaj");
    const pending = section(await render({
      owns: true, pageReviews: FIVE,
      myReview: { id: "m", rating: 2, body: "x", status: "pending", rejection_reason: null, rejection_note: null },
    }));
    expect(pending).toContain('<details class="mt-3">');
    expect(pending).toContain("Vlerësimi juaj po shqyrtohet.");
  });

  it("the book's author sees no write block (they cannot review their own book)", async () => {
    const s = section(await render({ user: { id: "author" }, pageReviews: FIVE }));
    expect(s).not.toContain("data-review-write");
    expect(s).not.toContain("Shkruani një vlerësim");
    // control: a reader does
    expect(section(await render({ pageReviews: FIVE }))).toContain("data-review-write");
  });
});
