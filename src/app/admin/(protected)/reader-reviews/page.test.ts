import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// BD13: the reader review queue renders each waiting review with the
// fake-review signals (5a), Approve, and Reject with the fixed reasons
// (Q6a), behind requireStaff("reports.resolve") (Q3a).
const mockRequireStaff = vi.fn((_permission: string) => Promise.resolve({ userId: "staff-1", role: "moderator" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

let rpcResult: { data: unknown; error: unknown } = { data: [], error: null };
const rpcCalls: string[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      rpc: (name: string) => {
        rpcCalls.push(name);
        return Promise.resolve(rpcResult);
      },
    }),
}));
vi.mock("./actions", () => ({ approveReaderReviewAsStaff: vi.fn(), rejectReaderReviewAsStaff: vi.fn() }));

const { default: Page } = await import("./page");

async function render(search: Record<string, string> = {}): Promise<string> {
  const element = await Page({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(element as ReactElement);
}

const row = {
  review_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  book_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  book_title: "Deti",
  reader_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  rating: 2,
  body: "Nuk më pëlqeu fundi.",
  review_name: "Lexuesi",
  updated_at: "2026-11-02T10:00:00.123456+00:00",
  account_created_at: new Date().toISOString(),
  email_confirmed: false,
  reviews_total: 1,
  reviews_approved: 0,
  verified: false,
  reviewer_is_author: false,
};

beforeEach(() => {
  mockRequireStaff.mockClear();
  rpcCalls.length = 0;
  rpcResult = { data: [], error: null };
});

describe("/admin/reader-reviews", () => {
  it("gates on reports.resolve and says when nothing waits", async () => {
    const html = await render();
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.resolve");
    expect(rpcCalls).toEqual(["staff_list_pending_reader_reviews"]);
    expect(html).toContain("No reviews waiting.");
    expect(html).toContain("Never reject a review for being negative");
  });

  it("shows the review, the signals, the seen timestamp and every reason", async () => {
    rpcResult = { data: [row], error: null };
    const html = await render();
    expect(html).toContain("Deti");
    expect(html).toContain("Nuk më pëlqeu fundi.");
    expect(html).toContain("Lexuesi");
    expect(html).toContain("Account created today");
    expect(html).toContain("Email NOT confirmed");
    expect(html).toContain("1 review in all, 0 approved");
    expect(html).toContain("Free or 100% discount (no badge)");
    expect(html).toContain(`value="${row.updated_at}"`);
    for (const reason of ["abusive", "personal_data", "off_topic", "advertising", "bad_name", "other"]) {
      expect(html).toContain(`value="${reason}"`);
    }
    expect(html).not.toContain("negative</option>");
  });

  it("shows no Approve or Reject on the staff member's own review (audit r1 S3)", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: row.reader_id, role: "moderator" });
    rpcResult = { data: [row], error: null };
    const html = await render();
    expect(html).toContain("This is your own review. Another staff member approves or rejects it.");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Reject<");
  });

  it("shows an error, not an empty queue, when the list fails", async () => {
    rpcResult = { data: null, error: { code: "42501" } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render();
    expect(html).toContain("Couldn&#x27;t load the reviews.");
    expect(html).not.toContain("No reviews waiting.");
  });

  it("shows only allowlisted messages", async () => {
    expect(await render({ success: "Review approved." })).toContain("Review approved.");
    expect(await render({ success: "pwned" })).not.toContain("pwned");
  });
});
