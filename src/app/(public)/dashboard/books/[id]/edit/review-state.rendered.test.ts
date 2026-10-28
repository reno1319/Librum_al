import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ADMIN-3-REVIEW (B, C, E, F): the Edit page's review states. Same
// harness as takedown-notice.rendered.test.ts; book_review_state() is
// mocked so each case says exactly what the page was told.

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
type ReviewState =
  | { kind: "ok"; pending: boolean; approvalValid: boolean; latestSentBack: { reason: string; message: string; sentBackAt: string } | null }
  | { kind: "unavailable" };
let reviewState: ReviewState;
vi.mock("@/lib/book-reviews", () => ({ getBookReviewState: async () => reviewState }));

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
    genre: "Letërsi artistike",
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
  reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: null };
});

const WARNING =
  "Nëse ndryshoni skedarin e librit ose kopertinën, libri del nga Libraria derisa Librum ta miratojë. Ndryshimet e tjera dalin menjëherë.";
const SENT_BACK = { reason: "broken_file", message: "The cover is blurry", sentBackAt: "2026-10-19T10:00:00Z" };
function button(html: string, label: string): string {
  const end = html.indexOf(`${label}</button>`);
  expect(end).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", end), end);
}

describe("Edit page: the publish control's label (B)", () => {
  it("a draft without a valid approval: Dërgojeni për shqyrtim", async () => {
    const html = await render();
    expect(button(html, "Dërgojeni për shqyrtim")).not.toContain('disabled=""');
    expect(html).not.toContain("Publikoni</button>");
    expect(html).toContain("Gati për t&#x27;u dërguar për shqyrtim.");
  });

  it("a draft whose approval still matches its files: Publish", async () => {
    reviewState = { kind: "ok", pending: false, approvalValid: true, latestSentBack: null };
    const html = await render();
    expect(button(html, "Publikoni")).not.toContain('disabled=""');
    expect(html).not.toContain("Dërgojeni për shqyrtim</button>");
    expect(html).toContain("Gati për publikim.");
  });

  it("an unreadable review state disables the control with the generic sentence", async () => {
    reviewState = { kind: "unavailable" };
    const html = await render();
    expect(button(html, "Dërgojeni për shqyrtim")).toContain('disabled=""');
    expect(html).toContain("Libri juaj nuk u publikua dot ende.");
  });
});

describe("Edit page: in review (E, F)", () => {
  beforeEach(() => {
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null };
  });

  it("shows In review and Anuloni shqyrtimin in place of the publish control, with no timing promise", async () => {
    const html = await render();
    expect(html).toContain("Gjendja: <span class=\"font-medium\">Në shqyrtim</span>");
    expect(button(html, "Anuloni shqyrtimin")).not.toContain('disabled=""');
    expect(html).not.toContain("Dërgojeni për shqyrtim</button>");
    expect(html).not.toContain("Publikoni</button>");
    const publishing = html.slice(html.indexOf(">Publikimi</h2>"), html.indexOf(">Zona e rrezikut</h2>"));
    expect(publishing).toContain("Librum po e kontrollon librin tuaj.");
    expect(publishing).not.toMatch(/\b(hours?|days?|within|soon)\b/i);
  });

  it("an older send back is not shown while a new review is pending", async () => {
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: SENT_BACK };
    const html = await render();
    expect(html).not.toContain("Librum jua ktheu këtë libër");
  });

  it("a takedown keeps priority over In review", async () => {
    takedown = {
      state: { kind: "active", takedown: {} },
      notice: { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Proof please", bundleTitles: [] },
    };
    const html = await render();
    expect(html).toContain("Hequr nga Librum</span>");
    expect(html).not.toContain("Anuloni shqyrtimin</button>");
  });
});

describe("Edit page: sent back (F)", () => {
  it("shows the send-back notice above the publish control", async () => {
    reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK };
    const html = await render();
    expect(html).toContain("Librum jua ktheu këtë libër për ndryshime më 19 tetor 2026. Arsyeja: ");
    expect(html).toContain("The cover is blurry.");
    expect(html).toContain("Rregullojeni dhe dërgojeni përsëri për shqyrtim.");
    expect(html).toContain("Pyetje? Na shkruani te support@librum.al");
    expect(html.indexOf("Librum jua ktheu këtë libër")).toBeLessThan(html.indexOf("Dërgojeni për shqyrtim</button>"));
  });

  it("a takedown notice replaces the send-back notice", async () => {
    reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK };
    takedown = {
      state: { kind: "active", takedown: {} },
      notice: { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Proof please", bundleTitles: [] },
    };
    const html = await render();
    expect(html).not.toContain("Librum jua ktheu këtë libër");
  });
});

describe("Edit page: a live book (C)", () => {
  beforeEach(() => {
    book.status = "published";
  });

  it("warns near the file and cover fields, before the pickers", async () => {
    const html = await render();
    const warning = html.indexOf(WARNING);
    expect(warning).toBeGreaterThan(html.indexOf(">Skedarët</h2>"));
    expect(warning).toBeLessThan(html.indexOf("Imazhi i kopertinës"));
    expect(html).toContain("Hiqeni nga publikimi</button>");
  });

  it("never promises existing readers the new file on their next download", async () => {
    const html = await render();
    expect(html).not.toContain("updates the file existing readers receive");
    expect(html).toContain("kontrollohet nga Librum para se ta marrin lexuesit.");
  });

  it("a draft shows no live-book warning", async () => {
    book.status = "draft";
    const html = await render();
    expect(html).not.toContain(WARNING);
  });
});

// PREVIEW-1 (A5, Renato 6a): the Publishing section links to the book's
// own page (the preview) in every state before it's live, in a new tab.
describe("Edit page: Shikoni faqen e librit para botimit (PREVIEW-1)", () => {
  const LINK = `<a target="_blank" rel="noopener" class="focus-ring rounded-sm font-medium text-foreground underline" href="/books/${BOOK_ID}">`;
  function publishing(html: string): string {
    return html.slice(html.indexOf(">Publikimi</h2>"), html.indexOf(">Zona e rrezikut</h2>"));
  }

  it.each<[string, () => void]>([
    ["a draft", () => {}],
    ["a book in review", () => (reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null })],
    ["a sent-back book", () => (reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK })],
    [
      "a taken-down book",
      () =>
        (takedown = {
          state: { kind: "active", takedown: {} },
          notice: { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Proof please", bundleTitles: [] },
        }),
    ],
  ])("%s: links to its page in a new tab, under Status", async (_label, setUp) => {
    setUp();
    const html = publishing(await render());
    expect(html).toContain(LINK);
    expect(html).toContain("Shikoni faqen e librit para botimit<span class=\"sr-only\"> (hapet në një skedë të re)</span>");
    expect(html).toContain("Tregon ndryshimet e ruajtura së fundmi.");
    expect(html.indexOf(LINK)).toBeGreaterThan(html.indexOf("Status:"));
  });

  it("a live book has no Preview link", async () => {
    book.status = "published";
    const html = await render();
    expect(html).not.toContain("Shikoni faqen e librit para botimit");
    expect(html).not.toContain(`href="/books/${BOOK_ID}"`);
  });
});
