import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADMIN-2-TAKEDOWN (C): the staff Unpublish and "Allow again" actions.
// Maintenance gate first, then requireStaff("reports.resolve"), then the
// form check, then the RPC through the staff member's OWN session; every
// RPC error is mapped, and the email and revalidation that follow a
// success never turn it into a failure.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => mockRevalidatePath(path) }));

const mockRequireStaff = vi.fn((_permission: string) => Promise.resolve({ userId: "staff-1", role: "moderator" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => Promise.resolve({ rpc: mockRpc }) }));

type Result = { data: unknown; error: unknown };
let adminRows: Record<string, Result> = {};
// BD15 P5b-2: later reads of a table (the book re-read after a live
// approval), taken in order before adminRows.
let adminRowQueue: Record<string, Result[]> = {};
const mockCoverRemove = vi.fn(async (_paths: string[]) => ({ data: [], error: null }));
const mockGetUserById = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const done = () => {
        const queued = adminRowQueue[table];
        if (queued && queued.length > 0 && adminRowsRead[table]) return Promise.resolve(queued.shift() as Result);
        adminRowsRead[table] = true;
        return Promise.resolve(adminRows[table] ?? { data: null, error: null });
      };
      const chain = { select: () => chain, eq: () => chain, in: () => chain, maybeSingle: done, returns: done };
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        remove: (paths: string[]) => mockCoverRemove([bucket, ...paths]),
        download: (path: string) => mockDownload(bucket, path),
      }),
    },
    auth: { admin: { getUserById: (id: string) => mockGetUserById(id) } },
  }),
}));
let adminRowsRead: Record<string, boolean> = {};
// Upload notes D: the staff "Count pages" button.
const mockDownload = vi.fn();
const mockRecordWords = vi.fn();
vi.mock("@/lib/page-estimate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/page-estimate")>()),
  recordManuscriptWords: (...args: unknown[]) => mockRecordWords(...args),
}));

const mockSendEmail = vi.fn();
// ADMIN-3-REVIEW: the review emails, the followers email, the rights
// read, the paid permission and the retention cleanup.
const mockApprovedEmail = vi.fn();
const mockChangesApprovedEmail = vi.fn();
const mockSentBackEmail = vi.fn();
const mockNewBookEmails = vi.fn();
vi.mock("@/lib/email", () => ({
  sendBookTakedownEmail: (to: string, args: unknown) => mockSendEmail(to, args),
  sendBookApprovedEmail: (to: string, args: unknown) => mockApprovedEmail(to, args),
  sendBookChangesApprovedEmail: (to: string, args: unknown) => mockChangesApprovedEmail(to, args),
  sendBookSentBackEmail: (to: string, args: unknown) => mockSentBackEmail(to, args),
  sendNewBookEmails: (admin: unknown, args: unknown) => mockNewBookEmails(admin, args),
  sendPreorderListedEmail: (to: string, args: unknown) => mockPreorderListedEmail(to, args),
  sendPreorderFileApprovedEmail: (to: string, args: unknown) => mockPreorderFileEmail(to, args),
}));
// BD16 P5: the "Më njofto" readers' sweep is scheduled after an action.
const mockScheduleReaders = vi.fn();
vi.mock("@/lib/preorder-emails", () => ({
  scheduleWaitingReaderEmails: (source: string) => mockScheduleReaders(source),
}));
// BD16 P3: the pre-order approval emails.
const mockPreorderListedEmail = vi.fn();
const mockPreorderFileEmail = vi.fn();
// B6: follower emails are scheduled with next/server's after(). By
// default a task starts on the next microtask, so its send is visible
// once the action settles (and every "no email" assertion still means
// something); mockHeldAfterTasks holds tasks back to prove the page
// answers first.
const mockAfterRuns: Promise<unknown>[] = [];
let mockHeldAfterTasks: (() => Promise<unknown>)[] | null = null;
vi.mock("next/server", () => ({
  after: (task: () => Promise<unknown>) => {
    if (mockHeldAfterTasks) mockHeldAfterTasks.push(task);
    else mockAfterRuns.push(Promise.resolve().then(task));
  },
}));
async function settleAfterTasks() {
  await Promise.all(mockAfterRuns.splice(0));
}
let rightsState: "present" | "none" | "unavailable" = "present";
vi.mock("./admin-book-reads", () => ({ readRightsStateForStaff: async () => rightsState }));
let paidAllowed = false;
vi.mock("@/lib/paid-readiness", () => ({ canPublishPaidTitle: () => paidAllowed }));
const mockRetention = vi.fn();
vi.mock("@/lib/book-reviews", () => ({
  removeUnretainedManuscripts: (...args: unknown[]) => mockRetention(...args),
}));

const {
  unpublishBookAsStaff,
  allowBookAgainAsStaff,
  approveBookReviewAsStaff,
  sendBackBookReviewAsStaff,
  setPdEditionAsStaff,
  countBookPagesAsStaff,
} = await import("./actions");

