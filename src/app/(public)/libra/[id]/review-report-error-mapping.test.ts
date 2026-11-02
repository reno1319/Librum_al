import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 LAUNCH-FIX-1A ERR-2: focused coverage of the two ERR-2
// sites in this file (submitReview's review upsert, submitReport's
// book_reports insert) -- separate from actions.test.ts's own narrow
// buyBook-recovery coverage so this file's own mock Supabase client can
// stay minimal and purpose-built, rather than growing that file's
// existing focused scope.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockGetUser = vi.fn();
// BD13: the review is saved through submit_reader_review().
const mockSubmitReviewRpc = vi.fn();
const mockUpsertReview = vi.fn();
const mockInsertReport = vi.fn();

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    rpc: (fn: string, args: unknown) => {
      if (fn !== "submit_reader_review") throw new Error(`unexpected rpc in this focused test: ${fn}`);
      return mockSubmitReviewRpc(args);
    },
    from: (table: string) => {
      if (table === "reviews") {
        return { upsert: () => mockUpsertReview() };
      }
      if (table === "book_reports") {
        return { insert: () => mockInsertReport() };
      }
      throw new Error(`unexpected table in this focused test: ${table}`);
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ADMIN-ALERTS-1: the staff email after a saved report.
const mockReportedStaffEmail = vi.fn(async (_args: unknown) => {
  void _args;
});
vi.mock("@/lib/staff-alerts", () => ({
  sendBookReportedStaffEmail: (args: unknown) => mockReportedStaffEmail(args),
}));

const { submitReview, submitReport } = await import("./actions");

describe("submitReview: ERR-2 error-message mapping", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "reader-1" } } });
    mockSubmitReviewRpc.mockReset();
    mockUpsertReview.mockReset();
  });

  it("maps a raw Postgres/PostgREST error to a stable Librum-facing message, never error.message", async () => {
    const formData = new FormData();
    formData.set("rating", "5");
    formData.set("body", "Loved it");
    mockSubmitReviewRpc.mockResolvedValue({
      data: null,
      error: { message: 'new row violates row-level security policy for table "reviews"' },
    });

    await expect(submitReview("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("Nuk e ruajtëm dot vlerësimin tuaj. Provoni përsëri."),
    );
    expect(redirectedTo).not.toContain("row-level security");
  });

  it("still redirects with the existing, Librum-authored validation message for an out-of-range rating -- untouched by ERR-2", async () => {
    const formData = new FormData();
    formData.set("rating", "9");
    formData.set("body", "");

    await expect(submitReview("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("error=Zgjidhni%20yjet."),
    );
    expect(mockSubmitReviewRpc).not.toHaveBeenCalled();
  });

  // BD13: the function's one-word answers.
  it("sends the trimmed name, text and rating to submit_reader_review, never a direct write", async () => {
    const formData = new FormData();
    formData.set("rating", "4");
    formData.set("body", "  E bukur  ");
    formData.set("review_name", "  Lexuesi  ");
    mockSubmitReviewRpc.mockResolvedValue({ data: "pending", error: null });

    await expect(submitReview("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockSubmitReviewRpc).toHaveBeenCalledWith({
      p_book_id: "book-1",
      p_rating: 4,
      p_body: "E bukur",
      p_review_name: "Lexuesi",
    });
    expect(mockUpsertReview).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith("/libra/book-1?review=pending#vleresimet");
  });

  it("an identical resubmission says unchanged", async () => {
    const formData = new FormData();
    formData.set("rating", "4");
    mockSubmitReviewRpc.mockResolvedValue({ data: "unchanged", error: null });
    await expect(submitReview("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith("/libra/book-1?review=unchanged#vleresimet");
  });

  it.each([
    ["not_owner", "Blini këtë libër për ta vlerësuar."],
    ["own_book", "Nuk mund ta vlerësoni librin tuaj."],
    ["bad_rating", "Zgjidhni yjet."],
    ["too_long", "Komenti mund të ketë deri në 4.000 karaktere."],
    ["name_required", "Shkruani emrin që do të shfaqet te vlerësimi."],
    ["bad_name", "Emri duhet të ketë nga 2 deri në 40 karaktere."],
    ["something_new", "Nuk e ruajtëm dot vlerësimin tuaj. Provoni përsëri."],
  ])("maps %s to its Albanian message", async (result, message) => {
    const formData = new FormData();
    formData.set("rating", "4");
    mockSubmitReviewRpc.mockResolvedValue({ data: result, error: null });
    await expect(submitReview("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(`/libra/book-1?error=${encodeURIComponent(message)}`);
  });
});

describe("submitReport: ERR-2 error-message mapping", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "reader-1" } } });
    mockInsertReport.mockReset();
    mockReportedStaffEmail.mockClear();
  });

  it("emails staff once after a saved report, then redirects to success (ADMIN-ALERTS-1)", async () => {
    const formData = new FormData();
    formData.set("reason", "Other");
    formData.set("details", "private text");
    mockInsertReport.mockResolvedValue({ error: null });

    await expect(submitReport("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockReportedStaffEmail).toHaveBeenCalledTimes(1);
    expect(mockReportedStaffEmail).toHaveBeenCalledWith({ bookId: "book-1", reporterId: "reader-1", reason: "Other" });
    expect(mockRedirect).toHaveBeenCalledWith("/libra/book-1?report=success");
  });

  it("maps a raw Postgres/PostgREST error to a stable Librum-facing message, never error.message", async () => {
    const formData = new FormData();
    formData.set("reason", "Spam or misleading listing");
    formData.set("details", "");
    mockInsertReport.mockResolvedValue({
      error: { message: "duplicate key value violates unique constraint" },
    });

    await expect(submitReport("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("Nuk e dërguam dot raportimin tuaj. Provoni përsëri."),
    );
    expect(redirectedTo).not.toContain("duplicate key");
    expect(mockReportedStaffEmail).not.toHaveBeenCalled();
  });

  it("still redirects with the existing, Librum-authored validation message for a missing reason -- untouched by ERR-2", async () => {
    const formData = new FormData();
    formData.set("reason", "not-a-real-reason");

    await expect(submitReport("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("error=Zgjidhni%20nj%C3%AB%20arsye."),
    );
    expect(mockInsertReport).not.toHaveBeenCalled();
    expect(mockReportedStaffEmail).not.toHaveBeenCalled();
  });
});
