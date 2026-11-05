import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  BOOK_FIXTURE_AUTHOR_ID as USER_ID,
  BOOK_FIXTURE_BOOK_ID as BOOK_ID,
} from "@/lib/book-storage-path-test-fixtures";
import { canonicalBookManuscriptPath, canonicalBookCoverPath } from "@/lib/book-storage-path";
import { generateEpub } from "@/lib/epub-generator";
import {
  EBOOK_RESTAMP_FAILED_MESSAGE,
  PRICE_INVALID_MESSAGE,
  PRICE_MODE_MISSING_MESSAGE,
  SEND_CONFIRMATION_NOT_SAVED_MESSAGE,
  SEND_INCOMPLETE_MESSAGE,
  SEND_TICKS_MISSING_MESSAGE,
} from "@/lib/book-pricing";
import { BOOK_CHANGED_WHILE_EDITING_MESSAGE, IN_REVIEW_LOCKED_MESSAGE, SENT_FOR_REVIEW_MESSAGE } from "@/lib/book-review-copy";
import { TAKEN_DOWN_PUBLISH_MESSAGE } from "@/lib/takedown-reasons";

// BD15 P4: saveBookPricing -- the Pricing tab's save and "Send for
// review" -- against one recording Supabase double. The collaborators
// with their own suites (review state, takedown, rights, AI answer,
// paid permission) are settable doubles; performPublish and the ebook
// re-stamp run for real.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args) }));
const afterCalls: unknown[] = [];
vi.mock("next/server", () => ({ after: (task: unknown) => void afterCalls.push(task) }));
let recoveryActive = false;
vi.mock("@/lib/recovery-guard", () => ({
  redirectIfRecoverySessionActive: async () => {
    if (recoveryActive) throw new RedirectSignal("/reset-password");
  },
}));
vi.mock("@/lib/book-reviews", async (importOriginal) => {
  const { bookReviewsDouble } = await import("@/lib/book-reviews-test-double");
  return bookReviewsDouble(await importOriginal<object>());
});
const staffEmails: unknown[] = [];
vi.mock("@/lib/staff-alerts", () => ({
  sendReviewRequestedStaffEmail: async (args: unknown) => {
    staffEmails.push(args);
  },
}));
const mockSendNewBookEmails = vi.fn(async () => undefined);
vi.mock("@/lib/email", () => ({ sendNewBookEmails: () => mockSendNewBookEmails() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

let takedownKind: "none" | "active" | "unavailable" = "none";
vi.mock("@/lib/book-takedowns", () => ({
  getActiveTakedownState: async () => (takedownKind === "active" ? { kind: "active", takedown: {} } : { kind: takedownKind }),
}));

type Basis = "own_rights" | "public_domain" | "public_domain_original";
let rightsState: { kind: "present"; declaration: { basis: Basis } } | { kind: "none" } | { kind: "unavailable" };
const declarations: { bookId: string; basis: unknown; options: unknown }[] = [];
let recordOk = true;
vi.mock("@/lib/book-rights", () => ({
  getRightsDeclarationState: async () => rightsState,
  recordRightsDeclaration: async (bookId: string, basis: unknown, options: unknown) => {
    declarations.push({ bookId, basis, options });
    return recordOk ? { ok: true, declaration: {} } : { ok: false, reason: "error" };
  },
}));

let aiRead: { ok: true; answer: "yes" | "no" | null } | { ok: false } = { ok: true, answer: "no" };
vi.mock("@/lib/book-ai-disclosure", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readAiDisclosure: async () => aiRead,
}));

let paidPublishing = true;
vi.mock("@/lib/paid-readiness", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  canPublishPaidTitle: () => paidPublishing,
}));

// ---- the recording Supabase double ----

type Filter = { kind: string; column: string; value: unknown };
type DbWrite = { table: string; op: string; payload: unknown; filters: Filter[]; via: "session" | "writer" };

let book: Record<string, unknown>;
let dbWrites: DbWrite[] = [];
let updateRows: unknown[] = [{ id: BOOK_ID }];
let updateError: { code: string; message: string } | null = null;
let storageCalls: { op: string; bucket: string; path: unknown; options?: unknown }[] = [];
let stored: Record<string, { bytes: Buffer; metadata: Record<string, string> }> = {};
let infoFails = false;
let downloadFails = false;
let uploadFails = false;
let penNameRead: { data: unknown; error: unknown } = { data: { name: "Emri i Ri" }, error: null };
const events: string[] = [];
// BD15 cleanup r2: runs when performPublish reads the book (its own
// select list), so a test can change what the publish sees after
// saveBookPricing's own checks passed -- another tab, or staff, in between.
let onPublishRead: (() => void) | null = null;
const PUBLISH_READ = "status, price_all, published_at, description, file_path, cover_path";
// BD15 P5b-2: a live book's waiting changes (none by default).
let pendingRead: { data: unknown; error: unknown } = { data: null, error: null };