const BOOK_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const TAKEDOWN_ID = "44444444-4444-4444-8444-444444444444";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  await expect(run()).rejects.toBeInstanceOf(RedirectSignal);
  return String(mockRedirect.mock.calls.at(-1)?.[0]);
}

describe("unpublishBookAsStaff", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRevalidatePath.mockReset();
    mockRequireStaff.mockClear();
    mockRpc.mockReset().mockResolvedValue({ data: TAKEDOWN_ID, error: null });
    mockGetUserById.mockReset().mockResolvedValue({ data: { user: { email: "ana@example.com" } } });
    mockSendEmail.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    adminRows = {
      book_takedowns: {
        data: {
          book_title: "Kënga e fundit",
          author_id: "author-1",
          reason: "copyright",
          message_to_author: "Send proof.",
          bundle_ids: ["bundle-1"],
        },
        error: null,
      },
      bundles: { data: [{ id: "bundle-1", title: "Set A" }], error: null },
      books: { data: { pen_name_id: "pen-1" }, error: null },
    };
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is refused in maintenance before requireStaff", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    const target = await redirectOf(() => unpublishBookAsStaff(form({ bookId: BOOK_ID })));
    expect(target.startsWith("/admin/books?error=")).toBe(true);
    expect(mockRequireStaff).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("requires reports.resolve and refuses an invalid form without calling the RPC", async () => {
    const target = await redirectOf(() =>
      unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "copyright", message: "  ", reportId: REPORT_ID })),
    );
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.resolve");
    expect(target).toBe(
      `/admin/books/${BOOK_ID}?report=${REPORT_ID}&error=${encodeURIComponent("Write a message to the author.")}`,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("P5: a takedown schedules the readers' sweep (a taken-down pre-order's one cancel email); a refused one does not", async () => {
    mockScheduleReaders.mockClear();
    await redirectOf(() => unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "copyright", message: "Send proof." })));
    expect(mockScheduleReaders).toHaveBeenCalledWith("unpublishBookAsStaff");
    mockScheduleReaders.mockClear();
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "boom" } });
    await redirectOf(() => unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "copyright", message: "Send proof." })));
    expect(mockScheduleReaders).not.toHaveBeenCalled();
  });

  it("calls admin_unpublish_book with the session, then emails the author and revalidates", async () => {
    const target = await redirectOf(() =>
      unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "copyright", message: " Send proof. ", reportId: REPORT_ID })),
    );
    expect(mockRpc).toHaveBeenCalledWith("admin_unpublish_book", {
      p_book_id: BOOK_ID,
      p_reason: "copyright",
      p_message: "Send proof.",
      p_report_id: REPORT_ID,
    });
    expect(mockSendEmail).toHaveBeenCalledWith("ana@example.com", {
      title: "Kënga e fundit",
      reasonLabel: "Ankesë për të drejtën e autorit",
      message: "Send proof.",
      bundleTitles: ["Set A"],
    });
    for (const path of [
      "/",
      "/librari",
      `/libra/${BOOK_ID}`,
      "/admin/books",
      `/admin/books/${BOOK_ID}`,
      "/dashboard",
      "/paketa/bundle-1",
      "/autore/pen-1",
      `/admin/reports/${REPORT_ID}`,
      "/admin/reports",
      "/admin",
    ]) {
      expect(mockRevalidatePath).toHaveBeenCalledWith(path);
    }
    expect(target).toBe(
      `/admin/books/${BOOK_ID}?success=${encodeURIComponent(
        "Book unpublished and the report resolved. The author can't publish it again until you allow it.",
      )}`,
    );
  });

  it("still reports success when the email and revalidation fail afterwards", async () => {
    mockSendEmail.mockRejectedValue(new Error("smtp down"));
    mockRevalidatePath.mockImplementation(() => {
      throw new Error("cache");
    });
    const target = await redirectOf(() =>
      unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "other", message: "Why" })),
    );
    expect(target).toContain("?success=");
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_report_id: null });
  });

  it("maps RPC errors and never shows raw database text", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "this book is already taken down" } });
    let target = await redirectOf(() => unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "other", message: "x" })));
    expect(target).toBe(`/admin/books/${BOOK_ID}?error=${encodeURIComponent("This book is already taken down.")}`);

    mockRpc.mockResolvedValue({ data: null, error: { code: "40P01", message: "deadlock detected" } });
    target = await redirectOf(() => unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "other", message: "x" })));
    expect(decodeURIComponent(target)).toContain("Please try again.");

    mockRpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "relation books does not exist" } });
    target = await redirectOf(() => unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "other", message: "x" })));
    expect(decodeURIComponent(target)).not.toContain("relation");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends an expired session to log in", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "not authenticated" } });
    const target = await redirectOf(() => unpublishBookAsStaff(form({ bookId: BOOK_ID, reason: "other", message: "x" })));
    expect(target).toBe(`/login?next=${encodeURIComponent(`/admin/books/${BOOK_ID}`)}`);
  });

  it("refuses a book id that is not a uuid", async () => {
    const target = await redirectOf(() => unpublishBookAsStaff(form({ bookId: "1 or 1=1", reason: "other", message: "x" })));
    expect(target.startsWith("/admin/books?error=")).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("allowBookAgainAsStaff", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRevalidatePath.mockReset();
    mockRequireStaff.mockClear();
    mockRpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

  it("requires reports.resolve, calls admin_allow_book_again and says so", async () => {
    const target = await redirectOf(() => allowBookAgainAsStaff(BOOK_ID));
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.resolve");
    expect(mockRpc).toHaveBeenCalledWith("admin_allow_book_again", { p_book_id: BOOK_ID });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(target).toBe(
      `/admin/books/${BOOK_ID}?success=${encodeURIComponent("The author can publish this book again.")}`,
    );
  });

  it("maps a book that is not taken down", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "this book is not taken down" } });
    const target = await redirectOf(() => allowBookAgainAsStaff(BOOK_ID));
    expect(target).toBe(`/admin/books/${BOOK_ID}?error=${encodeURIComponent("This book is not taken down.")}`);
  });
});

