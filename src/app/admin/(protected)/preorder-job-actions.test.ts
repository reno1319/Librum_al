import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BD16 P3: the owner's "Run the pre-order job now". Owner only (role read
// on the server), never before 08:00 Tirana, then run_preorder_day with
// the service-role client; the result travels as digits only.
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
let role = "owner";
const mockRequireStaff = vi.fn(async (_permission: string) => ({ userId: "staff-1", role }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mockRpc }) }));
vi.mock("server-only", () => ({}));
// BD16 P5: the emails are scheduled with after() once the run is done.
const afterTasks: (() => Promise<unknown>)[] = [];
vi.mock("next/server", () => ({ after: (task: () => Promise<unknown>) => afterTasks.push(task) }));
const mockJobEmails = vi.fn(async (_admin: unknown, _summary: unknown) => ({ released: 0, cancelled: 0 }));
vi.mock("@/lib/preorder-emails", () => ({
  sendPreorderJobEmails: (admin: unknown, summary: unknown) => mockJobEmails(admin, summary),
}));

const { runPreorderJobAsOwner } = await import("./preorder-job-actions");

async function target(): Promise<string> {
  await expect(runPreorderJobAsOwner()).rejects.toBeInstanceOf(RedirectSignal);
  return decodeURIComponent(String(mockRedirect.mock.calls.at(-1)?.[0]));
}

describe("runPreorderJobAsOwner", () => {
  beforeEach(() => {
    role = "owner";
    mockRedirect.mockClear();
    afterTasks.length = 0;
    mockJobEmails.mockClear();
    mockRpc.mockReset().mockResolvedValue({
      data: {
        today: "2026-11-06",
        released_book_ids: ["b1"],
        slipped: [{ book_id: "b2", release_date: "2026-12-06" }],
        cancelled_book_ids: [],
        overdue_book_ids: ["b3", "b4"],
        failed: [],
      },
      error: null,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T09:00:00Z")); // 10:00 Tirana
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("runs for the owner and sends back the counts", async () => {
    expect(await target()).toBe("/admin?preorderRun=1.1.0.2.0");
    expect(mockRpc).toHaveBeenCalledWith("run_preorder_day", { p_today: null });
  });

  it("P5: sends the job's emails after answering, with the run's summary", async () => {
    await target();
    expect(mockJobEmails).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]();
    expect(mockJobEmails).toHaveBeenCalledTimes(1);
    const summary = mockJobEmails.mock.calls[0][1] as { releasedBookIds: string[]; slipped: unknown[] };
    expect(summary.releasedBookIds).toEqual(["b1"]);
    expect(summary.slipped).toEqual([{ bookId: "b2", releaseDate: "2026-12-06" }]);
  });

  it("P5: a failed run still sweeps the readers' emails (summary null)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    await target();
    await afterTasks[0]();
    expect(mockJobEmails).toHaveBeenCalledWith(expect.anything(), null);
  });

  it.each(["admin", "moderator", "editor", "support"])("refuses %s without running", async (r) => {
    role = r;
    expect(await target()).toBe("/admin?error=Only the owner can run the pre-order job.");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(0);
  });

  it("refuses before 08:00 Tirana", async () => {
    vi.setSystemTime(new Date("2026-11-06T06:59:00Z"));
    expect(await target()).toContain("starts at 08:00 Tirana time");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(0);
  });

  it("is refused in maintenance before the staff check", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    mockRequireStaff.mockClear();
    await expect(runPreorderJobAsOwner()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("says when the run failed", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    expect(await target()).toBe("/admin?error=The pre-order run failed. Try again; running it twice changes nothing more.");
  });
});
