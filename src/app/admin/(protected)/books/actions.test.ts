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
const mockGetUserById = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const done = () => Promise.resolve(adminRows[table] ?? { data: null, error: null });
      const chain = { select: () => chain, eq: () => chain, in: () => chain, maybeSingle: done, returns: done };
      return chain;
    },
    auth: { admin: { getUserById: (id: string) => mockGetUserById(id) } },
  }),
}));

const mockSendEmail = vi.fn();
// ADMIN-3-REVIEW: the review emails, the followers email, the rights
// read, the paid permission and the retention cleanup.
const mockApprovedEmail = vi.fn();
const mockSentBackEmail = vi.fn();
const mockNewBookEmails = vi.fn();
vi.mock("@/lib/email", () => ({
  sendBookTakedownEmail: (to: string, args: unknown) => mockSendEmail(to, args),
  sendBookApprovedEmail: (to: string, args: unknown) => mockApprovedEmail(to, args),
  sendBookSentBackEmail: (to: string, args: unknown) => mockSentBackEmail(to, args),
  sendNewBookEmails: (admin: unknown, args: unknown) => mockNewBookEmails(admin, args),
}));
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

const { unpublishBookAsStaff, allowBookAgainAsStaff, approveBookReviewAsStaff, sendBackBookReviewAsStaff } = await import(
  "./actions"
);

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
const ALL_CHECKS = { cover_is_fine: "on", file_opens: "on", not_someone_elses_work: "on", rights_declared: "on" };

function resetReviewMocks(): void {
  mockRedirect.mockClear();
  mockRevalidatePath.mockReset();
  mockRequireStaff.mockClear();
  mockRpc.mockReset().mockResolvedValue({ data: true, error: null });
  mockGetUserById.mockReset().mockResolvedValue({ data: { user: { email: "ana@example.com" } } });
  mockApprovedEmail.mockReset().mockResolvedValue(undefined);
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
    expect(target).toBe(`/admin/books/${BOOK_ID}?error=${encodeURIComponent("Tick all four checks before you approve.")}`);
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

  it("still reports success when the emails fail afterwards", async () => {
    mockNewBookEmails.mockRejectedValue(new Error("smtp"));
    mockApprovedEmail.mockRejectedValue(new Error("smtp"));
    expect(decodeURIComponent(await redirectOf(() => approveBookReviewAsStaff(approveForm())))).toContain("?success=");
  });
});

describe("sendBackBookReviewAsStaff", () => {
  beforeEach(resetReviewMocks);
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
