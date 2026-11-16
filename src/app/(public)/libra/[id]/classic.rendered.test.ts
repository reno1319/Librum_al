import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// K6 free Albanian classics (Renato 2026-11-16): the real book page
// (same stubbed-client harness as download-count.rendered.test.ts). A
// public-domain edition whose work belongs to a live classic author:
// "nga Naim Frashëri (1846–1900) (Autor)", the name linking to
// /klasiket/<slug>; without one (Q2 a) the name links to the Libraria
// search as before. "Botuar për herë të parë" shows the year only.
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

const NAIM = {
  id: "ca-1", slug: "naim-frasheri", name: "Naim Frashëri", birth_year: 1846, death_year: 1900,
  birth_place: "Frashër", death_place: "Stamboll", bio: "Poet.", pd_work_ids: ["00000000-0000-4000-8000-0000000000b1"],
};

let classicLog: Call[] = [];

function stub(b: Record<string, unknown>, classics: unknown[]) {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    rpc: vi.fn(async () => ({ data: 0 })),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      if (table === "public_books") return queryStub({ data: [] }, { data: b });
      if (table === "public_classic_authors") return queryStub({ data: classics, error: null }, { data: null }, classicLog);
      return queryStub({ data: [] }, { data: null });
    },
  }));
}

async function render(b: Record<string, unknown>, classics: unknown[]) {
  stub(b, classics);
  const element = await BookDetailPage({
    params: Promise.resolve({ id: String(b.id) }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

const CLASSIC = {
  price_all: 0, pen_name_id: null, pen: null, original_author: "Naim Frashëri",
  pd_work_id: "00000000-0000-4000-8000-0000000000b1", pd_editor_credit: false,
  original_publication_date: "1886-01-01", genre: "Poezi", categories: ["Poezi"],
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librum.al");
  reviewRows = { data: [], error: null };
  classicLog = [];
  adminInsert.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("K6: a classic's book page", () => {
  it("links the name to the classic page, with the years, and asks for this work only", async () => {
    const html = await render(book(CLASSIC), [NAIM]);
    expect(html).toMatch(
      /nga <a [^>]*href="\/klasiket\/naim-frasheri"[^>]*>Naim Frashëri<\/a> <span class="text-muted">\(1846⁠–⁠1900\)<\/span> <span class="text-muted">\(Autor\)<\/span>/,
    );
    expect(classicLog).toContainEqual(["overlaps", ["pd_work_ids", ["00000000-0000-4000-8000-0000000000b1"]]]);
  });

  it("shows the year only for Botuar për herë të parë", async () => {
    const html = await render(book(CLASSIC), [NAIM]);
    expect(html).toMatch(/Botuar për herë të parë[\s\S]{0,200}?>1886</);
    expect(html).not.toContain("janar 1886");
  });

  it("Q2 a: a work with no live classic author keeps the Libraria search link and no years", async () => {
    const html = await render(book(CLASSIC), []);
    expect(html).toMatch(/nga <a [^>]*href="\/librari\?q=Naim[^"]*"[^>]*>Naim Frashëri<\/a> <span class="text-muted">\(Autor\)<\/span>/);
    expect(html).not.toContain("/klasiket/");
    expect(html).not.toContain("1846");
  });

  it("a book that is not a public-domain edition never asks for classic authors", async () => {
    await render(book(), [NAIM]);
    expect(classicLog).toEqual([]);
  });

  it("never adds the rejected book-page label or the buy-box why-free line", async () => {
    const html = await render(book(CLASSIC), [NAIM]);
    expect(html).not.toContain("Klasik shqiptar");
    expect(html).not.toContain("falas për të gjithë");
    expect(html).not.toContain("pronë e të gjithëve");
  });
});
