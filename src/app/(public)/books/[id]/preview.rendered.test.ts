import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// PREVIEW-1 (A5, Renato 1a 2a 3a 7a): "Preview my book" is the book's own
// page, opened by its author. Rendered from the real Server Component
// over a stubbed Supabase client (same harness as
// paid-checkout-surface.rendered.test.ts).

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
const READER_ID = "9229f938-0000-4000-8000-000000000000";
const BASE_BOOK = {
  id: BOOK_ID, title: "Preview Book", price_cents: 0, price_all: 199, author_id: AUTHOR_ID,
  status: "draft", cover_path: null, series_id: null, genre: "Fiction",
  description: "About it.", language: null, created_at: "2026-09-01T00:00:00Z",
  published_at: null,
};
const STRIP = "Preview. This book isn&#x27;t in the Bookstore.";

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

function stub(opts: { user: { id: string } | null; book: Record<string, unknown> | null; owned?: boolean }) {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    rpc: vi.fn(async (name: string) => (name === "user_owns_book" ? { data: opts.owned ?? false } : { data: null })),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      const book = opts.book;
      if (table === "public_books") {
        if (!book) return queryStub({ data: [] }, { data: null });
        const publicPart: Record<string, unknown> = { ...book };
        delete publicPart.author_id;
        return queryStub({ data: [] }, { data: publicPart });
      }
      if (table === "books") {
        const mine = !!book && !!opts.user && opts.user.id === book.author_id;
        return queryStub({ data: [] }, { data: mine ? { id: book.id } : null });
      }
      return queryStub({ data: [] }, { data: null });
    },
  }));
}

async function render(opts: { user: { id: string } | null; book: Record<string, unknown>; owned?: boolean }) {
  stub(opts);
  const element = await BookDetailPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

describe("the author's preview of an unpublished book", () => {
  it("shows the Preview strip, Read sample, and the author's own box (Manage book, Download EPUB)", async () => {
    const html = await render({ user: { id: AUTHOR_ID }, book: BASE_BOOK });
    expect(html).toContain(STRIP);
    expect(html.indexOf(STRIP)).toBeLessThan(html.indexOf('aria-label="Breadcrumb"'));
    expect(html).toContain("Read sample");
    expect(html).toContain("Manage book");
    expect(html).toContain(`href="/api/books/${BOOK_ID}/download"`);
    expect(html).not.toContain(">Buy");
  });

  it("a live book's author gets Read sample but no Preview strip", async () => {
    const html = await render({
      user: { id: AUTHOR_ID },
      book: { ...BASE_BOOK, status: "published", published_at: "2026-09-02T00:00:00Z" },
    });
    expect(html).not.toContain(STRIP);
    expect(html).toContain("Read sample");
    expect(html).toContain("Manage book");
  });

  it("an earlier buyer of an unpublished book sees no Preview strip and no Read sample", async () => {
    const html = await render({ user: { id: READER_ID }, book: BASE_BOOK, owned: true });
    expect(html).not.toContain(STRIP);
    expect(html).not.toContain("Read sample");
    expect(html).toContain("You own this book");
  });

  it("anyone else gets a 404 for an unpublished book", async () => {
    await expect(render({ user: { id: READER_ID }, book: BASE_BOOK })).rejects.toThrow();
    await expect(render({ user: null, book: BASE_BOOK })).rejects.toThrow();
  });
});

describe("noindex (7a)", () => {
  it.each([
    ["a draft", { ...BASE_BOOK }],
    ["a book with another unpublished status", { ...BASE_BOOK, status: "archived" }],
  ])("%s: robots noindex, nofollow, and no book-specific metadata", async (_label, book) => {
    stub({ user: { id: AUTHOR_ID }, book });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: BOOK_ID }) });
    expect(metadata).toEqual({ robots: { index: false, follow: false } });
  });

  it("a missing book: robots noindex too", async () => {
    stub({ user: null, book: null });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: BOOK_ID }) });
    expect(metadata).toEqual({ robots: { index: false, follow: false } });
  });

  it("a live book keeps its normal metadata, with no robots rule", async () => {
    stub({ user: null, book: { ...BASE_BOOK, status: "published", published_at: "2026-09-02T00:00:00Z" } });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: BOOK_ID }) });
    expect(metadata.title).toBe("Preview Book");
    expect(metadata.robots).toBeUndefined();
  });
});
