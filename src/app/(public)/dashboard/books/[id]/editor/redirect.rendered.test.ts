import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BD15 P5a (P4 audit, render test for the editor redirect): the editor
// takes exactly the drafts the edit page sends it -- not waiting for
// review, not taken down, review state readable -- and sends every other
// book back to the edit page (the edit page's own redirect is covered in
// edit/review-state.rendered.test.ts). The two rules are each other's
// complement, so a book is never bounced between the pages.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("../../../editor-actions", () => ({ saveBookDetails: { bind: () => async () => undefined } }));
vi.mock("../../../actions", () => ({
  saveBookContent: { bind: () => async () => undefined },
  saveBookPricing: { bind: () => async () => undefined },
}));

type ReviewState =
  | { kind: "ok"; pending: boolean; approvalValid: boolean; latestSentBack: null }
  | { kind: "unavailable" };
let reviewState: ReviewState;
vi.mock("@/lib/book-reviews", () => ({ getBookReviewState: async () => reviewState }));
type Takedown = { kind: "none" } | { kind: "active" } | { kind: "unavailable" };
let takedown: Takedown;
vi.mock("@/lib/book-takedowns", () => ({ getActiveTakedownState: async () => takedown }));
vi.mock("@/lib/book-rights", () => ({ getRightsDeclarationState: async () => ({ kind: "none" }) }));
vi.mock("@/lib/book-ai-disclosure", () => ({ readAiDisclosure: async () => ({ ok: true, answer: null }) }));

const USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
const BOOK_ID = "c3d4e5f6-2222-4222-8222-abcdef222222";
let book: Record<string, unknown>;

function chain(table: string) {
  const resolve = () => Promise.resolve({ data: table === "books" ? book : [], error: null });
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

const { default: BookEditorPage } = await import("./page");

async function render(): Promise<string> {
  const element = await BookEditorPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve({ tab: "details" }),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

const TO_EDIT_PAGE = `REDIRECT:/dashboard/books/${BOOK_ID}/edit`;

beforeEach(() => {
  book = {
    id: BOOK_ID,
    author_id: USER_ID,
    title: "Libri im",
    subtitle: null,
    language: "sq",
    series_id: null,
    series_position: null,
    edition_number: null,
    pen_name_id: "p1",
    description: "",
    is_adult: false,
    reading_age_min: null,
    categories: null,
    keywords: "",
    original_author: null,
    status: "draft",
    published_at: null,
    file_path: null,
    cover_path: null,
    price_all: null,
    isbn: null,
    publisher: null,
  };
  reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: null };
  takedown = { kind: "none" };
});

describe("editor page: which books it takes", () => {
  it("a plain draft renders the editor", async () => {
    const html = await render();
    expect(html).toContain("Libri im");
    expect(html).not.toContain("REDIRECT");
  });

  it("a live book goes to the edit page", async () => {
    book.status = "published";
    await expect(render()).rejects.toThrow(TO_EDIT_PAGE);
  });

  it("a draft waiting for review goes to the edit page (read-only there)", async () => {
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null };
    await expect(render()).rejects.toThrow(TO_EDIT_PAGE);
  });

  it("an unreadable review state goes to the edit page", async () => {
    reviewState = { kind: "unavailable" };
    await expect(render()).rejects.toThrow(TO_EDIT_PAGE);
  });

  it.each<Takedown>([{ kind: "active" }, { kind: "unavailable" }])("a takedown state %o goes to the edit page", async (state) => {
    takedown = state;
    await expect(render()).rejects.toThrow(TO_EDIT_PAGE);
  });

  it("another author's book is not found", async () => {
    book.author_id = "b0000000-0000-4000-8000-000000000000";
    await expect(render()).rejects.toThrow("NOT_FOUND");
  });
});
