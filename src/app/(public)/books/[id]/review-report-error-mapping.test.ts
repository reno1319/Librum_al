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
const mockOwnsBookRpc = vi.fn();
const mockUpsertReview = vi.fn();
const mockInsertReport = vi.fn();

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    rpc: (fn: string) => {
      if (fn !== "user_owns_book") throw new Error(`unexpected rpc in this focused test: ${fn}`);
      return mockOwnsBookRpc();
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
    mockOwnsBookRpc.mockReset().mockResolvedValue({ data: true });
    mockUpsertReview.mockReset();
  });

  it("maps a raw Postgres/PostgREST error to a stable Librum-facing message, never error.message", async () => {
    const formData = new FormData();
    formData.set("rating", "5");
    formData.set("body", "Loved it");
    mockUpsertReview.mockResolvedValue({
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
    expect(mockUpsertReview).not.toHaveBeenCalled();
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
    expect(mockRedirect).toHaveBeenCalledWith("/books/book-1?report=success");
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