// ============================================================
// ADMIN-3-REVIEW (H, J, M2): Approve and Send back.
// ============================================================
const REVIEW_ID = "55555555-5555-4555-8555-555555555555";
const AUTHOR_ID = "66666666-6666-4666-8666-666666666666";
const FILE = `${AUTHOR_ID}/${BOOK_ID}/0f0e0d0c-0b0a-4908-8706-050403020100.epub`;
const COVER = "0f0e0d0c-0b0a-4908-8706-050403020100/cover.png";
// BD15 P5b-3a (Renato 11-04, b): three staff boxes.
const ALL_CHECKS = { cover_is_fine: "on", file_opens: "on", rights_ok: "on" };

function resetReviewMocks(): void {
  mockRedirect.mockClear();
  mockRevalidatePath.mockReset();
  mockRequireStaff.mockClear();
  mockRpc.mockReset().mockResolvedValue({ data: true, error: null });
  mockGetUserById.mockReset().mockResolvedValue({ data: { user: { email: "ana@example.com" } } });
  mockApprovedEmail.mockReset().mockResolvedValue(undefined);
  mockChangesApprovedEmail.mockReset().mockResolvedValue(undefined);
  mockCoverRemove.mockClear();
  adminRowQueue = {};
  adminRowsRead = {};
  mockSentBackEmail.mockReset().mockResolvedValue(undefined);
  mockNewBookEmails.mockReset().mockResolvedValue(undefined);
  mockAfterRuns.length = 0;
  mockHeldAfterTasks = null;
  mockRetention.mockReset().mockResolvedValue(undefined);
  rightsState = "present";
  paidAllowed = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  adminRows = {
    books: {
      data: {
        id: BOOK_ID,
        title: "Kënga e fundit",
        author_id: AUTHOR_ID,
        status: "draft",
        price_all: 0,
        description: "A real description.",
        pen_name_id: "pen-1",
      },
      error: null,
    },
    book_reviews: {
      data: { book_title: "Kënga e fundit", author_id: AUTHOR_ID, reason: "broken_file", message_to_author: "Fix the file." },
      error: null,
    },
  };
}

