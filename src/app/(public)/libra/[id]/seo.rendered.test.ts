import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// P2 (Renato 10-29): the book page's canonical link and schema.org Book
// data, rendered from the real Server Component over a stubbed Supabase
// client (same harness as preview.rendered.test.ts).

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

const BOOK_ID = "00000000-f1c9-4000-8000-000000000003";
const AUTHOR_ID = "1f9d4948-0000-4000-8000-000000000000";
const PEN_ID = "00000000-0000-4000-8000-0000000000e1";
const LIVE_BOOK = {
  id: BOOK_ID, title: "Libri </script><b>x</b>", subtitle: null, price_cents: 0, price_all: 499,
  author_id: AUTHOR_ID, status: "published", cover_path: null, series_id: null,
  genre: "Letërsi artistike", description: "About it.", language: "sq", isbn: null, publisher: null,
  created_at: "2026-09-01T00:00:00Z", published_at: "2026-09-02T00:00:00Z",
  pen: { id: PEN_ID, name: "Ana Shkrimtarja", bio: null, avatar_path: null, links: [] },
};

function queryStub(listResult: unknown, rowResult?: unknown) {
  let single = false;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const result = single && rowResult !== undefined ? rowResult : listResult;
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return () => chain;
    },
  });
  return chain;
}

function stub(opts: { user: { id: string } | null; book: Record<string, unknown> }) {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    rpc: vi.fn(async () => ({ data: false })),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      const book = opts.book;
      if (table === "public_books") {
        const publicPart: Record<string, unknown> = { ...book };
        delete publicPart.author_id;
        return queryStub({ data: [] }, { data: publicPart });
      }
      if (table === "books") {
        const mine = !!opts.user && opts.user.id === book.author_id;
        return queryStub({ data: [] }, { data: mine ? { id: book.id } : null });
      }
      return queryStub({ data: [] }, { data: null });
    },
  }));
}

async function render(
  opts: { user: { id: string } | null; book: Record<string, unknown> },
  searchParams: Record<string, string> = {},
) {
  stub(opts);
  const element = await BookDetailPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

function jsonLdBlocks(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://librum.al");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("book page canonical link", () => {
  it("is the bare https://librum.al/libra/<id> address", async () => {
    stub({ user: null, book: LIVE_BOOK });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: BOOK_ID }) });
    expect(metadata.alternates).toEqual({ canonical: `https://librum.al/libra/${BOOK_ID}` });
  });

  it("is left out, without breaking the page's metadata, when the site address can't be resolved", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    stub({ user: null, book: LIVE_BOOK });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: BOOK_ID }) });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.title).toBe(LIVE_BOOK.title);
  });

  it("an unpublished book still gets only noindex", async () => {
    stub({ user: { id: AUTHOR_ID }, book: { ...LIVE_BOOK, status: "draft" } });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: BOOK_ID }) });
    expect(metadata).toEqual({ robots: { index: false, follow: false } });
  });
});

describe("book page schema.org data", () => {
  it("a live book has exactly one Book block, naming its pen name, with no price while checkout is off", async () => {
    const blocks = jsonLdBlocks(await render({ user: null, book: LIVE_BOOK }, { error: "x" }));
    expect(blocks).toHaveLength(1);
    const data = JSON.parse(blocks[0]);
    expect(data["@type"]).toBe("Book");
    expect(data.url).toBe(`https://librum.al/libra/${BOOK_ID}`);
    expect(data.name).toBe(LIVE_BOOK.title);
    expect(data.author).toEqual({ "@type": "Person", name: "Ana Shkrimtarja", url: `https://librum.al/autore/${PEN_ID}` });
    expect(data).not.toHaveProperty("offers");
  });

  it("an author-typed </script> can't end the block early", async () => {
    const html = await render({ user: null, book: LIVE_BOOK });
    expect(jsonLdBlocks(html)[0]).not.toContain("<");
    expect(html).not.toContain("<b>x</b>");
  });

  it("the author's preview of an unpublished book has none", async () => {
    const html = await render({ user: { id: AUTHOR_ID }, book: { ...LIVE_BOOK, status: "draft" } });
    expect(html).toContain("Parapamje.");
    expect(jsonLdBlocks(html)).toHaveLength(0);
  });

  it("a live book still renders, with no block, when the site address can't be resolved", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    const html = await render({ user: null, book: LIVE_BOOK });
    expect(html).toContain("Ana Shkrimtarja");
    expect(jsonLdBlocks(html)).toHaveLength(0);
  });
});
