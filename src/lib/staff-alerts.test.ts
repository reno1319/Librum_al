import { beforeEach, describe, expect, it, vi } from "vitest";

// ADMIN-ALERTS-1: who gets the staff alerts (1a, 5a), what they say
// (4a), and that nothing ever throws (6a).

type SendArgs = { from: string; to: string; subject: string; html: string };
const sendMock = vi.fn((_args: SendArgs) => {
  void _args;
  return Promise.resolve({ data: { id: "email-1" }, error: null });
});
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function (this: unknown) {
    return { emails: { send: sendMock } };
  }),
}));

type Fake = {
  staff: { user_id: string; role: string }[] | null;
  staffError?: { code: string } | null;
  title: string | null;
  throwOnCreate?: boolean;
  // ADMIN-ALERTS-1 r2 (F1): rows counted in the cap window.
  recentCount: number | null;
  countError?: { code: string } | null;
};
const countQueries: { table: string; eq: [string, string]; gte: [string, string] }[] = [];
let fake: Fake;
const reads: string[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (fake.throwOnCreate) throw new Error("no env");
    return {
      from: (table: string) => {
        reads.push(table);
        if (table === "staff_members") {
          return {
            select: () => ({
              returns: () => Promise.resolve({ data: fake.staff, error: fake.staffError ?? null }),
            }),
          };
        }
        if (table === "book_reviews" || table === "book_reports") {
          return {
            select: (_columns: string, options: { count: string; head: boolean }) => {
              expect(options).toEqual({ count: "exact", head: true });
              return {
                eq: (column: string, value: string) => ({
                  gte: (timeColumn: string, since: string) => {
                    countQueries.push({ table, eq: [column, value], gte: [timeColumn, since] });
                    return Promise.resolve({ count: fake.recentCount, error: fake.countError ?? null });
                  },
                }),
              };
            },
          };
        }
        if (table === "books") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: fake.title === null ? null : { title: fake.title } }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      auth: {
        admin: {
          getUserById: (id: string) =>
            Promise.resolve({ data: { user: id === "no-email" ? { email: null } : { email: `${id}@example.com` } } }),
        },
      },
    };
  },
}));

process.env.RESEND_API_KEY = "test-key";

const { sendReviewRequestedStaffEmail, sendBookReportedStaffEmail, REVIEW_EMAIL_WINDOW_MS, REPORT_EMAIL_WINDOW_MS } =
  await import("./staff-alerts");

const ALL_ROLES = [
  { user_id: "owner-1", role: "owner" },
  { user_id: "admin-1", role: "admin" },
  { user_id: "mod-1", role: "moderator" },
  { user_id: "support-1", role: "support" },
  { user_id: "editor-1", role: "editor" },
  { user_id: "weird-1", role: "superuser" },
];

function recipients() {
  return sendMock.mock.calls.map(([args]) => args.to).sort();
}

beforeEach(() => {
  sendMock.mockClear();
  reads.length = 0;
  countQueries.length = 0;
  fake = { staff: ALL_ROLES, title: "Test Book", recentCount: 1 };
});