describe("approveBookReviewAsStaff", () => {
  beforeEach(resetReviewMocks);
  afterEach(() => vi.unstubAllEnvs());
  const approveForm = (extra: Record<string, string> = {}) =>
    form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: FILE, coverPath: COVER, ...ALL_CHECKS, ...extra });

  it("is refused in maintenance before requireStaff", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    expect((await redirectOf(() => approveBookReviewAsStaff(approveForm()))).startsWith("/admin/books?error=")).toBe(true);
    expect(mockRequireStaff).not.toHaveBeenCalled();
  });

  it("requires books.review, then every checklist box (server-side)", async () => {
    const f = approveForm();
    f.delete("file_opens");
    const target = await redirectOf(() => approveBookReviewAsStaff(f));
    expect(mockRequireStaff).toHaveBeenCalledWith("books.review");
    expect(target).toBe(`/admin/books/${BOOK_ID}?error=${encodeURIComponent("Tick all the checks before you approve.")}`);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls the RPC with the rendered files, the price it checked and the full checklist; then emails and cleans up", async () => {
    const target = await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    expect(mockRpc).toHaveBeenCalledWith("admin_approve_book_review", {
      p_review_id: REVIEW_ID,
      p_file_path: FILE,
      p_cover_path: COVER,
      p_price_all: 0,
      p_checklist: { cover_is_fine: true, file_opens: true, not_someone_elses_work: true, rights_declared: true },
    });
    expect(mockNewBookEmails).toHaveBeenCalledWith(expect.anything(), { bookId: BOOK_ID, authorId: AUTHOR_ID });
    expect(mockApprovedEmail).toHaveBeenCalledWith("ana@example.com", { title: "Kënga e fundit", bookId: BOOK_ID });
    // ALBANIAN-12: the author's own email goes before the follower batches.
    expect(mockApprovedEmail.mock.invocationCallOrder[0]).toBeLessThan(mockNewBookEmails.mock.invocationCallOrder[0]);
    expect(mockRetention).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      authorId: AUTHOR_ID,
      bookId: BOOK_ID,
      caller: "approveBookReviewAsStaff",
    });
    for (const path of ["/", "/librari", `/libra/${BOOK_ID}`, "/autore/pen-1", "/admin/books", `/admin/books/${BOOK_ID}`, "/dashboard"]) {
      expect(mockRevalidatePath).toHaveBeenCalledWith(path);
    }
    expect(target).toBe(`/admin/books/${BOOK_ID}?success=${encodeURIComponent("Book approved. It's live in the Bookstore now.")}`);
  });

  it("sends the follower emails only after the page has answered; the author's email goes before", async () => {
    const held: (() => Promise<unknown>)[] = [];
    mockHeldAfterTasks = held;
    const target = await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    expect(target).toContain("?success=");
    expect(mockApprovedEmail).toHaveBeenCalledOnce();
    expect(held).toHaveLength(1);
    expect(mockNewBookEmails).not.toHaveBeenCalled();
    await held[0]();
    expect(mockNewBookEmails).toHaveBeenCalledWith(expect.anything(), { bookId: BOOK_ID, authorId: AUTHOR_ID });
  });

  it("a followers email failure after the page has answered is only logged", async () => {
    mockNewBookEmails.mockRejectedValue(new Error("smtp"));
    expect(await redirectOf(() => approveBookReviewAsStaff(approveForm()))).toContain("?success=");
    await settleAfterTasks();
    expect(console.error).toHaveBeenCalledWith(
      "approveBookReviewAsStaff: the followers email failed after a successful approval",
      expect.objectContaining({ bookId: BOOK_ID }),
    );
  });

  it("a republication (not the first) emails no followers", async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });
    await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    expect(mockNewBookEmails).not.toHaveBeenCalled();
    expect(mockApprovedEmail).toHaveBeenCalledOnce();
  });

  it.each([
    ["no price", { price_all: null }, "This book has no price yet."],
    ["no description", { description: "  " }, "This book has no description yet."],
  ])("re-runs the author's publish gate first: %s", async (_label, overrides, text) => {
    adminRows.books = { data: { ...(adminRows.books.data as object), ...overrides }, error: null };
    const target = await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    expect(decodeURIComponent(target)).toContain(text);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("refuses without rights, or a paid title while paid publishing is closed", async () => {
    rightsState = "none";
    expect(decodeURIComponent(await redirectOf(() => approveBookReviewAsStaff(approveForm())))).toContain(
      "The author hasn't chosen the rights yet",
    );
    rightsState = "present";
    adminRows.books = { data: { ...(adminRows.books.data as object), price_all: 990 }, error: null };
    expect(decodeURIComponent(await redirectOf(() => approveBookReviewAsStaff(approveForm())))).toContain(
      "Paid publishing isn't available right now",
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ["the author changed the file or cover", "The author changed the file or cover. Reload and check again."],
    ["the author changed the book", "The author changed the book. Reload and check again."],
    ["this review is no longer waiting", "This book is no longer waiting for review. Reload to see what changed."],
    ["permission denied for table books", "Something went wrong. Please try again."],
  ])("maps %j and sends nothing", async (message, shown) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message } });
    const target = await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    expect(target).toBe(`/admin/books/${BOOK_ID}?error=${encodeURIComponent(shown)}`);
    expect(mockApprovedEmail).not.toHaveBeenCalled();
    expect(mockRetention).not.toHaveBeenCalled();
  });

  // BD15 P5b-2: a live book's approved changes.
  const OLD_COVER = "0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e/cover.jpg";
  const liveBook = () => {
    adminRows.books = { data: { ...(adminRows.books.data as object), status: "published", cover_path: OLD_COVER }, error: null };
  };
  it("a live book: the changes email, no followers email, and the replaced ballinë removed once the book names the new one", async () => {
    liveBook();
    mockRpc.mockResolvedValue({ data: false, error: null });
    adminRowQueue.books = [{ data: { cover_path: COVER }, error: null }];
    const target = await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    await settleAfterTasks();
    expect(target).toContain("?success=");
    expect(mockChangesApprovedEmail).toHaveBeenCalledWith("ana@example.com", { title: "Kënga e fundit", bookId: BOOK_ID });
    expect(mockApprovedEmail).not.toHaveBeenCalled();
    expect(mockNewBookEmails).not.toHaveBeenCalled();
    expect(mockCoverRemove).toHaveBeenCalledWith(["covers", OLD_COVER]);
  });

  it("a live book whose re-read does not name the new ballinë keeps the old one", async () => {
    liveBook();
    mockRpc.mockResolvedValue({ data: false, error: null });
    adminRowQueue.books = [{ data: { cover_path: OLD_COVER }, error: null }];
    await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    expect(mockCoverRemove).not.toHaveBeenCalled();
  });

  it("a live book with an unchanged ballinë removes nothing", async () => {
    liveBook();
    mockRpc.mockResolvedValue({ data: false, error: null });
    await redirectOf(() => approveBookReviewAsStaff(approveForm({ coverPath: OLD_COVER })));
    expect(mockCoverRemove).not.toHaveBeenCalled();
  });

  it("still reports success when the emails fail afterwards", async () => {
    mockNewBookEmails.mockRejectedValue(new Error("smtp"));
    mockApprovedEmail.mockRejectedValue(new Error("smtp"));
    expect(decodeURIComponent(await redirectOf(() => approveBookReviewAsStaff(approveForm())))).toContain("?success=");
  });
});

