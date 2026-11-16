import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// K6 free Albanian classics (Renato 2026-11-16, Q1 b, Q3 a, Q5 b): the
// classic author page against a stubbed client. Only an author listed
// by public_classic_authors (a live work) with a live book has a page;
// no label, no Follow button, no "why free" line.

type Call = [string, unknown[]];
let classicRow: unknown = null;
let bookList: unknown[] = [];
let log: Call[] = [];

function queryStub(table: string) {
  let single = false;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) =>
          resolve(table === "public_classic_authors" ? { data: single ? classicRow : [] } : { data: bookList });
      }
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return (...args: unknown[]) => (log.push([`${table}.${String(prop)}`, args]), chain);
    },
  });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => queryStub(table),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }) }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const { default: ClassicAuthorPage, generateMetadata } = await import("./page");

const NAIM = {
  id: "ca-1", slug: "naim-frasheri", name: "Naim Frashëri", birth_year: 1846, death_year: 1900,
  birth_place: "Frashër", death_place: "Stamboll", bio: "Poet i Rilindjes.\nShkroi Bagëti e bujqësi.",
  pd_work_ids: ["w1", "w2"],
};
const BOOK = {
  id: "b1", title: "Bagëti e bujqësi", genre: "Poezi", price_all: 0, pen_name_id: null,
  original_author: "Naim Frashëri", is_adult: false, cover_path: "c/b1.png", status: "published",
};

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function render(slug = "naim-frasheri") {
  const element = await ClassicAuthorPage(params(slug));
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librum.al");
  classicRow = NAIM;
  bookList = [BOOK];
  log = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("K6: the classic author page", () => {
  it("shows name and years, the life line, the bio, the works and the box back to all classics", async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Naim Frashëri <span class="text-muted">\(1846⁠–⁠1900\)<\/span><\/h1>/);
    expect(html).toContain("Lindi në Frashër, 1846 · Vdiq në Stamboll, 1900");
    expect(html).toContain("Poet i Rilindjes.\nShkroi Bagëti e bujqësi.");
    expect(html).toContain("whitespace-pre-line");
    expect(html).toContain(">Veprat në Librum</h2>");
    expect(html).toContain('href="/libra/b1"');
    expect(html).toContain("Më shumë klasikë shqiptarë, falas");
    expect(html.match(/href="\/librari\?maxPrice=0"/g)).toHaveLength(2);
  });

  it("asks for this slug and for live, priced editions of the author's live works only", async () => {
    await render();
    expect(log).toContainEqual(["public_classic_authors.eq", ["slug", "naim-frasheri"]]);
    expect(log).toContainEqual(["public_books.in", ["pd_work_id", ["w1", "w2"]]]);
    expect(log).toContainEqual(["public_books.eq", ["status", "published"]]);
  });

  it("Q5 b, Q1 b, Q3 a: no label, no Follow button, no why-free line", async () => {
    const html = await render();
    expect(html).not.toContain("Klasik shqiptar");
    expect(html).not.toContain("Ndiq");
    expect(html).not.toContain("pronë e të gjithëve");
  });

  it("missing places read Lindi më / Vdiq më", async () => {
    classicRow = { ...NAIM, birth_place: null, death_place: null };
    expect(await render()).toContain("Lindi më 1846 · Vdiq më 1900");
  });

  it("Q3 a: no live author, no live book, or a malformed slug is a 404 (and no metadata)", async () => {
    classicRow = null;
    await expect(render()).rejects.toThrow();
    expect(await generateMetadata(params("naim-frasheri"))).toEqual({});
    classicRow = NAIM;
    bookList = [];
    await expect(render()).rejects.toThrow();
    log = [];
    await expect(render("Naim Frasheri")).rejects.toThrow();
    expect(log).toEqual([]);
  });

  it("metadata: title with years and a canonical link to /klasiket/<slug>", async () => {
    const meta = await generateMetadata(params("naim-frasheri"));
    expect(meta.title).toBe("Naim Frashëri (1846–1900)");
    expect(meta.alternates).toEqual({ canonical: "https://librum.al/klasiket/naim-frasheri" });
  });
});
