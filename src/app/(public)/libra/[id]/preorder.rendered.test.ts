import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BD16 P4: the real book page for a pre-order (same stubbed-client
// harness as reader-side.rendered.test.ts): the "Del më …" line, no buy,
// free or wishlist control for readers (a sample only from an approved file, PREVIEW-READER-1), "Më njofto" for a
// signed-in reader, sign-in for a visitor, the author's own panel, an
// indexable page with no schema.org offer, and a draft still hidden.

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("createClient not stubbed");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const adminInsert = vi.fn(async () => ({ data: null }));
// PREVIEW-READER-1: the page reads a pre-order's reviews to decide the
// sample button.
let reviewRows: unknown = { data: [], error: null };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) =>
      table === "book_reviews"
        ? { select: () => ({ in: () => ({ returns: async () => reviewRows }) }) }
        : { insert: adminInsert },
  }),
}));
vi.mock("./actions", () => ({
  buyBook: vi.fn(), getFreeBook: vi.fn(), submitReview: vi.fn(),
  addToWishlist: vi.fn(), removeFromWishlist: vi.fn(),
}));
vi.mock("./preorder-actions", () => ({
  notifyMeWhenOut: vi.fn(), removePreorderNotice: vi.fn(),
}));

const { default: BookDetailPage, generateMetadata } = await import("./page");

const AUTHOR_ID = "00000000-0000-4000-8000-0000000000a1";
const READER_ID = "00000000-0000-4000-8000-0000000000b2";
const PEN_ID = "00000000-0000-4000-8000-0000000000e9";
const BASE = {
  title: "Libri që vjen", subtitle: null, price_cents: 0, price_all: 499,
  status: "preorder", release_date: "2099-12-12", cover_path: null, series_id: null,
  genre: "Roman", categories: ["Roman"], is_adult: false, reading_age_min: null,
  edition_number: null, edition: null, description: "Një roman.",
  language: "sq", isbn: null, publisher: null,
  created_at: "2026-09-01T00:00:00Z", published_at: null, pen_name_id: PEN_ID,
  pen: { id: PEN_ID, name: "Ana Shkrimtarja", bio: null, avatar_path: null, links: [] },
};

let n = 0;
function book(extra: Record<string, unknown> = {}) {
  n += 1;
  return { ...BASE, id: `00000000-f1c9-4000-8000-0000000016${String(n).padStart(2, "0")}`, ...extra };
}

type Call = [string, unknown[]];
function queryStub(listResult: unknown, rowResult: unknown, log?: Call[]) {
  let single = false;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const result = single ? rowResult : listResult;
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return (...args: unknown[]) => (log?.push([String(prop), args]), chain);
    },
  });
  return chain;
}

let publicBookQueries: Call[][] = [];
let noticeQueries = 0;

function stub(opts: { b: Record<string, unknown>; user?: string | null; notice?: unknown; owned?: boolean }) {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: opts.user ? { id: opts.user } : null } }) },
    rpc: vi.fn(async (name: string) => ({ data: name === "user_owns_book" ? !!opts.owned : null })),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      if (table === "public_books") {
        const log: Call[] = [];
        publicBookQueries.push(log);
        return queryStub({ data: [] }, { data: opts.b }, log);
      }
      if (table === "books") {
        return queryStub({ data: [] }, { data: opts.user === AUTHOR_ID ? { id: opts.b.id } : null });
      }
      if (table === "preorder_notify_requests") {
        noticeQueries += 1;
        return queryStub({ data: [] }, { data: opts.notice ?? null });
      }
      return queryStub({ data: [] }, { data: null });
    },
  }));
}