describe("sendBackBookReviewAsStaff", () => {
  beforeEach(resetReviewMocks);
  it("BD15 P5b-2: a live book's email says it stays on sale", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    adminRows.books = { data: { ...(adminRows.books.data as object), status: "published" }, error: null };
    await redirectOf(() => sendBackBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, reason: "broken_file", message: "x" })));
    expect(mockSentBackEmail).toHaveBeenCalledWith("ana@example.com", expect.objectContaining({ live: true }));
  });

  const sendBackForm = (extra: Record<string, string> = {}) =>
    form({ reviewId: REVIEW_ID, bookId: BOOK_ID, reason: "broken_file", message: " Fix the file. ", ...extra });

  it("requires books.review; a reason and a message are required", async () => {
    expect(await redirectOf(() => sendBackBookReviewAsStaff(sendBackForm({ reason: "author_asked" })))).toBe(
      `/admin/books/${BOOK_ID}?error=${encodeURIComponent("Choose a reason.")}`,
    );
    expect(await redirectOf(() => sendBackBookReviewAsStaff(sendBackForm({ message: "   " })))).toBe(
      `/admin/books/${BOOK_ID}?error=${encodeURIComponent("Write a message to the author.")}`,
    );
    expect(mockRequireStaff).toHaveBeenCalledWith("books.review");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls the RPC with the trimmed message, emails the author, cleans up and says so", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const target = await redirectOf(() => sendBackBookReviewAsStaff(sendBackForm()));
    expect(mockRpc).toHaveBeenCalledWith("admin_send_back_book_review", {
      p_review_id: REVIEW_ID,
      p_reason: "broken_file",
      p_message: "Fix the file.",
    });
    expect(mockSentBackEmail).toHaveBeenCalledWith("ana@example.com", {
      title: "Kënga e fundit",
      reasonLabel: "Skedar i gabuar ose i dëmtuar",
      message: "Fix the file.",
      live: false,
    });
    expect(mockRetention).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      authorId: AUTHOR_ID,
      bookId: BOOK_ID,
      caller: "sendBackBookReviewAsStaff",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(target).toBe(
      `/admin/books/${BOOK_ID}?success=${encodeURIComponent("Book sent back. The author sees your message on their Dashboard.")}`,
    );
  });

  it("maps RPC errors and sends nothing", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "this review is no longer waiting" } });
    expect(decodeURIComponent(await redirectOf(() => sendBackBookReviewAsStaff(sendBackForm())))).toContain(
      "This book is no longer waiting for review.",
    );
    expect(mockSentBackEmail).not.toHaveBeenCalled();
  });

  it("an expired session goes to log in", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "not authenticated" } });
    expect(await redirectOf(() => sendBackBookReviewAsStaff(sendBackForm()))).toBe(
      `/login?next=${encodeURIComponent(`/admin/books/${BOOK_ID}`)}`,
    );
  });
});

// BD15 P7 (Renato 11-05, Q1-Q4 a): public-domain editions.
describe("BD15 P7: approving a public-domain edition", () => {
  beforeEach(resetReviewMocks);
  const approveForm = () => form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: FILE, coverPath: COVER, ...ALL_CHECKS });
  const WORK_ID = "55555555-5555-4555-8555-555555555555";
  const withEdition = (credit: boolean) => {
    const row = adminRows.books.data as Record<string, unknown>;
    adminRows.books = { data: { ...row, pd_work_id: WORK_ID, pd_editor_credit: credit }, error: null };
  };

  it("a linked book goes through admin_approve_pd_edition (pick + swap), with the same arguments", async () => {
    withEdition(false);
    expect(await redirectOf(() => approveBookReviewAsStaff(approveForm()))).toContain("?success=");
    expect(mockRpc).toHaveBeenCalledWith("admin_approve_pd_edition", {
      p_review_id: REVIEW_ID,
      p_file_path: FILE,
      p_cover_path: COVER,
      p_price_all: 0,
      p_checklist: { cover_is_fine: true, file_opens: true, not_someone_elses_work: true, rights_declared: true },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/books/public-domain");
  });

  it("an uncredited edition's first publication emails no follower of its uploader", async () => {
    withEdition(false);
    await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    await settleAfterTasks();
    expect(mockNewBookEmails).not.toHaveBeenCalled();
    expect(mockApprovedEmail).toHaveBeenCalledOnce();
  });

  it("a credited edition's first publication emails followers as usual", async () => {
    withEdition(true);
    await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    await settleAfterTasks();
    expect(mockNewBookEmails).toHaveBeenCalledOnce();
  });

  it("an unlinked book still uses the plain approval", async () => {
    await redirectOf(() => approveBookReviewAsStaff(approveForm()));
    expect(mockRpc).toHaveBeenCalledWith("admin_approve_book_review", expect.anything());
  });

  it.each([
    [{ code: "LB498", message: "x" }, "Link it to a work in the Public-domain edition box"],
    [{ code: "LB485", message: "x" }, "can only go live as that work's edition"],
    [{ code: "LB499", message: "Link this book to a public-domain work first." }, "Link it to a work"],
    [{ code: "LB499", message: "<script>raw</script>" }, "Something went wrong"],
    // Audit r1 N4.
    [{ code: "23514", message: 'new row for relation "books" violates check constraint "books_pd_price_check"' }, "This book has a price."],
    [{ code: "23514", message: 'new row for relation "books" violates check constraint "books_pd_series_check"' }, "can't be in a series"],
  ])("maps %o", async (error, text) => {
    withEdition(false);
    mockRpc.mockResolvedValue({ data: null, error });
    const target = decodeURIComponent(await redirectOf(() => approveBookReviewAsStaff(approveForm())));
    expect(target).toContain("?error=");
    if (text === "Something went wrong") expect(target).not.toContain("<script>");
    else expect(target).toContain(text);
    expect(mockApprovedEmail).not.toHaveBeenCalled();
  });
});

