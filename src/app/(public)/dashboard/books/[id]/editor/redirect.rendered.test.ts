import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BD15 P5a (P4 audit, render test for the editor redirect), P5b-3a: the
// old edit page is retired, so the editor takes every book of the
// author's -- a plain draft, a live book, a book in review (read-only),
// a taken-down book (edited like a draft, never sent) -- and every tab
// ends with the Veprime box. Only an unreadable state leaves it.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("../../../editor-actions", () => ({
  saveBookDetails: { bind: () => async () => undefined },
  discardBookPendingChanges: { bind: () => async () => undefined },
}));
// BD15 P5b-2: a live book's waiting changes.
let pendingRead: { ok: true; pending: Record<string, unknown> | null; createdAt: string | null } | { ok: false } = {
  ok: true,
  pending: null,
  createdAt: null,
};
vi.mock("@/lib/catalog-write-client", () => ({ createCatalogWriteClient: () => ({}) }));
vi.mock("@/lib/book-pending-changes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPendingChanges: async () => pendingRead,
}));
vi.mock("../../../actions", () => ({
  saveBookContent: { bind: () => async () => undefined },
  saveBookPricing: { bind: () => async () => undefined },
  cancelBookReview: { bind: () => async () => undefined },
  deleteBook: { bind: () => async () => undefined },
  unpublishBook: { bind: () => async () => undefined },
}));

type SentBack = { sentBackAt: string; reason: string; message: string };
type ReviewState =
  | { kind: "ok"; pending: boolean; approvalValid: boolean; latestSentBack: SentBack | null }
  | { kind: "unavailable" };
let reviewState: ReviewState;
vi.mock("@/lib/book-reviews", () => ({ getBookReviewState: async () => reviewState }));
type Takedown = { kind: "none" } | { kind: "active" } | { kind: "unavailable" };
let takedown: Takedown;
const NOTICE = { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Proof please", bundleTitles: [] };
vi.mock("@/lib/book-takedowns", () => ({
  loadAuthorTakedownNoticeForBook: async () => ({ state: takedown, notice: takedown.kind === "active" ? NOTICE : null }),
}));
let maintenance = false;
vi.mock("@/lib/maintenance-mode", () => ({ resolveMaintenanceMode: () => maintenance }));
// P5b-3b (audit P5b-2 r2, R2-1 N8/N9): settable.
let rightsState: { kind: string };
vi.mock("@/lib/book-rights", () => ({ getRightsDeclarationState: async () => rightsState }));
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

async function render(tab = "details"): Promise<string> {
  const element = await BookEditorPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve({ tab }),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

const TO_DASHBOARD_ERROR = "REDIRECT:/dashboard?error=";
// A rights radio rendered as chosen, whichever attribute order.
const CHECKED_RIGHTS_RADIO = /<input(?=[^>]*name="rightsBasis")(?=[^>]*type="radio")[^>]*checked=""[^>]*>/;
const SENT_BACK: SentBack = { sentBackAt: "2026-11-04T12:00:00Z", reason: "broken_file", message: "Fix the file" };

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
  rightsState = { kind: "none" };
  pendingRead = { ok: true, pending: null, createdAt: null };
  maintenance = false;
});