function query(table: string, via: "session" | "writer" = "session") {
  const filters: Filter[] = [];
  let op = "select";
  let payload: unknown;
  const resolve = () => {
    if (op === "select") {
      if (table === "books") return { data: { ...book }, error: null };
      if (table === "pen_names") return penNameRead;
      if (table === "book_pending_changes") return pendingRead;
      return { data: null, error: null };
    }
    dbWrites.push({ table, op, payload, filters: [...filters], via });
    events.push(`db:${op}:${table}`);
    // A write that matched applies to the one row, as the database would.
    if (table === "books" && op === "update" && updateError) return { data: null, error: updateError };
    if (table === "books" && op === "update" && updateRows.length > 0) Object.assign(book, payload);
    return { data: updateRows, error: null };
  };
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          return (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve().then(resolve).then(f, r);
        }
        if (prop === "single" || prop === "maybeSingle") return () => Promise.resolve(resolve());
        return (...args: unknown[]) => {
          if (prop === "select" && args[0] === PUBLISH_READ && onPublishRead) {
            const hook = onPublishRead;
            onPublishRead = null;
            hook();
          }
          if (prop === "update" || prop === "insert" || prop === "delete") {
            op = prop;
            payload = args[0];
          } else if (prop === "eq" || prop === "is" || prop === "neq" || prop === "not") {
            filters.push({ kind: prop, column: String(args[0]), value: prop === "not" ? args[2] : args[1] });
          }
          return chain;
        };
      },
    },
  );
  return chain;
}

function bucket(name: string) {
  return {
    info: async (path: string) => {
      storageCalls.push({ op: "info", bucket: name, path });
      if (infoFails) return { data: null, error: { message: "info failed" } };
      const object = stored[`${name}:${path}`];
      return object ? { data: { name: path, metadata: object.metadata }, error: null } : { data: null, error: { message: "nf" } };
    },
    download: async (path: string) => {
      storageCalls.push({ op: "download", bucket: name, path });
      if (downloadFails) return { data: null, error: { message: "download failed" } };
      const object = stored[`${name}:${path}`];
      return object
        ? { data: { arrayBuffer: async () => new Uint8Array(object.bytes).buffer }, error: null }
        : { data: null, error: { message: "nf" } };
    },
    upload: async (path: string, bytes: Buffer, options: unknown) => {
      storageCalls.push({ op: "upload", bucket: name, path, options });
      events.push(`storage:upload:${name}`);
      if (uploadFails) return { error: { message: "upload failed" } };
      stored[`${name}:${path}`] = { bytes, metadata: (options as { metadata?: Record<string, string> }).metadata ?? {} };
      return { error: null };
    },
    remove: async (paths: string[]) => {
      storageCalls.push({ op: "remove", bucket: name, path: paths });
      return { data: [], error: null };
    },
  };
}

const sessionClient = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  from: (table: string) => query(table),
  rpc: async () => ({ data: null, error: null }),
  storage: { from: (name: string) => bucket(name) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient }));
// The catalog writer: the same double, its writes marked as the writer's.
const writerClient = { ...sessionClient, from: (table: string) => query(table, "writer") };
vi.mock("@/lib/catalog-write-client", () => ({ createCatalogWriteClient: () => writerClient }));

const { saveBookPricing } = await import("./actions");
const { bookReviewsDoubleState, resetBookReviewsDouble } = await import("@/lib/book-reviews-test-double");

const OWN_EPUB = canonicalBookManuscriptPath(USER_ID, BOOK_ID);
const EDITOR = `/dashboard/books/${BOOK_ID}/editor?tab=pricing`;
const err = (message: string) => `${EDITOR}&error=${encodeURIComponent(message)}`;

