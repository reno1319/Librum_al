import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ADMIN-2-TAKEDOWN (G, M4): the Edit page of a book Librum took down.
// Same harness as f4-page.rendered.test.ts; the takedown read is mocked
// so each case says exactly what the page was told.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("../../../actions", () => ({
  updateBook: { bind: () => async () => undefined },
  addContributor: { bind: () => async () => undefined },
  removeContributor: { bind: () => async () => undefined },
  publishBook: { bind: () => async () => undefined },
  unpublishBook: { bind: () => async () => undefined },
  deleteBook: { bind: () => async () => undefined },
  cancelBookReview: { bind: () => async () => undefined },
}));
// ADMIN-3-REVIEW: a draft with no approval and nothing pending -- the
// Publish control reads "Send for review" (its own states are in
// review-state.rendered.test.ts).
vi.mock("@/lib/book-reviews", () => ({
  getBookReviewState: async () => ({ kind: "ok", pending: false, approvalValid: false, latestSentBack: null }),
}));

const USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
const BOOK_ID = "c3d4e5f6-2222-4222-8222-abcdef222222";

let book: Record<string, unknown>;
const tableData: Record<string, unknown> = {};

function chain(table: string) {
  const resolve = () => Promise.resolve({ data: table === "books" ? book : tableData[table] ?? null, error: null });
  const proxy: object = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => resolve().then(f, r);
        return () => proxy;
      },
    },
  );
  return proxy;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
    from: (table: string) => chain(table),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }) }) },
  }),
}));

let features = { penName: true, rights: true };
vi.mock("@/lib/catalog-schema-features", () => ({ getCatalogSchemaFeatures: async () => features }));
type RightsState =
  | { kind: "present"; declaration: { basis: "own_rights" | "public_domain" } }
  | { kind: "none" }
  | { kind: "unavailable" };
let rightsState: RightsState = { kind: "none" };
vi.mock("@/lib/book-rights", () => ({ getRightsDeclarationState: async () => rightsState }));

type TakedownResult = {
  state: { kind: "none" } | { kind: "active"; takedown: unknown } | { kind: "unavailable" };
  notice: { takenDownAt: string; reason: string; message: string; bundleTitles: string[] } | null;
};
let takedown: TakedownResult = { state: { kind: "none" }, notice: null };
vi.mock("@/lib/book-takedowns", () => ({ loadAuthorTakedownNoticeForBook: async () => takedown }));

const { default: EditBookPage } = await import("./page");

async function render(): Promise<string> {
  const element = await EditBookPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

beforeEach(() => {
  book = {
    id: BOOK_ID,
    author_id: USER_ID,
    title: "Libri im",
    subtitle: null,
    description: "A real description.",
    keywords: "",
    isbn: null,
    language: "sq",
    genre: "Fiction",
    publisher: null,
    edition: null,
    original_publication_date: null,
    series_id: null,
    series_position: null,
    price_all: 0,
    price_cents: 0,
    status: "draft",
    cover_path: null,
    file_path: null,
    pen_name: null,
  };
  tableData.series = [];
  tableData.book_contributors = [];
  tableData.profiles = { display_name: "Renato Kalemi", public_author_name: "Arben Leka" };
  features = { penName: true, rights: true };
  rightsState = { kind: "present", declaration: { basis: "own_rights" } };
  takedown = { state: { kind: "none" }, notice: null };
});

describe("Edit page: a book Librum took down", () => {
  it("shows the notice in place of the Publish control", async () => {
    takedown = {
      state: { kind: "active", takedown: {} },
      notice: {
        takenDownAt: "2026-10-19T10:00:00Z",
        reason: "copyright",
        message: "Please send proof",
        bundleTitles: ["Set A"],
      },
    };
    const html = await render();
    expect(html).toContain("Taken down by Librum</span>");
    expect(html).toContain("Taken down by Librum on Oct 19, 2026. Reason: Copyright complaint.");
    expect(html).toContain("Please send proof.");
    expect(html).toContain("We also unpublished: Set A.");
    expect(html).toContain("Questions? Write to support@librum.al");
    expect(html).not.toContain("Send for review</button>");
  });

  it("disables Publish with the generic sentence when the takedown can't be read", async () => {
    takedown = { state: { kind: "unavailable" }, notice: null };
    const html = await render();
    expect(html).not.toContain("Taken down by Librum");
    const start = html.lastIndexOf("<button", html.indexOf("Send for review</button>"));
    expect(html.slice(start, html.indexOf("Send for review</button>"))).toContain('disabled=""');
  });

  it("is unchanged without a takedown", async () => {
    const html = await render();
    expect(html).not.toContain("Taken down by Librum");
    const start = html.lastIndexOf("<button", html.indexOf("Send for review</button>"));
    expect(html.slice(start, html.indexOf("Send for review</button>"))).not.toContain('disabled=""');
  });
});