async function render(opts: Parameters<typeof stub>[0] & { searchParams?: Record<string, string> }) {
  stub(opts);
  const element = await BookDetailPage({
    params: Promise.resolve({ id: String(opts.b.id) }),
    searchParams: Promise.resolve(opts.searchParams ?? {}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

function noBuyControls(html: string) {
  expect(html).not.toContain("Blini e-librin");
  expect(html).not.toContain("Merreni e-librin");
  expect(html).not.toContain("Hyr për ta blerë");
  expect(html).not.toContain("Ruajeni për më vonë");
  expect(html).not.toContain("Lexoni një pjesë");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librum.al");
  publicBookQueries = [];
  noticeQueries = 0;
  reviewRows = { data: [], error: null };
  adminInsert.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("BD16 P4: a pre-order's book page", () => {
  it("a visitor sees the date, the price and 'Hyr që të njoftohesh', and nothing to buy", async () => {
    const html = await render({ b: book(), user: null });
    expect(html).toContain("data-preorder-release");
    expect(html).toContain("Del më 12 dhjetor 2099");
    expect(html).toContain("499");
    expect(html).toContain("Hyr që të njoftohesh");
    expect(html).toMatch(/href="\/login\?next=\/libra\/[0-9a-f-]+"/);
    expect(html).toContain("Nuk mund të blihet ose të shkarkohet para se të dalë.");
    expect(html).not.toContain("Parapamje. Ky libër nuk është në Librari.");
    noBuyControls(html);
    expect(noticeQueries).toBe(0);
  });

  it("a signed-in reader gets 'Më njofto kur të dalë'", async () => {
    const html = await render({ b: book(), user: READER_ID });
    expect(html).toContain("Më njofto kur të dalë");
    expect(html).not.toContain("Hiq njoftimin");
    noBuyControls(html);
    expect(noticeQueries).toBe(1);
  });

  it("a reader already on the list sees it and 'Hiq njoftimin'", async () => {
    const html = await render({ b: book(), user: READER_ID, notice: { book_cancelled_at: null } });
    expect(html).toContain("Do t&#x27;ju njoftojmë me email kur të dalë libri.");
    expect(html).toContain("Hiq njoftimin");
    expect(html).not.toContain("Më njofto kur të dalë");
  });

  it("a row left by an earlier cancelled pre-order counts as not on the list", async () => {
    const html = await render({ b: book(), user: READER_ID, notice: { book_cancelled_at: "2026-10-01T07:00:00Z" } });
    expect(html).toContain("Më njofto kur të dalë");
  });

  it("shows the ?notify= result words, and ignores anything else", async () => {
    expect(await render({ b: book(), user: READER_ID, searchParams: { notify: "off" } })).toContain("Njoftimi u hoq.");
    expect(await render({ b: book(), user: READER_ID, searchParams: { notify: "error" } })).toContain(
      "Ky libër mund të mos jetë më në parapublikim",
    );
    const odd = await render({ b: book(), user: READER_ID, searchParams: { notify: "<i>x</i>" } });
    expect(odd).not.toContain("&lt;i&gt;");
  });

  it("after 'Më njofto' the 'on' sentence shows once (the price panel), with no top box (Renato 11-12, a)", async () => {
    const html = await render({ b: book(), user: READER_ID, notice: { book_cancelled_at: null }, searchParams: { notify: "on" } });
    expect(html.split("Do t&#x27;ju njoftojmë me email kur të dalë libri.").length - 1).toBe(1);
    expect(html).toContain("Hiq njoftimin");
  });

  it("says 'Del së shpejti' once the release day has passed", async () => {
    const html = await render({ b: book({ release_date: "2020-01-01" }), user: null });
    expect(html).toContain("Del së shpejti");
    expect(html).not.toContain("1 janar 2020");
  });

  // PREVIEW-READER-1 (Q6 b): replaces "no sample for a pre-order".
  it("readers get 'Lexoni një pjesë' once a file is approved, and still nothing to buy", async () => {
    const b = book();
    reviewRows = {
      data: [{ id: "r1", book_id: b.id, status: "approved", file_path: "a/b.epub", cover_path: null, submitted_at: "2026-10-01T00:00:00Z", decided_at: "2026-10-02T00:00:00Z" }],
      error: null,
    };
    const html = await render({ b, user: null });
    expect(html).toContain("Lexoni një pjesë");
    expect(html).not.toContain("Blini e-librin");
    expect(html).not.toContain("Merreni e-librin");
  });

  it("approved without a file, never approved, or a read error: no sample button", async () => {
    for (const rows of [
      { data: [{ id: "r1", book_id: "x", status: "approved", file_path: null, cover_path: null, submitted_at: null, decided_at: "2026-10-02T00:00:00Z" }], error: null },
      { data: [{ id: "r1", book_id: "x", status: "pending", file_path: "a/b.epub", cover_path: null, submitted_at: null, decided_at: null }], error: null },
      { data: null, error: { code: "x" } },
    ]) {
      const b = book();
      reviewRows = { ...rows, data: rows.data?.map((r) => ({ ...r, book_id: b.id })) ?? null };
      const html = await render({ b, user: READER_ID });
      expect(html).not.toContain("Lexoni një pjesë");
    }
  });

  it("the author gets their own panel (manage, preview sample), no notify button, no draft banner", async () => {
    const html = await render({ b: book(), user: AUTHOR_ID });
    expect(html).toContain("Menaxhoni librin");
    expect(html).not.toContain("Më njofto kur të dalë");
    expect(html).not.toContain("Parapamje. Ky libër nuk është në Librari.");
    expect(noticeQueries).toBe(0);
  });

  it("an earlier buyer keeps their download panel and no 'nuk shitet më' line", async () => {
    const html = await render({ b: book(), user: READER_ID, owned: true });
    expect(html).toContain("Ky libër është i juaji");
    expect(html).not.toContain("Ky libër nuk shitet më");
    expect(html).not.toContain("Më njofto kur të dalë");
  });

  it("counts no book view (views are for published books)", async () => {
    await render({ b: book(), user: READER_ID });
    expect(adminInsert).not.toHaveBeenCalled();
  });

  it("the shelves ask for published books and pre-orders", async () => {
    await render({ b: book({ series_id: "00000000-0000-4000-8000-0000000000c3" }), user: null });
    const shelves = publicBookQueries.filter((q) => q.some(([m]) => m === "in"));
    expect(shelves.length).toBeGreaterThanOrEqual(3);
    for (const q of shelves) {
      expect(q).toContainEqual(["in", ["status", ["published", "preorder"]]]);
    }
  });

  it("is indexable, and its schema.org data has no offer", async () => {
    const b = book();
    stub({ b, user: null });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: b.id }) });
    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toBe("Libri që vjen");
    const html = await render({ b: book(), user: null });
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    expect(ld.name).toBe("Libri që vjen");
    expect(ld.offers).toBeUndefined();
  });

  it("a draft is still not found for a reader and noindex in metadata", async () => {
    const b = book({ status: "draft", release_date: "2099-12-12" });
    stub({ b, user: null });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: b.id }) });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    await expect(render({ b: book({ status: "draft" }), user: READER_ID })).rejects.toThrow();
  });

  it("a published book shows no pre-order line or notify button", async () => {
    const html = await render({ b: book({ status: "published", release_date: null, published_at: "2026-09-02T00:00:00Z" }), user: READER_ID });
    expect(html).not.toContain("data-preorder-release");
    expect(html).not.toContain("Më njofto kur të dalë");
    expect(noticeQueries).toBe(0);
  });
});