async function run(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
  return "(no redirect)";
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const SEND = { intent: "send", priceMode: "free", worldwideRights: "on", acceptAuthorTerms: "on" };

const priceWrites = () => dbWrites.filter((w) => w.table === "books" && (w.payload as Record<string, unknown>)?.price_all !== undefined);
const fileWrites = () => dbWrites.filter((w) => w.table === "books" && (w.payload as Record<string, unknown>)?.file_path !== undefined);
const publishWrites = () => dbWrites.filter((w) => w.table === "books" && (w.payload as Record<string, unknown>)?.status === "published");

async function directEpub(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("content.opf", "<package/>");
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}
async function librumEpub(title: string, authorName: string): Promise<Buffer> {
  return generateEpub({
    bookId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    title,
    authorName,
    sections: [{ heading: "Kapitulli 1", html: "<p>Teksti.</p>" }],
    images: [],
  });
}

beforeEach(async () => {
  resetBookReviewsDouble();
  bookReviewsDoubleState.approvalValid = false;
  book = {
    id: BOOK_ID,
    author_id: USER_ID,
    status: "draft",
    title: "Titulli i Ri",
    pen_name_id: "f0000000-0000-4000-8000-000000000001",
    price_all: null,
    published_at: null,
    file_path: OWN_EPUB,
    cover_path: canonicalBookCoverPath(USER_ID, BOOK_ID, "jpg"),
    description: "Një përshkrim.",
    categories: ["Letërsi artistike"],
    original_author: null,
  };
  dbWrites = [];
  updateRows = [{ id: BOOK_ID }];
  updateError = null;
  storageCalls = [];
  stored = { [`manuscripts:${OWN_EPUB}`]: { bytes: await directEpub(), metadata: {} } };
  infoFails = false;
  downloadFails = false;
  uploadFails = false;
  penNameRead = { data: { name: "Emri i Ri" }, error: null };
  events.length = 0;
  takedownKind = "none";
  rightsState = { kind: "present", declaration: { basis: "own_rights" } };
  declarations.length = 0;
  recordOk = true;
  aiRead = { ok: true, answer: "no" };
  paidPublishing = true;
  staffEmails.length = 0;
  pendingRead = { data: null, error: null };
  recoveryActive = false;
  onPublishRead = null;
  afterCalls.length = 0;
  mockRevalidatePath.mockReset();
  mockSendNewBookEmails.mockReset().mockResolvedValue(undefined);
});

describe("saveBookPricing: Ruaj draftin", () => {
  it("saves Falas as 0 on the author's own draft and stays on the tab", async () => {
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })));
    expect(target).toBe(`${EDITOR}&success=${encodeURIComponent("U ruajt si draft")}`);
    expect(priceWrites()).toHaveLength(1);
    expect(priceWrites()[0].payload).toEqual({ price_all: 0 });
    expect(priceWrites()[0].filters).toEqual(
      expect.arrayContaining([
        { kind: "eq", column: "id", value: BOOK_ID },
        { kind: "eq", column: "author_id", value: USER_ID },
        { kind: "eq", column: "status", value: "draft" },
        { kind: "is", column: "price_all", value: null },
      ]),
    );
    expect(declarations).toEqual([]);
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
  });

  it("saves a paid price, with no tick needed", async () => {
    await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price: "249" })));
    expect(priceWrites()[0].payload).toEqual({ price_all: 249 });
  });

  it.each(["50", "0", "9.99", "abc", ""])("refuses the paid price %j without a write", async (price) => {
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price })))).toBe(
      err(PRICE_INVALID_MESSAGE),
    );
    expect(dbWrites).toEqual([]);
  });

  it("refuses a form with neither Me pagesë nor Falas", async () => {
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "save" })))).toBe(err(PRICE_MODE_MISSING_MESSAGE));
    expect(dbWrites).toEqual([]);
  });

  // D1: "← Përmbajtja" saves first, then goes back.
  const CONTENT_TAB = `/dashboard/books/${BOOK_ID}/editor?tab=content`;
  it("back: saves the price, then goes to Content", async () => {
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "back", priceMode: "paid", price: "249" })));
    expect(priceWrites()[0].payload).toEqual({ price_all: 249 });
    expect(target).toBe(`${CONTENT_TAB}&success=${encodeURIComponent("U ruajt si draft")}`);
  });

  it("back with no price chosen: nothing to save, it just goes back", async () => {
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "back" })))).toBe(CONTENT_TAB);
    expect(dbWrites).toEqual([]);
  });

  it("back with a price that is not valid stays on the tab with the message, nothing written", async () => {
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "back", priceMode: "paid", price: "50" })))).toBe(
      err(PRICE_INVALID_MESSAGE),
    );
    expect(dbWrites).toEqual([]);
  });

  it("back never sends, even with both ticks", async () => {
    await run(saveBookPricing(BOOK_ID, form({ intent: "back", priceMode: "free", worldwideRights: "on", acceptAuthorTerms: "on" })));
    expect(declarations).toEqual([]);
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
  });

  it("a public-domain book is free whatever the form says", async () => {
    rightsState = { kind: "present", declaration: { basis: "public_domain" } };
    await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price: "500" })));
    expect(priceWrites()[0].payload).toEqual({ price_all: 0 });
  });

  it("a new translation of a public-domain work can be paid", async () => {
    rightsState = { kind: "present", declaration: { basis: "public_domain_original" } };
    await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price: "500" })));
    expect(priceWrites()[0].payload).toEqual({ price_all: 500 });
  });

  it("an unchanged price is not written again", async () => {
    book.price_all = 0;
    await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })));
    expect(priceWrites()).toEqual([]);
  });

  it("a write that matches no row (changed under the author) is refused", async () => {
    updateRows = [];
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })));
    expect(target).toContain(`${EDITOR}&error=`);
  });

  // BD15 P5b-3a: the editor shows a book in review read-only; an
  // unreadable review state stays on the tab with the generic error.
  it("a book in review goes to the read-only editor, nothing written", async () => {
    bookReviewsDoubleState.pending = true;
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })))).toBe(
      `/dashboard/books/${BOOK_ID}/editor?tab=details&error=${encodeURIComponent(IN_REVIEW_LOCKED_MESSAGE)}`,
    );
    expect(dbWrites).toEqual([]);
  });

  it("an unreadable review state saves nothing", async () => {
    bookReviewsDoubleState.stateKind = "unavailable";
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })))).toBe(
      `${EDITOR}&error=${encodeURIComponent("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri")}`,
    );
    expect(dbWrites).toEqual([]);
  });

  // BD15 P5b-3a (Renato 11-04, Q2 a): a taken-down book is edited like a
  // draft: its price saves, but it is never sent.
  it("a taken-down book: the price saves", async () => {
    takedownKind = "active";
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })))).toContain(`${EDITOR}&success=`);
    expect(priceWrites()).toHaveLength(1);
  });

  it("a taken-down book: Send saves the price, then refuses with Librum's reason, nothing recorded or sent", async () => {
    takedownKind = "active";
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(`${EDITOR}&error=${encodeURIComponent(TAKEN_DOWN_PUBLISH_MESSAGE)}`);
    expect(priceWrites()).toHaveLength(1);
    expect(declarations).toEqual([]);
    expect(publishWrites()).toEqual([]);
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
  });

  it("an unreadable rights choice saves nothing (it decides whether the book is free only)", async () => {
    rightsState = { kind: "unavailable" };
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price: "500" })));
    expect(target).toContain(`${EDITOR}&error=`);
    expect(dbWrites).toEqual([]);
  });

  it("an unreadable takedown state is not called a takedown, nothing written", async () => {
    takedownKind = "unavailable";
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })))).toMatch(/^\/dashboard\?error=/);
    expect(dbWrites).toEqual([]);
  });

  it("someone else's book goes to the dashboard", async () => {
    book.author_id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })))).toBe("/dashboard");
    expect(dbWrites).toEqual([]);
  });
});