describe("sendReviewRequestedStaffEmail", () => {
  it("emails owner and admin only (books.review), one email each", async () => {
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    expect(recipients()).toEqual(["admin-1@example.com", "owner-1@example.com"]);
  });

  it("skips the author when the author is staff (5a)", async () => {
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "admin-1" });
    expect(recipients()).toEqual(["owner-1@example.com"]);
  });

  it("names the book, escaped, and links its admin page", async () => {
    fake.title = 'A <b>"bold"</b>\nTitle';
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    const { subject, html } = sendMock.mock.calls[0][0];
    expect(subject).toBe('Review needed: “A <b>"bold"</b> Title”');
    expect(html).toContain("A &lt;b&gt;&quot;bold&quot;&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("/admin/books/book-1");
  });

  it("sends nothing when the book is gone", async () => {
    fake.title = null;
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(reads).not.toContain("staff_members");
  });

  it("caps at one email per book per hour: counts this book's review requests since an hour ago (F1)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    vi.useRealTimers();
    expect(REVIEW_EMAIL_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(countQueries).toEqual([
      { table: "book_reviews", eq: ["book_id", "book-1"], gte: ["submitted_at", "2026-10-27T11:00:00.000Z"] },
    ]);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when the book already had a review request in the last hour (F1)", async () => {
    fake.recentCount = 2;
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(reads).not.toContain("staff_members");
  });

  it("sends nothing and logs when the cap count cannot be read (F1)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.recentCount = null;
    fake.countError = { code: "XX000" };
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("staff alert: could not count recent rows", {
      table: "book_reviews",
      code: "XX000",
    });
    errorSpy.mockRestore();
  });

  it("skips a staff account with no address", async () => {
    fake.staff = [
      { user_id: "no-email", role: "owner" },
      { user_id: "admin-1", role: "admin" },
    ];
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    expect(recipients()).toEqual(["admin-1@example.com"]);
  });

  it("logs and sends nothing when staff cannot be read", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.staff = null;
    fake.staffError = { code: "42501" };
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("staff alert: could not read staff", { code: "42501" });
    errorSpy.mockRestore();
  });

  it("never throws, and logs no address", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.throwOnCreate = true;
    await expect(sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" })).resolves.toBeUndefined();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("@");
    errorSpy.mockRestore();
  });

  it("keeps going when one send throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockImplementationOnce(() => Promise.reject(new Error("network")));
    await sendReviewRequestedStaffEmail({ bookId: "book-1", authorId: "author-1" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});

describe("sendBookReportedStaffEmail", () => {
  it("emails owner, admin and moderator (reports.resolve)", async () => {
    await sendBookReportedStaffEmail({ bookId: "book-1", reporterId: "reader-1", reason: "Other" });
    expect(recipients()).toEqual(["admin-1@example.com", "mod-1@example.com", "owner-1@example.com"]);
  });

  it("skips the reporter when the reporter is staff (5a)", async () => {
    await sendBookReportedStaffEmail({ bookId: "book-1", reporterId: "mod-1", reason: "Other" });
    expect(recipients()).toEqual(["admin-1@example.com", "owner-1@example.com"]);
  });

  it("names the book and reason and links Reports, nothing about the reporter (4a)", async () => {
    await sendBookReportedStaffEmail({ bookId: "book-1", reporterId: "reader-1", reason: "Copyright infringement" });
    const { subject, html } = sendMock.mock.calls[0][0];
    expect(subject).toBe("Book reported: “Test Book”");
    expect(html).toContain("<strong>Test Book</strong>. Reason: Copyright infringement");
    expect(html).toContain("/admin/reports");
    expect(html).not.toContain("reader-1");
  });

  it("escapes the book title in the report email (F3)", async () => {
    fake.title = 'A <b>"bold"</b>\nTitle';
    await sendBookReportedStaffEmail({ bookId: "book-1", reporterId: "reader-1", reason: "Other" });
    const { subject, html } = sendMock.mock.calls[0][0];
    expect(subject).toBe('Book reported: “A <b>"bold"</b> Title”');
    expect(html).toContain("<strong>A &lt;b&gt;&quot;bold&quot;&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("caps at one email per reader per 24 hours: counts this reader's reports since a day ago (F1)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    await sendBookReportedStaffEmail({ bookId: "book-1", reporterId: "reader-1", reason: "Other" });
    vi.useRealTimers();
    expect(REPORT_EMAIL_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(countQueries).toEqual([
      { table: "book_reports", eq: ["reporter_id", "reader-1"], gte: ["created_at", "2026-10-26T12:00:00.000Z"] },
    ]);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("sends nothing when the reader already reported in the last 24 hours, any book (F1)", async () => {
    fake.recentCount = 2;
    await sendBookReportedStaffEmail({ bookId: "book-2", reporterId: "reader-1", reason: "Other" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(reads).not.toContain("staff_members");
  });

  it("sends nothing when the report cap count cannot be read (F1)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.recentCount = null;
    fake.countError = { code: "XX000" };
    await sendBookReportedStaffEmail({ bookId: "book-1", reporterId: "reader-1", reason: "Other" });
    expect(sendMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("sends nothing for a reason outside the list", async () => {
    await sendBookReportedStaffEmail({ bookId: "book-1", reporterId: "reader-1", reason: "<script>" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
  });
});
