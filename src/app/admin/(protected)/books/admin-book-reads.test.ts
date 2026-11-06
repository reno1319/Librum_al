import { beforeEach, describe, expect, it, vi } from "vitest";

// BD16 P3 (D9): Today's waiting reviews: each pre-order item classified
// against Tirana today, the urgent ones first, `limit` items at most.
vi.mock("server-only", () => ({}));
let reviews: unknown[] = [];
let books: unknown[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const result =
        table === "book_reviews"
          ? { data: reviews, error: null, count: reviews.length }
          : { data: books, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        returns: () => Promise.resolve(result),
      };
      return chain;
    },
  }),
}));

const { readPendingReviewsForStaff } = await import("./admin-book-reads");

const review = (id: string, submitted: string, file: string | null, release: string | null) => ({
  id,
  book_id: `book-${id}`,
  book_title: `T${id}`,
  submitted_at: submitted,
  file_path: file,
  release_date: release,
});
const book = (id: string, status: string, file: string | null, release: string | null) => ({
  id: `book-${id}`,
  status,
  file_path: file,
  release_date: release,
  pen: { name: "P" },
});

describe("readPendingReviewsForStaff", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("classifies and puts overdue first, then final files and too-late listings, then the rest", async () => {
    reviews = [
      review("plain", "2026-11-01T08:00:00Z", "f", null),
      review("listing", "2026-11-02T08:00:00Z", null, "2026-12-30"),
      review("late", "2026-11-03T08:00:00Z", null, "2026-11-22"),
      review("file", "2026-11-04T08:00:00Z", "f", null),
      review("over", "2026-11-05T08:00:00Z", "f", null),
      review("change", "2026-11-06T08:00:00Z", null, null),
    ];
    books = [
      book("plain", "draft", "f", null),
      book("listing", "draft", null, "2026-12-30"),
      book("late", "draft", null, "2026-11-22"),
      book("file", "preorder", null, "2026-12-01"),
      book("over", "preorder", null, "2026-11-20"),
      book("change", "preorder", null, "2026-12-01"),
    ];
    const result = await readPendingReviewsForStaff(10);
    expect(result?.overdue).toBe(1);
    expect(result?.total).toBe(6);
    expect(result?.items.map((i) => [i.reviewId, i.preorder?.state ?? null])).toEqual([
      ["over", "overdue"],
      ["late", "listing_too_late"],
      ["file", "final_file"],
      ["plain", null],
      ["listing", "listing"],
      ["change", null],
    ]);
    expect((await readPendingReviewsForStaff(2))?.items.map((i) => i.reviewId)).toEqual(["over", "late"]);
  });
});