describe("saveBookPricing: Dërgo për shqyrtim", () => {
  it("sends a complete draft for review: price, then the ticks recorded, then the request", async () => {
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target).toBe(`/dashboard?success=${encodeURIComponent(SENT_FOR_REVIEW_MESSAGE)}`);
    expect(priceWrites()[0].payload).toEqual({ price_all: 0 });
    expect(declarations).toEqual([{ bookId: BOOK_ID, basis: "own_rights", options: { atSend: true } }]);
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toHaveLength(1);
    expect(staffEmails).toHaveLength(1);
    expect(publishWrites()).toEqual([]);
    // A directly uploaded ebook is never rewritten.
    expect(storageCalls.filter((c) => c.op === "upload")).toEqual([]);
  });

  it("publishes at once when Librum's approval still matches the files (3a)", async () => {
    bookReviewsDoubleState.approvalValid = true;
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target).toBe(`/dashboard?success=${encodeURIComponent("Libri juaj u publikua")}`);
    expect(publishWrites()).toHaveLength(1);
  });

  it.each([
    ["no tick", {}],
    ["only the worldwide tick", { worldwideRights: "on" }],
    ["only the Terms tick", { acceptAuthorTerms: "on" }],
  ])("%s: refused after the price is kept, nothing recorded or requested", async (_l, ticks) => {
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "send", priceMode: "free", ...ticks })));
    expect(target).toBe(err(SEND_TICKS_MISSING_MESSAGE));
    expect(priceWrites()).toHaveLength(1);
    expect(declarations).toEqual([]);
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
  });

  it.each([
    ["no AI answer", () => (aiRead = { ok: true, answer: null })],
    ["an unreadable AI answer", () => (aiRead = { ok: false })],
    ["no manuscript", () => (book.file_path = null)],
    ["no cover", () => (book.cover_path = null)],
    ["no category", () => (book.categories = [])],
    ["no description", () => (book.description = "")],
    ["no rights choice", () => (rightsState = { kind: "none" })],
  ])("%s: not ready, nothing recorded or requested", async (_l, setUp) => {
    setUp();
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err(SEND_INCOMPLETE_MESSAGE));
    expect(declarations).toEqual([]);
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
  });

  it("a failed record of the ticks stops the send", async () => {
    recordOk = false;
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err(SEND_CONFIRMATION_NOT_SAVED_MESSAGE));
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
  });

  // Audit r1, F4: the book was sent for review from another tab while
  // this send ran; the author is sent to the read-only page, not told
  // that saving failed.
  const IN_REVIEW_EDIT = `/dashboard/books/${BOOK_ID}/editor?tab=details&error=${encodeURIComponent(IN_REVIEW_LOCKED_MESSAGE)}`;

  it("a failed record of the ticks on a book sent meanwhile goes to the read-only page", async () => {
    recordOk = false;
    bookReviewsDoubleState.pendingSequence = [false, true];
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(IN_REVIEW_EDIT);
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
  });

  it("a failed ebook rewrite on a book sent meanwhile goes to the read-only page", async () => {
    infoFails = true;
    bookReviewsDoubleState.pendingSequence = [false, true];
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(IN_REVIEW_EDIT);
    expect(declarations).toEqual([]);
  });

  it("a paid book while paid publishing is closed is refused by the publish gate", async () => {
    paidPublishing = false;
    book.price_all = 249;
    expect(
      await run(saveBookPricing(BOOK_ID, form({ ...SEND, priceMode: "paid", price: "249" }))),
    ).toBe(err("Publikimi me pagesë nuk është i mundur tani"));
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
    // Audit r1, F3: refused before the ticks or the ebook are written.
    expect(declarations).toEqual([]);
    expect(storageCalls.filter((c) => c.op === "info")).toEqual([]);
  });

  // The review request's own outcomes, now reachable only from here.
  it("already waiting: named on the edit page", async () => {
    bookReviewsDoubleState.requestResult = { ok: false, reason: "already_pending" };
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(
      `${EDITOR}&error=${encodeURIComponent("Ky libër po pret tashmë shqyrtimin.")}`,
    );
    expect(publishWrites()).toEqual([]);
  });

  // BD15 P5a: the database's own completeness check (LB489).
  it("a request refused as incomplete names what is missing, on the tab", async () => {
    bookReviewsDoubleState.requestResult = { ok: false, reason: "incomplete" };
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(
      `${EDITOR}&error=${encodeURIComponent("Libri nuk është gati për shqyrtim. Plotësoni të gjitha pjesët që mungojnë dhe provoni përsëri.")}`,
    );
    expect(publishWrites()).toEqual([]);
  });

  it("a price write refused because the book went into review (LB490): the read-only edit page", async () => {
    book.price_all = 500;
    updateError = { code: "LB490", message: "x" };
    expect(await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })))).toBe(
      `/dashboard/books/${BOOK_ID}/editor?tab=details&error=${encodeURIComponent("Ky libër është në shqyrtim, prandaj nuk ndryshohet. Anuloni shqyrtimin për ta ndryshuar.")}`,
    );
  });

  it("a failed request fails closed with the generic sentence", async () => {
    bookReviewsDoubleState.requestResult = { ok: false, reason: "failed" };
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toMatch(/^\/dashboard\?error=/);
    expect(publishWrites()).toEqual([]);
  });

  it("a takedown found by the request is named on the edit page", async () => {
    bookReviewsDoubleState.requestResult = { ok: false, reason: "taken_down" };
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(`${EDITOR}&error=${encodeURIComponent(TAKEN_DOWN_PUBLISH_MESSAGE)}`);
    expect(publishWrites()).toEqual([]);
  });

  it("an approval that landed meanwhile publishes", async () => {
    bookReviewsDoubleState.requestResult = { ok: false, reason: "already_approved" };
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(
      `/dashboard?success=${encodeURIComponent("Libri juaj u publikua")}`,
    );
    expect(publishWrites()).toHaveLength(1);
  });

  describe("the Librum-made ebook re-stamp", () => {
    it("writes the current title and pen name into a fresh key before the request", async () => {
      stored[`manuscripts:${OWN_EPUB}`] = { bytes: await librumEpub("Titulli i Vjetër", "Emri i Vjetër"), metadata: { librum: "made" } };
      const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
      expect(target).toBe(`/dashboard?success=${encodeURIComponent(SENT_FOR_REVIEW_MESSAGE)}`);
      const upload = storageCalls.find((c) => c.op === "upload");
      expect(upload?.bucket).toBe("manuscripts");
      expect(String(upload?.path)).toMatch(new RegExp(`^${USER_ID}/${BOOK_ID}/[0-9a-f-]{36}\\.epub$`));
      expect((upload?.options as { metadata: unknown }).metadata).toEqual({ librum: "made" });
      const zip = await JSZip.loadAsync(stored[`manuscripts:${String(upload?.path)}`].bytes);
      const opf = await zip.file("OEBPS/content.opf")!.async("string");
      expect(opf).toContain("<dc:title>Titulli i Ri</dc:title>");
      expect(opf).toContain("<dc:creator>Emri i Ri</dc:creator>");
      // Compare-and-set on the file it read, on the author's own draft.
      expect(fileWrites()).toHaveLength(1);
      expect(fileWrites()[0].payload).toEqual({ file_path: upload?.path });
      expect(fileWrites()[0].filters).toEqual(
        expect.arrayContaining([
          { kind: "eq", column: "file_path", value: OWN_EPUB },
          { kind: "eq", column: "status", value: "draft" },
          { kind: "eq", column: "author_id", value: USER_ID },
        ]),
      );
      expect(events.indexOf("storage:upload:manuscripts")).toBeLessThan(
        events.lastIndexOf("db:update:books"),
      );
      expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toHaveLength(1);
    });

    it("the superseded ebook goes through the retention rule after the write", async () => {
      stored[`manuscripts:${OWN_EPUB}`] = { bytes: await librumEpub("Titulli i Vjetër", "Emri i Vjetër"), metadata: { librum: "made" } };
      await run(saveBookPricing(BOOK_ID, form(SEND)));
      expect(storageCalls).toContainEqual({ op: "remove", bucket: "manuscripts", path: [OWN_EPUB] });
    });

    it.each([
      ["a failed download", () => (downloadFails = true)],
      ["a failed upload", () => (uploadFails = true)],
      ["an unread pen name", () => (penNameRead = { data: null, error: { message: "x" } })],
    ])("%s stops the send", async (_l, setUp) => {
      stored[`manuscripts:${OWN_EPUB}`] = { bytes: await librumEpub("Titulli i Vjetër", "Emri i Vjetër"), metadata: { librum: "made" } };
      book.price_all = 0;
      setUp();
      expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err(EBOOK_RESTAMP_FAILED_MESSAGE));
      expect(fileWrites()).toEqual([]);
      expect(declarations).toEqual([]);
      expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
    });

    it("a failed upload removes the new key", async () => {
      stored[`manuscripts:${OWN_EPUB}`] = { bytes: await librumEpub("Titulli i Vjetër", "Emri i Vjetër"), metadata: { librum: "made" } };
      uploadFails = true;
      await run(saveBookPricing(BOOK_ID, form(SEND)));
      const upload = storageCalls.find((c) => c.op === "upload");
      expect(storageCalls).toContainEqual({ op: "remove", bucket: "manuscripts", path: [upload?.path] });
    });

    it("an ebook that already names this title and pen name is not rewritten", async () => {
      stored[`manuscripts:${OWN_EPUB}`] = { bytes: await librumEpub("Titulli i Ri", "Emri i Ri"), metadata: { librum: "made" } };
      await run(saveBookPricing(BOOK_ID, form(SEND)));
      expect(storageCalls.filter((c) => c.op === "upload")).toEqual([]);
      expect(fileWrites()).toEqual([]);
    });

    it("an unreadable marker stops the send", async () => {
      infoFails = true;
      expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err(EBOOK_RESTAMP_FAILED_MESSAGE));
      expect(declarations).toEqual([]);
      expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toEqual([]);
    });

    it("a lost compare-and-set removes the new upload and stops the send", async () => {
      stored[`manuscripts:${OWN_EPUB}`] = { bytes: await librumEpub("Titulli i Vjetër", "Emri i Vjetër"), metadata: { librum: "made" } };
      book.price_all = 0;
      updateRows = [];
      expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err(EBOOK_RESTAMP_FAILED_MESSAGE));
      const upload = storageCalls.find((c) => c.op === "upload");
      expect(storageCalls).toContainEqual({ op: "remove", bucket: "manuscripts", path: [upload?.path] });
      expect(declarations).toEqual([]);
    });
  });
});