describe("editor page: which books it takes", () => {
  it("a plain draft renders the editor", async () => {
    const html = await render();
    expect(html).toContain("Libri im");
    expect(html).not.toContain("REDIRECT");
  });

  // BD15 P5b-2: a live book stays live and opens here.
  it("a live book renders the editor, marked as on sale, with the live notice", async () => {
    book.status = "published";
    book.description = "Live description";
    const html = await render();
    expect(html).toContain("Në shitje");
    expect(html).toContain("Hiqeni nga shitja ose fshijeni librin");
    expect(html).not.toContain("Hidhni ndryshimet");
  });

  it("a live book with waiting changes lists what changed and offers to discard them", async () => {
    book.status = "published";
    book.description = "Live description";
    pendingRead = {
      ok: true,
      pending: { filePath: null, coverPath: null, description: "New description", isAdult: false, originalAuthor: null },
      createdAt: "2026-11-04T10:00:00Z",
    };
    const html = await render();
    expect(html).toContain("Hidhni ndryshimet");
    expect(html).toContain("New description");
  });

  // Audit r1 F1: no rights record (the mock answers "none") -> own rights,
  // the only basis the database allows such a book, shown and sent.
  it("a live book with no rights record shows and sends own rights, not a missing step", async () => {
    book.status = "published";
    book.description = "Live description";
    const html = await render();
    expect(html).toContain('<input type="hidden" name="rightsBasis" value="own_rights"/>');
  });

  it("a draft with no rights record still asks for it", async () => {
    const html = await render();
    expect(html).not.toContain('<input type="hidden" name="rightsBasis"');
    // Audit P5b-2 r2, R2-1 N8: nothing pre-chosen, and still missing.
    expect(html).not.toMatch(CHECKED_RIGHTS_RADIO);
    expect(html).toMatch(/Të drejtat|rights/i);
  });

  it("audit P5b-2 r2, R2-1 N9: a live book whose rights can't be read gets no own-rights default", async () => {
    book.status = "published";
    book.description = "Live description";
    rightsState = { kind: "unavailable" };
    const html = await render();
    expect(html).not.toContain('<input type="hidden" name="rightsBasis" value="own_rights"/>');
    expect(html).not.toMatch(CHECKED_RIGHTS_RADIO);
  });

  it("a live book whose waiting changes cannot be read goes to the dashboard, nothing shown", async () => {
    book.status = "published";
    pendingRead = { ok: false };
    await expect(render()).rejects.toThrow("REDIRECT:/dashboard?error=");
  });

  // BD15 P5b-3a: in review, read-only here -- what was sent, no forms
  // but "Anuloni shqyrtimin" and the Veprime box.
  it("a draft waiting for review: read-only, what was sent, Anuloni shqyrtimin, no tabs or forms", async () => {
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null };
    book.description = "Sent description";
    book.price_all = 0;
    const html = await render();
    expect(html).toContain("Në shqyrtim");
    expect(html).toContain("Çfarë dërguat");
    expect(html).toContain("Sent description");
    expect(html).toContain("Falas");
    expect(html).toContain("Anuloni shqyrtimin");
    expect(html).toContain("Librum po e kontrollon librin tuaj.");
    expect(html).not.toContain('aria-label="Pjesët e librit"');
    expect(html).not.toContain('name="title"');
    expect(html).not.toContain("Hiqeni nga shitja");
    expect(html).toContain('id="veprime"');
    expect(html).toContain(">Fshini<");
  });

  it("a live book in review: the sent (waiting) version, still on sale, take off sale offered", async () => {
    book.status = "published";
    book.description = "Live description";
    book.cover_path = "11111111-1111-4111-8111-111111111111/cover.jpg";
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null };
    pendingRead = {
      ok: true,
      pending: {
        filePath: null,
        coverPath: "22222222-2222-4222-8222-222222222222/cover.jpg",
        description: "Waiting description",
        isAdult: false,
        originalAuthor: null,
      },
      createdAt: "2026-11-04T10:00:00Z",
    };
    const html = await render();
    expect(html).toContain("Waiting description");
    expect(html).not.toContain("Live description");
    expect(html).toContain("https://cdn/22222222-2222-4222-8222-222222222222/cover.jpg");
    expect(html).toContain("Libri mbetet në shitje siç është.");
    expect(html).toContain("Hiqeni nga shitja");
    expect(html).toContain("Ndryshimet që presin shqyrtim bëhen pjesë e draftit.");
  });

  it("a live book in review whose waiting changes can't be read: still read-only, with the live values", async () => {
    book.status = "published";
    book.description = "Live description";
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null };
    pendingRead = { ok: false };
    const html = await render();
    expect(html).toContain("Çfarë dërguat");
    expect(html).toContain("Live description");
  });

  it("an unreadable review state goes to the dashboard, nothing shown", async () => {
    reviewState = { kind: "unavailable" };
    await expect(render()).rejects.toThrow(TO_DASHBOARD_ERROR);
  });

  it("an unreadable takedown state goes to the dashboard, nothing shown", async () => {
    takedown = { kind: "unavailable" };
    await expect(render()).rejects.toThrow(TO_DASHBOARD_ERROR);
  });

  // Renato 11-04, Q2 a: a taken-down book is edited like a draft.
  it("a taken-down book: Librum's notice, the editor's tabs, no delete", async () => {
    takedown = { kind: "active" };
    const html = await render();
    expect(html).toContain("Hequr nga Libraria");
    expect(html).toContain("Proof please");
    expect(html).toContain('aria-label="Pjesët e librit"');
    expect(html).toContain('name="title"');
    expect(html).not.toContain(">Fshini<");
    expect(html).toContain("nuk mund të fshihet");
  });

  // Audit P5b-3a r1, F1: Librum's "send it again" note never sits beside
  // a takedown (a send is refused, LB460).
  it("a taken-down book with a send-back on record shows no sent-back note", async () => {
    takedown = { kind: "active" };
    reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK };
    const html = await render();
    expect(html).toContain("Hequr nga Libraria");
    expect(html).not.toContain("jua ktheu");
    expect(html).not.toContain("Fix the file");
  });

  it("a taken-down book in review: the takedown wins (editable, not read-only)", async () => {
    takedown = { kind: "active" };
    reviewState = { kind: "ok", pending: true, approvalValid: false, latestSentBack: null };
    const html = await render();
    expect(html).not.toContain("Çfarë dërguat");
    expect(html).toContain("Hequr nga Libraria");
  });

  it("a taken-down book's Pricing tab: Send blocked with the reason", async () => {
    takedown = { kind: "active" };
    const html = await render("pricing");
    expect(html).toContain("Librum e hoqi këtë libër, prandaj nuk mund ta dërgoni tani.");
  });

  it("the Veprime box: a draft gets Preview and Delete, a live book gets Hiqeni nga shitja and no Delete", async () => {
    let html = await render();
    expect(html).toContain('id="veprime"');
    expect(html).toContain(`href="/libra/${BOOK_ID}"`);
    expect(html).toContain(">Fshini<");
    expect(html).not.toContain("Hiqeni nga shitja");
    book.status = "published";
    book.description = "Live description";
    html = await render("content");
    expect(html).toContain("Hiqeni nga shitja");
    // P6 Q4 a (Renato 11-05): no Delete on a live book, a note instead.
    expect(html).not.toContain(">Fshini<");
    expect(html).toContain("Për ta fshirë, hiqeni fillimisht nga shitja.");
    expect(html).not.toContain(`href="/libra/${BOOK_ID}"`);
    // The live notice's link goes down to the box, not to another page.
    expect(html).toContain('href="#veprime"');
  });

  // P5b-3a: a live book's sent-back note belongs to the changes it was
  // sent with -- gone once they're discarded or replaced by newer ones.
  it("a live book's sent-back note: shown with the changes it was about, named as changes", async () => {
    book.status = "published";
    book.description = "Live description";
    reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK };
    pendingRead = {
      ok: true,
      pending: { filePath: null, coverPath: null, description: "Changed", isAdult: false, originalAuthor: null },
      createdAt: "2026-11-04T09:00:00Z",
    };
    const html = await render();
    expect(html).toContain("Librum jua ktheu ndryshimet");
    expect(html).toContain("Fix the file.");
  });

  it("a live book's sent-back note is gone after the changes are discarded", async () => {
    book.status = "published";
    book.description = "Live description";
    reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK };
    const html = await render();
    expect(html).not.toContain("Librum jua ktheu");
  });

  it("a live book's sent-back note is gone when the waiting changes were first saved after it", async () => {
    book.status = "published";
    book.description = "Live description";
    reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK };
    pendingRead = {
      ok: true,
      pending: { filePath: null, coverPath: null, description: "Newer", isAdult: false, originalAuthor: null },
      createdAt: "2026-11-04T13:00:00Z",
    };
    const html = await render();
    expect(html).not.toContain("Librum jua ktheu");
  });

  it("a draft's sent-back note stays until it is sent again, naming the book", async () => {
    reviewState = { kind: "ok", pending: false, approvalValid: false, latestSentBack: SENT_BACK };
    const html = await render();
    expect(html).toContain("Librum jua ktheu këtë libër për ndryshime");
  });

  // ALL-CUTOVER APP-A, carried over from the old edit page.
  it("maintenance mode: the notice, before any Supabase call", async () => {
    maintenance = true;
    const html = await render();
    expect(html).not.toContain("Libri im");
    expect(html).not.toContain("REDIRECT");
  });

  it("another author's book is not found", async () => {
    book.author_id = "b0000000-0000-4000-8000-000000000000";
    await expect(render()).rejects.toThrow("NOT_FOUND");
  });
});
