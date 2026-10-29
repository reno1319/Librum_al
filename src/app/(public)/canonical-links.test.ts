import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P2 (Renato 4b): author, series and bundle pages carry a canonical link
// to their bare Albanian address. Each page's real generateMetadata()
// over a stubbed Supabase client.

let tableRows: Record<string, { row: unknown; list: unknown[] }> = {};

function queryStub(table: string) {
  let single = false;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const entry = tableRows[table] ?? { row: null, list: [] };
        return (resolve: (v: unknown) => unknown) => resolve({ data: single ? entry.row : entry.list });
      }
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return () => chain;
    },
  });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => queryStub(table) }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const { generateMetadata: authorMetadata } = await import("./autore/[id]/page");
const { generateMetadata: seriesMetadata } = await import("./seri/[id]/page");
const { generateMetadata: bundleMetadata } = await import("./paketa/[id]/page");

const PEN_ID = "00000000-0000-4000-8000-0000000000e1";
const SERIES_ID = "00000000-0000-4000-8000-0000000000c1";
const BUNDLE_ID = "00000000-0000-4000-8000-0000000000d1";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librum.al");
  tableRows = {
    public_pen_names: { row: { id: PEN_ID, name: "Ana Shkrimtarja" }, list: [] },
    public_series: { row: { id: SERIES_ID, title: "Trilogjia", pen: null }, list: [] },
    public_books: { row: null, list: [{ id: "b1", title: "Libri", series_position: 1, created_at: "2026-09-01T00:00:00Z" }] },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("author page", () => {
  it("links to its bare /autore/<pen name id> address", async () => {
    expect((await authorMetadata(params(PEN_ID))).alternates).toEqual({
      canonical: `https://librum.al/autore/${PEN_ID}`,
    });
  });

  it("a missing pen name still gets no metadata at all", async () => {
    tableRows.public_pen_names = { row: null, list: [] };
    expect(await authorMetadata(params(PEN_ID))).toEqual({});
  });
});

describe("series page", () => {
  it("links to its bare /seri/<id> address", async () => {
    expect((await seriesMetadata(params(SERIES_ID))).alternates).toEqual({
      canonical: `https://librum.al/seri/${SERIES_ID}`,
    });
  });

  it("a series with nothing public still gets no metadata at all", async () => {
    tableRows.public_books = { row: null, list: [] };
    expect(await seriesMetadata(params(SERIES_ID))).toEqual({});
  });
});

describe("bundle page", () => {
  it("keeps its title and links to its bare /paketa/<id> address", async () => {
    const metadata = await bundleMetadata(params(BUNDLE_ID.toUpperCase()));
    expect(metadata.title).toBe("Paketë");
    expect(metadata.alternates).toEqual({ canonical: `https://librum.al/paketa/${BUNDLE_ID}` });
  });

  it("a malformed address gets no canonical link", async () => {
    const metadata = await bundleMetadata(params('x"><script>'));
    expect(metadata.title).toBe("Paketë");
    expect(metadata.alternates).toBeUndefined();
  });
});

describe("when the site address can't be resolved", () => {
  it("every page keeps its metadata, without a canonical link", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    expect((await authorMetadata(params(PEN_ID))).title).toBe("Ana Shkrimtarja");
    expect((await authorMetadata(params(PEN_ID))).alternates).toBeUndefined();
    expect((await seriesMetadata(params(SERIES_ID))).alternates).toBeUndefined();
    expect((await bundleMetadata(params(BUNDLE_ID))).alternates).toBeUndefined();
  });
});