// BD15 P5b-2: a live book on the Pricing tab. Its price is live at once
// (with the confirm tick under a changed price); "send" sends its waiting
// changes and the book stays on sale.
describe("saveBookPricing: a live book", () => {
  const LIVE_SAVED = "Ndryshimet u ruajtën";
  const NEW_COVER = "1a2b3c4d-2222-4222-8222-1a2b3c4d5e6f/cover.jpg";
  const waiting = (o: Record<string, unknown> = {}) => ({
    data: {
      book_id: BOOK_ID,
      file_path: OWN_EPUB,
      cover_path: NEW_COVER,
      description: "Një përshkrim.",
      is_adult: false,
      original_author: null,
      version: 1,
      ...o,
    },
    error: null,
  });
  beforeEach(() => {
    book.status = "published";
    book.published_at = "2026-10-01T00:00:00Z";
    book.price_all = 0;
    book.is_adult = false;
  });

  it("an unchanged price saves nothing and says the changes were saved (not 'draft')", async () => {
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "free" })));
    expect(target).toBe(`${EDITOR}&success=${encodeURIComponent(LIVE_SAVED)}`);
    expect(priceWrites()).toEqual([]);
  });

  it("a new price needs the tick carrying exactly that price, then saves it on the live row", async () => {
    const refused = await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price: "300" })));
    expect(refused).toContain(`${EDITOR}&error=`);
    expect(priceWrites()).toEqual([]);
    const wrong = await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price: "300", confirmPriceChange: "299" })));
    expect(wrong).toContain(`${EDITOR}&error=`);
    expect(priceWrites()).toEqual([]);
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price: "300", confirmPriceChange: "300" })));
    expect(target).toBe(`${EDITOR}&success=${encodeURIComponent(LIVE_SAVED)}`);
    expect(priceWrites()).toHaveLength(1);
    expect(priceWrites()[0].payload).toEqual({ price_all: 300 });
    expect(priceWrites()[0].filters).toContainEqual({ kind: "eq", column: "status", value: "published" });
    expect(publishWrites()).toEqual([]);
  });

  it("a new paid price is refused while paid publishing is off", async () => {
    paidPublishing = false;
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "save", priceMode: "paid", price: "300", confirmPriceChange: "300" })));
    expect(target).toContain(`${EDITOR}&error=`);
    expect(priceWrites()).toEqual([]);
  });

  it("send with nothing waiting is refused, and nothing is requested", async () => {
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target).toBe(err("Nuk keni ndryshime që presin shqyrtim. Ndryshoni dorëshkrimin, ballinën, përshkrimin, etiketën 18+ ose autorin origjinal dhe ruajini."));
    expect(bookReviewsDoubleState.calls.some((c) => c.fn === "requestBookReview")).toBe(false);
    expect(declarations).toEqual([]);
  });

  it("audit r1 F6: a paid live book's changes are not sent while paid publishing is off", async () => {
    pendingRead = waiting();
    book.price_all = 300;
    paidPublishing = false;
    const target = await run(saveBookPricing(BOOK_ID, form({ ...SEND, priceMode: "paid", price: "300" })));
    expect(target).toBe(err("Publikimi me pagesë nuk është i mundur tani"));
    expect(bookReviewsDoubleState.calls.some((c) => c.fn === "requestBookReview")).toBe(false);
    expect(declarations).toEqual([]);
  });

  it("send needs both ticks", async () => {
    pendingRead = waiting();
    const target = await run(saveBookPricing(BOOK_ID, form({ intent: "send", priceMode: "free" })));
    expect(target).toContain(`${EDITOR}&error=`);
    expect(bookReviewsDoubleState.calls.some((c) => c.fn === "requestBookReview")).toBe(false);
  });

  it("send with waiting changes: records the ticks, requests the review, emails staff; the live book is untouched", async () => {
    pendingRead = waiting();
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target).toBe(`/dashboard?success=${encodeURIComponent("Ndryshimet u dërguan për shqyrtim. Libri mbetet në shitje siç është derisa Librum t'i miratojë.")}`);
    expect(declarations).toEqual([{ bookId: BOOK_ID, basis: "own_rights", options: { atSend: true } }]);
    expect(bookReviewsDoubleState.calls.filter((c) => c.fn === "requestBookReview")).toHaveLength(1);
    expect(staffEmails).toHaveLength(1);
    expect(fileWrites()).toEqual([]);
    expect(dbWrites.filter((w) => w.table === "books" && (w.payload as Record<string, unknown>)?.status !== undefined)).toEqual([]);
  });

  it("audit r1 F1: a live book with no rights record sends as own rights, recorded with the ticks", async () => {
    pendingRead = waiting();
    rightsState = { kind: "none" };
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target.startsWith("/dashboard?success=")).toBe(true);
    expect(declarations).toEqual([{ bookId: BOOK_ID, basis: "own_rights", options: { atSend: true } }]);
  });

  it("send with an incomplete waiting version (no AI answer) is refused before the ticks are recorded", async () => {
    pendingRead = waiting();
    aiRead = { ok: true, answer: null };
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target).toContain(`${EDITOR}&error=`);
    expect(declarations).toEqual([]);
    expect(bookReviewsDoubleState.calls.some((c) => c.fn === "requestBookReview")).toBe(false);
  });

  it.each([
    ["nothing_to_send", `${EDITOR}&error=`],
    ["adult_category", `${EDITOR}&error=`],
    ["already_pending", `${EDITOR}&error=`],
    ["taken_down", `${EDITOR}&error=`],
  ])("the database refusing the send (%s) is mapped", async (reason, prefix) => {
    pendingRead = waiting();
    bookReviewsDoubleState.requestResult = { ok: false, reason };
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target.startsWith(prefix)).toBe(true);
    expect(staffEmails).toEqual([]);
  });

  it("an unreadable waiting row sends nothing", async () => {
    pendingRead = { data: null, error: { code: "XX000", message: "x" } };
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target).toContain(`${EDITOR}&error=`);
    expect(bookReviewsDoubleState.calls.some((c) => c.fn === "requestBookReview")).toBe(false);
  });
});

