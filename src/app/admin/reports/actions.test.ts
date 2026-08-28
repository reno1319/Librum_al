import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 ADMIN-1A: same mocking convention already established by
// src/app/admin/refunds/actions.test.ts -- requireStaff() is mocked
// directly rather than re-testing decideStaffAccess() itself (already
// covered by src/lib/staff.test.ts). "unauthenticated" and
// "lacks reports.resolve" are exercised here as requireStaff() throwing
// its own redirect (exactly what it does internally for each case),
// proving this action never reaches the RPC when that happens -- not a
// re-test of requireStaff()'s own internal decision.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockRpc = vi.fn();
const mockCreateClient = vi.fn(() => Promise.resolve({ rpc: mockRpc }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { reviewBookReport } = await import("./actions");

describe("reviewBookReport", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRequireStaff.mockReset();
    mockRpc.mockReset();
  });

  it("unauthenticated: requireStaff's own redirect propagates, the RPC is never called", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/login");
    });

    await expect(reviewBookReport("report-1", "resolved", new FormData())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("staff without reports.resolve: requireStaff's own redirect propagates, the RPC is never called", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/");
    });

    await expect(reviewBookReport("report-1", "resolved", new FormData())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.resolve");
  });

  it("staff with reports.resolve, resolves: calls review_book_report with decision 'resolved' and redirects with a success message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({ error: null });

    await expect(reviewBookReport("report-1", "resolved", new FormData())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockRpc).toHaveBeenCalledWith("review_book_report", {
      p_id: "report-1",
      p_decision: "resolved",
      p_admin_notes: null,
    });
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("Report resolved.")),
    );
  });

  it("staff with reports.resolve, dismisses: calls review_book_report with decision 'dismissed' and redirects with a success message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({ error: null });

    await expect(reviewBookReport("report-1", "dismissed", new FormData())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockRpc).toHaveBeenCalledWith("review_book_report", {
      p_id: "report-1",
      p_decision: "dismissed",
      p_admin_notes: null,
    });
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("Report dismissed.")),
    );
  });

  it("passes trimmed admin notes through to the RPC", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({ error: null });
    const formData = new FormData();
    formData.set("adminNotes", "  Checked the listing, looks fine.  ");

    await expect(reviewBookReport("report-1", "dismissed", formData)).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockRpc).toHaveBeenCalledWith("review_book_report", {
      p_id: "report-1",
      p_decision: "dismissed",
      p_admin_notes: "Checked the listing, looks fine.",
    });
  });

  it("already-reviewed conflict: the RPC's own race-safety error maps to a stable, specific message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({ error: { message: "no reviewable report found for this id" } });

    await expect(reviewBookReport("report-1", "resolved", new FormData())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("This report has already been reviewed."),
    );
  });

  it("DB/RPC failure maps to the generic safe message, never raw Postgres text", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({
      error: { message: 'relation "public.book_reports" does not exist' },
    });

    await expect(reviewBookReport("report-1", "resolved", new FormData())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("We couldn't review this report. Please try again."),
    );
    expect(redirectedTo).not.toContain("relation");
  });

  it("RPC 'not authenticated' (defense-in-depth path) redirects to login rather than showing a generic error", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({ error: { message: "not authenticated" } });

    await expect(reviewBookReport("report-1", "resolved", new FormData())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/login"));
  });

  it("rejects admin notes over the 2000-character limit before ever calling the RPC", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    const formData = new FormData();
    formData.set("adminNotes", "x".repeat(2001));

    await expect(reviewBookReport("report-1", "resolved", formData)).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockRpc).not.toHaveBeenCalled();
  });
});
