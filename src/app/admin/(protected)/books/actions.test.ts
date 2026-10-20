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
vi.mock("@/lib/email", () => ({ sendBookTakedownEmail: (to: string, args: unknown) => mockSendEmail(to, args) }));

const { unpublishBookAsStaff, allowBookAgainAsStaff } = await import("./actions");

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
      reasonLabel: "Copyright complaint",
      message: "Send proof.",
      bundleTitles: ["Set A"],
    });
    for (const path of [
      "/",
      "/bookstore",
      `/books/${BOOK_ID}`,
      "/admin/books",
      `/admin/books/${BOOK_ID}`,
      "/dashboard",
      "/bundles/bundle-1",
      "/authors/pen-1",
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
