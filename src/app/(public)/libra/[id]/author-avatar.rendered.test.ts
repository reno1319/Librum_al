import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// iPhone step (I4): with no author photo, "Rreth autorit" shows the
// author's initials (as the author's own page does) instead of an empty
// circle. Rendered from the real Server Component over a stubbed client.

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

const { default: BookDetailPage } = await import("./page");

const BOOK = {
  id: "00000000-1414-4000-8000-000000000001", title: "Libri", price_cents: 0, price_all: 199,
  author_id: "1f9d4948-1414-4000-8000-000000000000", status: "published", cover_path: null,
  series_id: null, genre: "Letërsi artistike", description: "About it.", language: null,
  created_at: "2026-09-01T00:00:00Z", published_at: "2026-09-02T00:00:00Z", pen_name: "Jo Pen",
  pen_name_id: "f0000000-1414-4000-8000-000000000001",
  // PEN-NAMES-1: the book's pen name, embedded from public_pen_names.
  pen: {
    id: "f0000000-1414-4000-8000-000000000001", name: "Jo Pen", bio: null as string | null,
    avatar_path: null as string | null, links: [] as unknown,
  },
};

function queryStub(listResult: unknown, rowResult: unknown) {
  let single = false;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve(single ? rowResult : listResult);
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return () => chain;
    },
  });
  return chain;
}

// PEN-NAMES-2: the page reads the book from public_books (no author_id)
// and asks "is this mine?" with an own-row books query. The fixture's
// author_id is the hidden truth: stripped from the public row, used only
// to answer the own-row query as RLS would.
function bookTableStub(table: string, book: Record<string, unknown>, user: { id: string } | null | undefined) {
  if (table === "public_books") {
    const publicPart: Record<string, unknown> = { ...book };
    delete publicPart.author_id;
    return queryStub({ data: [] }, { data: publicPart });
  }
  if (table === "books") {
    const mine = !!user && user.id === book.author_id;
    return queryStub({ data: [] }, { data: mine ? { id: book.id } : null });
  }
  return null;
}

async function render(book: typeof BOOK): Promise<string> {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    rpc: async () => ({ data: null }),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }) }) },
    from: (table: string) =>
      bookTableStub(table, book, null) ?? queryStub({ data: [] }, { data: null }),
  }));
  const element = await BookDetailPage({ params: Promise.resolve({ id: book.id }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

function aboutTheAuthor(html: string): string {
  const start = html.indexOf(">Rreth autorit</h2>");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("Book page: Rreth autorit placeholder (I4)", () => {
  // PEN-NAMES-1 (3a): "Rreth autorit" is the book's pen name, so the
  // initials are the pen name's.
  it("no photo -> the pen name's initials, aria-hidden, in the page's own circle", async () => {
    const section = aboutTheAuthor(await render(BOOK));
    const placeholder = section.match(/<div aria-hidden="true" class="([^"]*)">([^<]*)<\/div>/);
    expect(placeholder).not.toBeNull();
    expect(placeholder![2]).toBe("JP");
    const classes = placeholder![1].split(" ");
    for (const c of ["bg-[#d9e2dc]", "size-20", "sm:size-[5.5rem]", "rounded-full", "font-semibold", "text-foreground/70", "text-lg", "sm:text-xl"]) {
      expect(classes).toContain(c);
    }
    expect(section).not.toContain("<img");
  });

  it("with a photo -> the photo, no initials", async () => {
    const photo = "d0000000-1414-4000-8000-000000000001/pen-name.png";
    const section = aboutTheAuthor(await render({ ...BOOK, pen: { ...BOOK.pen, avatar_path: photo } }));
    expect(section).toContain("<img");
    expect(section).toContain(`https://cdn.example/${photo}`);
    expect(section).not.toMatch(/<div aria-hidden="true"[^>]*>JP<\/div>/);
  });

  it("bio and links only when set; links are nofollow ugc, https only, and the profile link goes to the pen name's page", async () => {
    const plain = aboutTheAuthor(await render(BOOK));
    expect(plain).not.toContain("rel=");
    expect(plain).toContain('href="/autore/f0000000-1414-4000-8000-000000000001"');
    expect(plain).not.toContain(BOOK.author_id);

    const section = aboutTheAuthor(
      await render({
        ...BOOK,
        pen: { ...BOOK.pen, bio: "Shkruan në Tiranë.", links: ["https://example.com/jo", "javascript:alert(1)"] },
      }),
    );
    expect(section).toContain("Shkruan në Tiranë.");
    expect(section).toContain('href="https://example.com/jo"');
    expect(section).toContain('rel="nofollow ugc noopener noreferrer"');
    expect(section).not.toContain("javascript:");
  });
});
