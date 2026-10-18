import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// iPhone step (I4): with no author photo, "About the author" shows the
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
  series_id: null, genre: "Fiction", description: "About it.", language: null,
  created_at: "2026-09-01T00:00:00Z", published_at: "2026-09-02T00:00:00Z", pen_name: "Jo Pen",
  profiles: { public_author_name: "Arben Leka", bio: null, avatar_path: null as string | null },
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

async function render(book: typeof BOOK): Promise<string> {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    rpc: async () => ({ data: null }),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }) }) },
    from: (table: string) =>
      table === "books" ? queryStub({ data: [] }, { data: book }) : queryStub({ data: [] }, { data: null }),
  }));
  const element = await BookDetailPage({ params: Promise.resolve({ id: book.id }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

function aboutTheAuthor(html: string): string {
  const start = html.indexOf(">About the author</h2>");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("Book page: About the author placeholder (I4)", () => {
  it("no photo -> the author's initials (not the pen name's), aria-hidden, in the page's own circle", async () => {
    const section = aboutTheAuthor(await render(BOOK));
    const placeholder = section.match(/<div aria-hidden="true" class="([^"]*)">([^<]*)<\/div>/);
    expect(placeholder).not.toBeNull();
    expect(placeholder![2]).toBe("AL");
    const classes = placeholder![1].split(" ");
    for (const c of ["bg-[#d9e2dc]", "size-20", "sm:size-[5.5rem]", "rounded-full", "font-semibold", "text-foreground/70", "text-lg", "sm:text-xl"]) {
      expect(classes).toContain(c);
    }
    expect(section).not.toContain("<img");
  });

  it("with a photo -> the photo, no initials", async () => {
    const section = aboutTheAuthor(await render({ ...BOOK, profiles: { ...BOOK.profiles, avatar_path: "a/avatar.png" } }));
    expect(section).toContain("<img");
    expect(section).not.toMatch(/<div aria-hidden="true"[^>]*>AL<\/div>/);
  });
});