// ============================================================
// BD15 cleanup: performPublish's own write, through Send -- its one
// caller left. Ported from the removed publishBook/createBook tests
// (publish.test.ts, catalog-write-authorization.test.ts,
// paid-repricing-guards.test.ts, recovery-guard.test.ts). A free draft
// whose approval still matches its files publishes at once; its price is
// already saved, so the only books write is the publish.
// ============================================================
describe("saveBookPricing Send: the publish write", () => {
  const PUBLISHED = `/dashboard?success=${encodeURIComponent("Libri juaj u publikua")}`;
  const pickClears = () => dbWrites.filter((w) => w.table === "books" && (w.payload as Record<string, unknown>)?.librum_choice_at === null);

  beforeEach(() => {
    bookReviewsDoubleState.approvalValid = true;
    book.price_all = 0;
  });

  it("first publish: the catalog writer sets status and published_at, scoped and compare-and-set", async () => {
    const before = Date.now();
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(PUBLISHED);
    expect(priceWrites()).toEqual([]);
    const [write] = publishWrites();
    expect(publishWrites()).toHaveLength(1);
    expect(write.via).toBe("writer");
    const payload = write.payload as { status: string; published_at: string };
    expect(Object.keys(payload).sort()).toEqual(["published_at", "status"]);
    expect(Date.parse(payload.published_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(write.filters).toEqual(
      expect.arrayContaining([
        { kind: "eq", column: "id", value: BOOK_ID },
        { kind: "eq", column: "author_id", value: USER_ID },
        { kind: "eq", column: "status", value: "draft" },
        { kind: "eq", column: "price_all", value: 0 },
      ]),
    );
    // The new-book emails are scheduled for after the page has answered.
    expect(afterCalls).toHaveLength(1);
  });

  it("no write of status, published_at or price goes through the author's session", async () => {
    book.price_all = null;
    await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(publishWrites()).toHaveLength(1);
    for (const w of dbWrites.filter((x) => x.table === "books")) expect(w.via).toBe("writer");
  });

  it("a republish keeps the original published_at and sends no new-book emails", async () => {
    book.published_at = "2026-01-02T03:04:05.000Z";
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(PUBLISHED);
    expect(publishWrites()[0].payload).toEqual({ status: "published" });
    expect(afterCalls).toEqual([]);
  });

  it.each([0, 2])("a %i-row publish result is not reported as live", async (count) => {
    updateRows = Array.from({ length: count }, (_, i) => ({ id: i === 0 ? BOOK_ID : "other" }));
    const target = await run(saveBookPricing(BOOK_ID, form(SEND)));
    expect(target).toBe("/dashboard");
    expect(afterCalls).toEqual([]);
    expect(pickClears()).toEqual([]);
  });

  it("a database error on the publish write is not reported as live", async () => {
    updateError = { code: "XX000", message: "boom" };
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe("/dashboard");
    expect(afterCalls).toEqual([]);
  });

  it("the lock trigger (LB460) on the publish write names the takedown", async () => {
    updateError = { code: "LB460", message: "taken down" };
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err(TAKEN_DOWN_PUBLISH_MESSAGE));
  });

  it.each(["LB462", "LB463"])("%s on the publish write: the book changed while editing", async (code) => {
    updateError = { code, message: "changed" };
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err(BOOK_CHANGED_WHILE_EDITING_MESSAGE));
  });

  it("a real publish clears a leftover Librum's choice pick of this book only, after the publish", async () => {
    await run(saveBookPricing(BOOK_ID, form(SEND)));
    const [clear] = pickClears();
    expect(clear.via).toBe("writer");
    expect(clear.filters).toEqual(
      expect.arrayContaining([
        { kind: "eq", column: "id", value: BOOK_ID },
        { kind: "eq", column: "author_id", value: USER_ID },
      ]),
    );
    expect(clear.filters.some((f) => f.column === "status")).toBe(false);
    expect(dbWrites.indexOf(publishWrites()[0])).toBeLessThan(dbWrites.indexOf(clear));
  });

  it("a failing new-book email after the publish is only logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSendNewBookEmails.mockRejectedValue(new Error("smtp down"));
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(PUBLISHED);
    await expect((afterCalls[0] as () => Promise<void>)()).resolves.toBeUndefined();
    expect(mockSendNewBookEmails).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("a failing revalidatePath after the publish still reports the publish", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Only once the publish has landed: the revalidations after it.
    mockRevalidatePath.mockImplementation(() => {
      if (publishWrites().length > 0) throw new Error("cache down");
    });
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(PUBLISHED);
    expect(publishWrites()).toHaveLength(1);
    error.mockRestore();
  });

  // BD15 cleanup r2 (audit r1, M07/M08/M27/M29/M30): performPublish's own
  // checks are the second line behind saveBookPricing's. Each test changes
  // the state only at the publish read, so only performPublish can refuse.
  const GENERIC = `/dashboard?error=${encodeURIComponent("Libri juaj nuk u publikua dot ende. Provoni përsëri nga paneli juaj")}`;

  it("a takedown that lands before the publish read: refused with Librum's reason, no publish", async () => {
    onPublishRead = () => (takedownKind = "active");
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err(TAKEN_DOWN_PUBLISH_MESSAGE));
    expect(publishWrites()).toEqual([]);
  });

  it("a takedown state unreadable at the publish read fails closed, no publish", async () => {
    onPublishRead = () => (takedownKind = "unavailable");
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(GENERIC);
    expect(publishWrites()).toEqual([]);
  });

  it("a review state unreadable at the publish read fails closed, no publish", async () => {
    onPublishRead = () => (bookReviewsDoubleState.stateKind = "unavailable");
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(GENERIC);
    expect(publishWrites()).toEqual([]);
  });

  it("the publish gate: paid publishing closed by the publish read refuses a paid book, no publish", async () => {
    book.price_all = 199;
    onPublishRead = () => (paidPublishing = false);
    const target = await run(saveBookPricing(BOOK_ID, form({ ...SEND, priceMode: "paid", price: "199" })));
    expect(target).toBe(err("Publikimi me pagesë nuk është i mundur tani"));
    expect(priceWrites()).toEqual([]);
    expect(publishWrites()).toEqual([]);
  });

  it("the publish gate: a description cleared before the publish read refuses, no publish", async () => {
    onPublishRead = () => (book.description = "");
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe(err("Shtoni një përshkrim para publikimit."));
    expect(publishWrites()).toEqual([]);
  });

  it("the publish write itself requires a non-null, non-empty description (a clear after the read matches no row)", async () => {
    await run(saveBookPricing(BOOK_ID, form(SEND)));
    const [write] = publishWrites();
    expect(write.filters).toEqual(
      expect.arrayContaining([
        { kind: "not", column: "description", value: null },
        { kind: "neq", column: "description", value: "" },
      ]),
    );
  });

  it("an active recovery session stops the send before the publish write", async () => {
    recoveryActive = true;
    expect(await run(saveBookPricing(BOOK_ID, form(SEND)))).toBe("/reset-password");
    expect(publishWrites()).toEqual([]);
  });
});

// Moved from the removed publish.test.ts (ALL-WIRING-2): the row
// performPublish reads carries no legacy price_cents, so a legacy value
// can never decide free or paid.
it("performPublish's book read does not include price_cents at all", () => {
  const source = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");
  const selectList = source.match(/\.select\("status, [^"]*"\)/)?.[0];
  expect(selectList).toBe('.select("status, price_all, published_at, description, file_path, cover_path")');
});