describe("BD15 P7: setPdEditionAsStaff", () => {
  beforeEach(resetReviewMocks);
  const WORK_ID = "55555555-5555-4555-8555-555555555555";

  it("requires books.review and calls staff_set_pd_edition for a new work, trimmed", async () => {
    const target = await redirectOf(() =>
      setPdEditionAsStaff(
        form({ bookId: BOOK_ID, mode: "new", workTitle: "  Lahuta  e Malcís ", workOriginalAuthor: " Gjergj Fishta ", editorCredit: "on" }),
      ),
    );
    expect(mockRequireStaff).toHaveBeenCalledWith("books.review");
    expect(mockRpc).toHaveBeenCalledWith("staff_set_pd_edition", {
      p_book_id: BOOK_ID,
      p_work_id: null,
      p_work_title: "Lahuta e Malcís",
      p_work_original_author: "Gjergj Fishta",
      p_editor_credit: true,
    });
    expect(target).toBe(`/admin/books/${BOOK_ID}?success=${encodeURIComponent("Public-domain edition saved.")}`);
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/libra/${BOOK_ID}`);
  });

  it("links to an existing work; an unticked box is no mention", async () => {
    await redirectOf(() => setPdEditionAsStaff(form({ bookId: BOOK_ID, mode: "existing", workId: WORK_ID })));
    expect(mockRpc).toHaveBeenCalledWith("staff_set_pd_edition", {
      p_book_id: BOOK_ID,
      p_work_id: WORK_ID,
      p_work_title: null,
      p_work_original_author: null,
      p_editor_credit: false,
    });
  });

  it("unlinks with no work and no mention, whatever the box says", async () => {
    await redirectOf(() => setPdEditionAsStaff(form({ bookId: BOOK_ID, mode: "unlink", workId: WORK_ID, editorCredit: "on" })));
    expect(mockRpc).toHaveBeenCalledWith("staff_set_pd_edition", {
      p_book_id: BOOK_ID,
      p_work_id: null,
      p_work_title: null,
      p_work_original_author: null,
      p_editor_credit: false,
    });
  });

  it.each([
    [{ bookId: BOOK_ID, mode: "existing", workId: "nope" }],
    [{ bookId: BOOK_ID, mode: "new", workTitle: "  ", workOriginalAuthor: "A" }],
    [{ bookId: BOOK_ID, mode: "new", workTitle: "T", workOriginalAuthor: "" }],
    [{ bookId: BOOK_ID, mode: "whatever" }],
  ])("refuses a form it can't use, before the RPC: %o", async (fields) => {
    const target = decodeURIComponent(await redirectOf(() => setPdEditionAsStaff(form(fields))));
    expect(target).toContain("Choose a work, or give the new work's title and original author.");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("maps the RPC's refusal", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "LB499", message: "A live edition stays with its work. Only its editor mention can change." },
    });
    const target = decodeURIComponent(
      await redirectOf(() => setPdEditionAsStaff(form({ bookId: BOOK_ID, mode: "existing", workId: WORK_ID }))),
    );
    expect(target).toContain("?error=A live edition stays with its work.");
  });

  it("is refused in maintenance before requireStaff", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    expect((await redirectOf(() => setPdEditionAsStaff(form({ bookId: BOOK_ID, mode: "unlink" })))).startsWith("/admin/books?error=")).toBe(true);
    expect(mockRequireStaff).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

// BD16 P3: approving and sending back pre-orders.
describe("BD16 P3: pre-order reviews", () => {
  beforeEach(() => {
    resetReviewMocks();
    mockPreorderListedEmail.mockReset().mockResolvedValue(undefined);
    mockPreorderFileEmail.mockReset().mockResolvedValue(undefined);
    mockScheduleReaders.mockClear();
  });
  const NO_FILE_CHECKS = { cover_is_fine: "on", rights_ok: "on" };
  const setBook = (fields: Record<string, unknown>) => {
    adminRows.books = { data: { ...(adminRows.books.data as object), ...fields }, error: null };
  };

  it("a listing without a file: two boxes are enough, the RPC gets the three-key checklist, the author gets the listing email", async () => {
    setBook({ status: "draft", file_path: null, release_date: "2026-12-12" });
    mockRpc.mockResolvedValue({ data: false, error: null });
    adminRowQueue.books = [{ data: { status: "preorder", release_date: "2026-12-12" }, error: null }];
    const target = await redirectOf(() =>
      approveBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: "", coverPath: COVER, ...NO_FILE_CHECKS })),
    );
    expect(mockRpc).toHaveBeenCalledWith("admin_approve_book_review", {
      p_review_id: REVIEW_ID,
      p_file_path: null,
      p_cover_path: COVER,
      p_price_all: 0,
      p_checklist: { cover_is_fine: true, not_someone_elses_work: true, rights_declared: true },
    });
    expect(target).toBe(
      `/admin/books/${BOOK_ID}?success=${encodeURIComponent("Pre-order approved. It shows in the Bookstore as coming out on its date.")}`,
    );
    expect(mockPreorderListedEmail).toHaveBeenCalledWith("ana@example.com", {
      title: "Kënga e fundit",
      bookId: BOOK_ID,
      releaseDate: "2026-12-12",
      hasFile: false,
    });
    expect(mockApprovedEmail).not.toHaveBeenCalled();
    await settleAfterTasks();
    expect(mockNewBookEmails).not.toHaveBeenCalled();
  });

  // Audit r1 N1 + N2.
  it("a listing whose re-read fails is still a listing: never the published email or message", async () => {
    setBook({ status: "draft", file_path: FILE, release_date: "2026-12-12" });
    mockRpc.mockResolvedValue({ data: false, error: null });
    adminRowQueue.books = [{ data: null, error: { message: "boom" } }];
    const target = await redirectOf(() =>
      approveBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: FILE, coverPath: COVER, ...ALL_CHECKS })),
    );
    expect(target).toContain(encodeURIComponent("Pre-order approved."));
    expect(mockApprovedEmail).not.toHaveBeenCalled();
    expect(mockPreorderListedEmail).toHaveBeenCalledWith("ana@example.com", {
      title: "Kënga e fundit",
      bookId: BOOK_ID,
      releaseDate: "2026-12-12",
      hasFile: true,
    });
  });

  it("a review with a file still needs the file box", async () => {
    const f = form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: FILE, coverPath: COVER, ...NO_FILE_CHECKS });
    const target = await redirectOf(() => approveBookReviewAsStaff(f));
    expect(target).toContain(encodeURIComponent("Tick all the checks before you approve."));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("a pre-order's final file before its day: the final-file email, no followers, it stays a pre-order", async () => {
    setBook({ status: "preorder", file_path: null, release_date: "2026-12-12" });
    mockRpc.mockResolvedValue({ data: false, error: null });
    adminRowQueue.books = [{ data: { status: "preorder", release_date: "2026-12-12" }, error: null }];
    const target = await redirectOf(() => approveBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: FILE, coverPath: COVER, ...ALL_CHECKS })));
    expect(target).toContain(encodeURIComponent("Final file approved. The book stays a pre-order"));
    expect(mockPreorderFileEmail).toHaveBeenCalledWith("ana@example.com", {
      title: "Kënga e fundit",
      bookId: BOOK_ID,
      releaseDate: "2026-12-12",
    });
    await settleAfterTasks();
    expect(mockNewBookEmails).not.toHaveBeenCalled();
    expect(mockApprovedEmail).not.toHaveBeenCalled();
    // P5: the sweep is scheduled for any pre-order final file; it acts
    // only on a published book, so nothing goes to readers here.
    expect(mockScheduleReaders).toHaveBeenCalledWith("approveBookReviewAsStaff");
  });

  it("a pre-order's final file approved after its day releases it: the published email and the followers email", async () => {
    setBook({ status: "preorder", file_path: null, release_date: "2026-11-01" });
    mockRpc.mockResolvedValue({ data: true, error: null });
    adminRowQueue.books = [{ data: { status: "published", release_date: "2026-11-01" }, error: null }];
    const target = await redirectOf(() => approveBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: FILE, coverPath: COVER, ...ALL_CHECKS })));
    expect(target).toContain(encodeURIComponent("Final file approved. Its day had passed, so the book is live now."));
    expect(mockApprovedEmail).toHaveBeenCalledWith("ana@example.com", { title: "Kënga e fundit", bookId: BOOK_ID });
    await settleAfterTasks();
    expect(mockNewBookEmails).toHaveBeenCalledTimes(1);
    expect(mockPreorderFileEmail).not.toHaveBeenCalled();
    // P5: its "Më njofto" readers hear now, not at the next morning's job.
    expect(mockScheduleReaders).toHaveBeenCalledTimes(1);
  });

  it("P5: a listing or a pre-order's other changes schedule no reader sweep", async () => {
    setBook({ status: "draft", file_path: null, release_date: "2026-12-12" });
    mockRpc.mockResolvedValue({ data: false, error: null });
    adminRowQueue.books = [{ data: { status: "preorder", release_date: "2026-12-12" }, error: null }];
    await redirectOf(() =>
      approveBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: "", coverPath: COVER, ...NO_FILE_CHECKS })),
    );
    expect(mockScheduleReaders).not.toHaveBeenCalled();
  });

  it("a pre-order's other changes: the changes email", async () => {
    setBook({ status: "preorder", file_path: FILE, release_date: "2026-12-12" });
    mockRpc.mockResolvedValue({ data: false, error: null });
    adminRowQueue.books = [{ data: { status: "preorder", release_date: "2026-12-12" }, error: null }];
    const target = await redirectOf(() => approveBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: FILE, coverPath: COVER, ...ALL_CHECKS })));
    expect(target).toContain(encodeURIComponent("Changes approved. Readers see the new version of the pre-order."));
    expect(mockChangesApprovedEmail).toHaveBeenCalledTimes(1);
    expect(mockPreorderFileEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["LB506", "Too late to approve: this pre-order's date is too close. Send it back so the author picks a new date."],
    ["LB501", "This book has had its 2 pre-orders. Send it back; the author can still publish it as usual."],
    ["LB503", "This pre-order changed. Reload and check again."],
  ])("the database's %s is said to staff, and nothing is sent", async (code, shown) => {
    setBook({ status: "draft", file_path: null, release_date: "2026-11-08" });
    mockRpc.mockResolvedValue({ data: null, error: { code, message: "raw database text" } });
    const target = await redirectOf(() =>
      approveBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, filePath: "", coverPath: COVER, ...NO_FILE_CHECKS })),
    );
    expect(target).toBe(`/admin/books/${BOOK_ID}?error=${encodeURIComponent(shown)}`);
    expect(mockPreorderListedEmail).not.toHaveBeenCalled();
  });

  it("a pre-order's sent-back change is a live book's (it stays listed)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockGetUserById.mockResolvedValue({ data: { user: { email: "ana@example.com" } } });
    setBook({ status: "preorder" });
    await redirectOf(() => sendBackBookReviewAsStaff(form({ reviewId: REVIEW_ID, bookId: BOOK_ID, reason: "broken_file", message: "Fix it." })));
    expect(mockSentBackEmail).toHaveBeenCalledWith("ana@example.com", expect.objectContaining({ live: true }));
  });
});

describe("Upload notes D: countBookPagesAsStaff", () => {
  const FILE = "author-1/22222222-2222-4222-8222-222222222222/v3.epub";
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRevalidatePath.mockReset();
    mockRequireStaff.mockClear();
    mockDownload.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    mockRecordWords.mockReset().mockResolvedValue("recorded");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    adminRows = { books: { data: { id: BOOK_ID, file_path: FILE }, error: null } };
    adminRowQueue = {};
    adminRowsRead = {};
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("needs books.review, counts the CURRENT file and stores it for that file", async () => {
    const target = await redirectOf(() => countBookPagesAsStaff(BOOK_ID));
    expect(mockRequireStaff).toHaveBeenCalledWith("books.review");
    expect(mockDownload).toHaveBeenCalledWith("manuscripts", FILE);
    expect(mockRecordWords).toHaveBeenCalledTimes(1);
    const [, params] = mockRecordWords.mock.calls[0] as [unknown, { bookId: string; filePath: string; bytes: Buffer }];
    expect(params.bookId).toBe(BOOK_ID);
    expect(params.filePath).toBe(FILE);
    expect(Buffer.isBuffer(params.bytes)).toBe(true);
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/libra/${BOOK_ID}`);
    expect(target).toBe(`/admin/books/${BOOK_ID}?success=${encodeURIComponent("Pages counted.")}`);
  });

  it("refuses a non-uuid id before any read", async () => {
    const target = await redirectOf(() => countBookPagesAsStaff("../x"));
    expect(target).toBe("/admin/books");
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("a book with no file: nothing read or written", async () => {
    adminRows = { books: { data: { id: BOOK_ID, file_path: null }, error: null } };
    const target = await redirectOf(() => countBookPagesAsStaff(BOOK_ID));
    expect(target).toContain(encodeURIComponent("This book has no file to count."));
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockRecordWords).not.toHaveBeenCalled();
  });

  it("an unread file or a failed count is an error, never a success", async () => {
    mockDownload.mockResolvedValueOnce({ data: null, error: { message: "nope" } });
    let target = await redirectOf(() => countBookPagesAsStaff(BOOK_ID));
    expect(target).toContain(encodeURIComponent("Couldn't count this book's pages. Try again."));
    expect(mockRecordWords).not.toHaveBeenCalled();

    mockRecordWords.mockResolvedValueOnce("unreadable");
    target = await redirectOf(() => countBookPagesAsStaff(BOOK_ID));
    expect(target).toContain(encodeURIComponent("Couldn't count this book's pages. Try again."));
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
