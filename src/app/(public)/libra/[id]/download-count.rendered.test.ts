import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Download count (Renato 11-15): the real book page (same stubbed-client
// harness as preorder.rendered.test.ts). "N shkarkime" under the genre
// for a published book; nothing at 0, on an error, or for a pre-order
// (which never asks).

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

const { default: BookDetailPage } = await import("./page");

const PEN_ID = "00000000-0000-4000-8000-0000000000e9";
const BASE = {
  title: "Libri që vjen", subtitle: null, price_cents: 0, price_all: 499,
  status: "published", release_date: null, cover_path: null, series_id: null,
  genre: "Roman", categories: ["Roman"], is_adult: false, reading_age_min: null,
  edition_number: null, edition: null, description: "Një roman.",
  language: "sq", isbn: null, publisher: null,
  created_at: "2026-09-01T00:00:00Z", published_at: "2026-10-01T00:00:00Z", pen_name_id: PEN_ID,
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

let rpcCalls: [string, unknown][] = [];

function stub(opts: { b: Record<string, unknown>; count?: unknown; error?: boolean }) {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    rpc: vi.fn(async (name: string, args: unknown) => {
      rpcCalls.push([name, args]);
      if (name === "book_download_count") return opts.error ? { data: null, error: { code: "XX000" } } : { data: opts.count ?? 0 };
      return { data: null };
    }),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      if (table === "public_books") return queryStub({ data: [] }, { data: opts.b });
      return queryStub({ data: [] }, { data: null });
    },
  }));
}

async function render(opts: Parameters<typeof stub>[0]) {
  stub(opts);
  const element = await BookDetailPage({
    params: Promise.resolve({ id: String(opts.b.id) }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librum.al");
  rpcCalls = [];
  reviewRows = { data: [], error: null };
  adminInsert.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("download count on the book page", () => {
  it("shows every number from 1 up, asked for this book only", async () => {
    const b = book();
    const html = await render({ b, count: 142 });
    expect(html).toMatch(/data-download-count=""[^>]*>[\s\S]*?<span class="font-semibold text-foreground">142<\/span> shkarkime/);
    expect(rpcCalls).toContainEqual(["book_download_count", { p_book_id: b.id }]);
  });

  it("says shkarkim for one", async () => {
    const html = await render({ b: book(), count: 1 });
    expect(html).toContain(">1</span> shkarkim<");
  });

  it("groups thousands", async () => {
    const html = await render({ b: book(), count: 12345 });
    expect(html).toContain(">12\u00a0345</span> shkarkime");
  });

  it("shows nothing at 0 or when the count can't be read", async () => {
    expect(await render({ b: book(), count: 0 })).not.toContain("data-download-count");
    expect(await render({ b: book(), error: true })).not.toContain("data-download-count");
    expect(await render({ b: book(), count: "7" })).not.toContain("data-download-count");
  });

  it("never asks for a pre-order", async () => {
    const html = await render({ b: book({ status: "preorder", release_date: "2099-12-12", published_at: null }), count: 5 });
    expect(html).not.toContain("data-download-count");
    expect(rpcCalls.map(([name]) => name)).not.toContain("book_download_count");
  });
});
