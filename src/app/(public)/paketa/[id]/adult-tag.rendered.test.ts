import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BD15 P8 (F1 D2 a): the bundle page shows 18+ when any PUBLISHED book
// in the bundle is 18+, read live from the member books. A member that
// is not published (the author previewing their own bundle) or that the
// visitor cannot read does not count. Each 18+ member's own card carries
// the tag too (Q1 a).

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("createClient not stubbed");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("./actions", () => ({ buyBundle: vi.fn() }));

const { default: BundleDetailPage } = await import("./page");

const BUNDLE_ID = "11111111-1111-4111-8111-1111111111b8";
const BUNDLE = {
  id: BUNDLE_ID, title: "Pako P8", description: null, status: "published", price_all: 299,
  pen: { id: "22222222-2222-4222-8222-222222222222", name: "Ana" },
};

function member(id: string, extra: Record<string, unknown>) {
  return {
    book_id: id,
    books: {
      id, title: `Libri ${id}`, status: "published", is_adult: false, price_all: 199,
      genre: "Fantazi", cover_path: null, pen_name_id: null, original_author: null, ...extra,
    },
  };
}

function chain(listResult: unknown, rowResult: unknown) {
  let single = false;
  const c: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve(single ? rowResult : listResult);
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), c);
      return () => c;
    },
  });
  return c;
}

async function render(members: unknown[]) {
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    rpc: async () => ({ data: false }),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      if (table === "public_bundles") return chain({ data: [] }, { data: BUNDLE });
      if (table === "bundle_books") return chain({ data: members }, { data: null });
      return chain({ data: [] }, { data: null });
    },
  }));
  const element = await BundleDetailPage({
    params: Promise.resolve({ id: BUNDLE_ID }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

function header(html: string) {
  return html.slice(0, html.indexOf("</h1>"));
}

describe("BD15 P8: 18+ on the bundle page", () => {
  it("shows 18+ by the title when a published member book is 18+, and on that book's card", async () => {
    const html = await render([member("a", {}), member("b", { is_adult: true, reading_age_min: 18 })]);
    expect(header(html)).toContain("18+");
    expect(html.match(/aria-hidden="true">18\+<\/span>/g)?.length).toBe(2);
  });

  it("shows no 18+ when no member is 18+", async () => {
    const html = await render([member("a", {}), member("b", {})]);
    expect(html).not.toContain("18+");
  });

  it("an 18+ member that is not published, or unreadable, does not count", async () => {
    const html = await render([member("a", {}), member("b", { is_adult: true, status: "draft" }), { book_id: "c", books: null }]);
    expect(header(html)).not.toContain("18+");
  });
});
