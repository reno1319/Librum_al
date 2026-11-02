import { beforeEach, describe, expect, it, vi } from "vitest";

// BD13: the queue's actions. requireStaff first, the form check, then
// the database function on the staff member's own session; the reader's
// book page is revalidated only after a decision went through.
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
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args) }));

const mockRequireStaff = vi.fn((_permission: string) => Promise.resolve({ userId: "staff-1", role: "moderator" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => Promise.resolve({ rpc: mockRpc }) }));

const { approveReaderReviewAsStaff, rejectReaderReviewAsStaff, setReviewNameAsStaff } = await import("./actions");

const REVIEW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEEN = "2026-11-02T10:00:00.123456+00:00";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function target(run: Promise<void>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (e instanceof RedirectSignal) return decodeURIComponent(e.target);
    throw e;
  }
  throw new Error("no redirect");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("approveReaderReviewAsStaff", () => {
  it("gates on reports.resolve, sends the seen timestamp and revalidates the book page", async () => {
    mockRpc.mockResolvedValue({ data: "approved", error: null });
    const to = await target(approveReaderReviewAsStaff(form({ review_id: REVIEW, seen: SEEN, book_id: BOOK })));
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.resolve");
    expect(mockRpc).toHaveBeenCalledWith("staff_approve_reader_review", { p_review_id: REVIEW, p_seen_updated_at: SEEN });
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/libra/${BOOK}`);
    expect(to).toBe("/admin/reader-reviews?success=Review approved.");
  });

  it("refuses a review the reader changed since, without revalidating", async () => {
    mockRpc.mockResolvedValue({ data: "changed", error: null });
    const to = await target(approveReaderReviewAsStaff(form({ review_id: REVIEW, seen: SEEN, book_id: BOOK })));
    expect(to).toContain("?error=The reader changed this review");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a staff member's own review without revalidating (audit r1 S3)", async () => {
    mockRpc.mockResolvedValue({ data: "own_review", error: null });
    const to = await target(approveReaderReviewAsStaff(form({ review_id: REVIEW, seen: SEEN, book_id: BOOK })));
    expect(to).toBe("/admin/reader-reviews?error=You can't approve or reject your own review. Another staff member has to.");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("calls nothing for a malformed form, and shows the generic error on a database error", async () => {
    expect(await target(approveReaderReviewAsStaff(form({ review_id: "x", seen: SEEN })))).toContain("?error=Something went wrong");
    expect(mockRpc).not.toHaveBeenCalled();
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect(await target(approveReaderReviewAsStaff(form({ review_id: REVIEW, seen: SEEN })))).toContain(
      "?error=Something went wrong",
    );
  });
});

describe("rejectReaderReviewAsStaff", () => {
  it("needs a reason, and a note for Other, before calling the database", async () => {
    expect(await target(rejectReaderReviewAsStaff(form({ review_id: REVIEW, seen: SEEN, reason: "" })))).toContain(
      "?error=Choose a reason.",
    );
    expect(
      await target(rejectReaderReviewAsStaff(form({ review_id: REVIEW, seen: SEEN, reason: "other", note: "  " }))),
    ).toContain("?error=Write a note for “Other”.");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("sends the reason and the trimmed note (null when empty)", async () => {
    mockRpc.mockResolvedValue({ data: "rejected", error: null });
    const to = await target(
      rejectReaderReviewAsStaff(form({ review_id: REVIEW, seen: SEEN, book_id: BOOK, reason: "abusive", note: " " })),
    );
    expect(mockRpc).toHaveBeenCalledWith("staff_reject_reader_review", {
      p_review_id: REVIEW,
      p_seen_updated_at: SEEN,
      p_reason: "abusive",
      p_note: null,
    });
    expect(to).toBe("/admin/reader-reviews?success=Review rejected. The reader sees the reason on the book page.");

    await target(
      rejectReaderReviewAsStaff(form({ review_id: REVIEW, seen: SEEN, reason: "other", note: " Hiqni lidhjen. " })),
    );
    expect(mockRpc).toHaveBeenLastCalledWith("staff_reject_reader_review", expect.objectContaining({ p_note: "Hiqni lidhjen." }));
  });
});

describe("setReviewNameAsStaff", () => {
  it("needs people.view and reports.resolve, saves a name and clears on empty", async () => {
    mockRpc.mockResolvedValue({ data: "saved", error: null });
    const saved = await target(setReviewNameAsStaff(form({ user_id: REVIEW, review_name: " Ana " })));
    expect(mockRequireStaff).toHaveBeenCalledWith("people.view");
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.resolve");
    expect(mockRpc).toHaveBeenCalledWith("staff_set_review_name", { p_user_id: REVIEW, p_name: "Ana" });
    expect(saved).toBe(`/admin/people/${REVIEW}?success=Review name saved.`);

    const cleared = await target(setReviewNameAsStaff(form({ user_id: REVIEW, review_name: "" })));
    expect(mockRpc).toHaveBeenLastCalledWith("staff_set_review_name", { p_user_id: REVIEW, p_name: null });
    expect(cleared).toContain("?success=Review name cleared.");
  });

  it("refuses a one-letter name without calling the database", async () => {
    const to = await target(setReviewNameAsStaff(form({ user_id: REVIEW, review_name: "A" })));
    expect(to).toContain("?error=A review name has 2 to 40 characters.");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
