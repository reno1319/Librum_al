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

// BD15 P5b-2: a live book in review shows what it sent (its waiting
// changes, read with the catalog writer).
let pendingRead: { ok: true; pending: Record<string, unknown> | null } | { ok: false } = { ok: true, pending: null };
vi.mock("@/lib/catalog-write-client", () => ({ createCatalogWriteClient: () => ({}) }));
vi.mock("@/lib/book-pending-changes", () => ({ readPendingChanges: async () => pendingRead }));

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
  pendingRead = { ok: true, pending: null };
});

const WARNING =
  "Nëse ndryshoni skedarin e librit, ballinën ose autorin origjinal, libri del nga Libraria derisa Librum ta miratojë. Ndryshimet e tjera dalin menjëherë.";
const SENT_BACK = { reason: "broken_file", message: "The cover is blurry", sentBackAt: "2026-10-19T10:00:00Z" };
function button(html: string, label: string): string {
  const end = html.indexOf(`${label}</button>`);
  expect(end).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", end), end);
}

describe("Edit page: the publish control's label (B)", () => {
  // BD15 P4: a plain draft -- with or without a valid approval -- is
  // edited and sent in the new editor (Pricing tab: "Dërgo për shqyrtim"
  // or "Publiko"). Only drafts the editor does not take render here.
  it.each([false, true])("a plain draft (approval valid: %s) goes to the new editor", async (approvalValid) => {
    reviewState = { kind: "ok", pending: false, approvalValid, latestSentBack: null };
    await expect(render()).rejects.toThrow(`REDIRECT:/dashboard/books/${BOOK_ID}/editor?tab=details`);
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

  // BD15 P5a (Renato 11-04, Q2 a / Q3 a): read-only while in review.
  it("is read-only: what was sent, no edit form, no contributor forms", async () => {
    book.cover_path = "c0c0c0c0-0000-4000-8000-000000000000/cover.jpg";
    book.file_path = `${USER_ID}/${BOOK_ID}/v1.epub`;
    book.price_all = 299;
    book.description = "**Bold** text";
    tableData.book_contributors = [{ id: "k1", name: "Arta", role: "Translator" }];
    const html = await render();
    expect(html).toContain(">Çfarë dërguat</h2>");
    expect(html).toContain("Gjatë shqyrtimit libri nuk ndryshohet.");
    expect(html).toContain("Libri im");
    expect(html).toContain("299 lekë");
    expect(html).toContain("skedar EPUB");
    expect(html).toContain("Bold text");
    expect(html).not.toContain("**Bold**");
    expect(html).not.toContain('id="edit-book-form"');
    expect(html).not.toContain('name="description"');
    expect(html).not.toContain("Shtoni bashkëpunëtor");
    expect(html).not.toContain("Hiqeni</button>");
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
    expect(html).toContain("Hequr nga Libraria</span>");
    expect(html).not.toContain("Anuloni shqyrtimin</button>");
  });
});

describe("Edit page: sent back (F)", () => {
  // BD15 P4: the editor shows the note on every tab (editor/page.tsx).
  it("a sent-back draft goes to the new editor", async () => {
    reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK };
    await expect(render()).rejects.toThrow(`REDIRECT:/dashboard/books/${BOOK_ID}/editor?tab=details`);
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

  // BD15 P5b-2: a live book is edited in the new editor and stays on
  // sale; this page keeps only taking it off sale and deleting it.
  it("links to the editor instead of the old form, and keeps Hiqeni nga publikimi", async () => {
    const html = await render();
    expect(html).toContain('id="live-editor"');
    expect(html).toContain(`href="/dashboard/books/${BOOK_ID}/editor?tab=details"`);
    expect(html).not.toContain('name="title"');
    expect(html).not.toContain(WARNING);
    expect(html).toContain("Hiqeni nga publikimi</button>");
  });

  it("in review: read-only, showing the sent ballinë, file and description, not the live ones", async () => {
    book.cover_path = "live-cover/cover.jpg";
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null };
    pendingRead = {
      ok: true,
      pending: {
        filePath: "a/b.epub",
        coverPath: "sent-cover/cover.jpg",
        description: "The sent description.",
        isAdult: false,
        originalAuthor: null,
      },
    };
    const html = await render();
    expect(html).toContain('id="in-review"');
    expect(html).toContain("https://cdn/sent-cover/cover.jpg");
    expect(html).not.toContain("https://cdn/live-cover/cover.jpg");
    expect(html).toContain("The sent description.");
    expect(html).not.toContain("A real description.");
    expect(html).not.toContain('id="live-editor"');
    // Audit r1 F2: never "when it is published" for a book already on sale.
    expect(html).toContain("Libri mbetet në shitje siç është derisa t&#x27;i miratojmë.");
    expect(html).not.toContain("kur të publikohet");
  });

  it("in review with the waiting changes unreadable: still read-only, showing the live values", async () => {
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null };
    pendingRead = { ok: false };
    const html = await render();
    expect(html).toContain('id="in-review"');
    expect(html).toContain("A real description.");
  });

  it("a draft shows no live-book warning", async () => {
    book.status = "draft";
    // BD15 P4: a draft the editor does not take (review state unreadable).
    reviewState = { kind: "unavailable" };
    const html = await render();
    expect(html).not.toContain(WARNING);
  });
});

// PREVIEW-1 (A5, Renato 6a): the Publishing section links to the book's
// own page (the preview) in every state before it's live, in a new tab.
describe("Edit page: Shikoni faqen e librit para botimit (PREVIEW-1)", () => {
  const LINK = `<a target="_blank" rel="noopener" class="focus-ring rounded-sm font-medium text-foreground underline" href="/libra/${BOOK_ID}">`;
  function publishing(html: string): string {
    return html.slice(html.indexOf(">Publikimi</h2>"), html.indexOf(">Zona e rrezikut</h2>"));
  }

  it.each<[string, () => void]>([
    // BD15 P4: plain and sent-back drafts open the new editor instead.
    ["a draft whose review state is unreadable", () => (reviewState = { kind: "unavailable" })],
    ["a book in review", () => (reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null })],
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
    expect(html).not.toContain(`href="/libra/${BOOK_ID}"`);
  });
});
