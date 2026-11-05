import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BD15 P8: the reader side of the BD15 book details on the real book
// page (same stubbed-client harness as seo.rendered.test.ts): the rich
// description, all categories, 18+, reading age, edition number, plain
// text in meta tags and schema.org data, and the "Ju mund të pëlqeni"
// shelf by any shared category (Q2 a).

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("createClient not stubbed");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ insert: async () => ({ data: null }) }) }),
}));
vi.mock("./actions", () => ({
  buyBook: vi.fn(), getFreeBook: vi.fn(), submitReview: vi.fn(),
  addToWishlist: vi.fn(), removeFromWishlist: vi.fn(),
}));

const { default: BookDetailPage, generateMetadata } = await import("./page");

const BOOK_ID = "00000000-f1c9-4000-8000-000000000800";
const PEN_ID = "00000000-0000-4000-8000-0000000000e8";
const BASE = {
  id: BOOK_ID, title: "Libri P8", subtitle: null, price_cents: 0, price_all: 499,
  status: "published", cover_path: null, series_id: null,
  genre: "Fantazi", categories: ["Fantazi", "Romancë"], is_adult: false, reading_age_min: 12,
  edition_number: 2, edition: null,
  description: "Një **roman** për *të gjithë*.\n\n- pika e parë\n- <script>alert(1)</script>",
  language: "sq", isbn: null, publisher: null,
  created_at: "2026-09-01T00:00:00Z", published_at: "2026-09-02T00:00:00Z",
  pen: { id: PEN_ID, name: "Ana Shkrimtarja", bio: null, avatar_path: null, links: [] },
};

type Call = [string, unknown[]];
let publicBookQueries: Call[][] = [];

function queryStub(listResult: unknown, rowResult?: unknown, log?: Call[]) {
  let single = false;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const result = single && rowResult !== undefined ? rowResult : listResult;
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return (...args: unknown[]) => (log?.push([String(prop), args]), chain);
    },
  });
  return chain;
}

function stub(book: Record<string, unknown>) {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    rpc: vi.fn(async () => ({ data: false })),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      if (table === "public_books") {
        const log: Call[] = [];
        publicBookQueries.push(log);
        return queryStub({ data: [] }, { data: book }, log);
      }
      return queryStub({ data: [] }, { data: null });
    },
  }));
}

async function render(book: Record<string, unknown>) {
  stub(book);
  const element = await BookDetailPage({
    params: Promise.resolve({ id: String(book.id) }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

// The shelf query is the public_books query that asks for overlapping
// categories (or, before P8, an equal genre).
function shelfQuery(): Call[] | undefined {
  return publicBookQueries.find((q) => q.some(([m]) => m === "overlaps" || (m === "eq" && q.some(([, a]) => a[0] === "genre"))));
}

function detailsBlock(html: string): string {
  const start = html.indexOf("Të dhënat e librit");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</dl>", start));
}

let n = 0;
// A fresh id per render: getBookForDetail is wrapped in React cache().
function book(extra: Record<string, unknown> = {}) {
  n += 1;
  return { ...BASE, id: BOOK_ID.slice(0, -2) + String(n).padStart(2, "0"), ...extra };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librum.al");
  publicBookQueries = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("BD15 P8: the rich description", () => {
  it("renders bold, italic and lists, never the marks and never author HTML", async () => {
    const html = await render(book());
    expect(html).toContain("<strong");
    expect(html).toContain(">roman</strong>");
    expect(html).toContain("<em>të gjithë</em>");
    expect(html).toMatch(/<ul[^>]*><li>pika e parë<\/li><li>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li><\/ul>/);
    expect(html).not.toContain("**roman**");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("meta tags and schema.org data carry the plain text, without marks", async () => {
    const b = book();
    stub(b);
    const metadata = await generateMetadata({ params: Promise.resolve({ id: b.id }) });
    expect(metadata.description).toBe("Një roman për të gjithë. • pika e parë • <script>alert(1)</script>");
    expect(metadata.openGraph?.description).toBe(metadata.description);
    const html = await render(book());
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    expect(ld.description).toBe("Një roman për të gjithë. • pika e parë • <script>alert(1)</script>");
    expect(ld.genre).toEqual(["Fantazi", "Romancë"]);
  });
});

describe("BD15 P8: book details (Q3 a)", () => {
  it("lists every category as a Libraria link, the reading age and the edition number", async () => {
    const dl = detailsBlock(await render(book()));
    expect(dl).toContain(">Zhanret<");
    expect(dl).toContain('href="/librari?genre=Fantazi"');
    expect(dl).toContain('href="/librari?genre=Romanc%C3%AB"');
    expect(dl).toContain(">Mosha<");
    expect(dl).toContain("12+ vjeç");
    expect(dl).toContain(">Botimi<");
    expect(dl).toMatch(/>Botimi<\/dt><dd[^>]*>2<\/dd>/);
    expect(dl).not.toContain("Përmbajtja");
  });

  it("one category reads Zhanri", async () => {
    const dl = detailsBlock(await render(book({ categories: ["Fantazi"] })));
    expect(dl).toContain(">Zhanri<");
    expect(dl).not.toContain(">Zhanret<");
  });

  it("an 18+ book shows Përmbajtja: 18+ (për të rritur) and no Mosha row", async () => {
    const dl = detailsBlock(await render(book({ is_adult: true, reading_age_min: 18 })));
    expect(dl).toContain(">Përmbajtja<");
    expect(dl).toContain("18+ (për të rritur)");
    expect(dl).not.toContain(">Mosha<");
  });

  it("an older book keeps its free-text edition; no edition and no age means no rows", async () => {
    const legacy = detailsBlock(await render(book({ edition_number: null, edition: "Botim i rishikuar" })));
    expect(legacy).toContain("Botim i rishikuar");
    const bare = detailsBlock(await render(book({ edition_number: null, edition: null, reading_age_min: null })));
    expect(bare).not.toContain(">Botimi<");
    expect(bare).not.toContain(">Mosha<");
  });

  it("a row the backfill missed (no categories) falls back to its genre", async () => {
    const dl = detailsBlock(await render(book({ categories: null })));
    expect(dl).toContain(">Zhanri<");
    expect(dl).toContain('href="/librari?genre=Fantazi"');
  });
});

describe("BD15 P8: Ju mund të pëlqeni (Q2 a)", () => {
  it("matches any shared category and keeps 18+ books for an ordinary book", async () => {
    await render(book());
    const q = shelfQuery();
    expect(q).toBeDefined();
    expect(q).toContainEqual(["overlaps", ["categories", ["Fantazi", "Romancë"]]]);
    expect(q!.some(([m, a]) => m === "eq" && a[0] === "genre")).toBe(false);
    expect(q!.some(([m, a]) => m === "eq" && a[0] === "is_adult")).toBe(false);
  });

  it.each([["Për fëmijë"], ["Për të rinj"]])("a %s book never shows 18+ books", async (young) => {
    await render(book({ genre: young, categories: [young, "Fantazi"], reading_age_min: 6 }));
    const q = shelfQuery();
    expect(q).toContainEqual(["overlaps", ["categories", [young, "Fantazi"]]]);
    expect(q).toContainEqual(["eq", ["is_adult", false]]);
  });
});
