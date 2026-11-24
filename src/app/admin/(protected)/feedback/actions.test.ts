import { beforeEach, describe, expect, it, vi } from "vitest";

// G4 batch 3 (g4q11 a, b3e1 a): "Mark selected done" on Feedback.
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

const { markSelectedFeedbackDone } = await import("./actions");

const F1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const F2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const F3 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function picks(values: string[], status?: string): FormData {
  const fd = new FormData();
  for (const v of values) fd.append("pick", v);
  if (status) fd.set("status", status);
  return fd;
}

async function target(run: Promise<void>): Promise<string | null> {
  try {
    await run;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("markSelectedFeedbackDone", () => {
  it("marks each ticked message done, counts the ones that fail, and returns to the same filter", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "XX000" } });
    const to = await target(markSelectedFeedbackDone(picks([F1, F2, F3], "all")));
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.resolve");
    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockRpc).toHaveBeenNthCalledWith(1, "staff_set_reader_feedback_done", { p_id: F1, p_done: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin");
    expect(to).toBe("/admin/feedback?status=all&bulk=1.1.1");
  });

  it("goes back to Open by default", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    expect(await target(markSelectedFeedbackDone(picks([F1], "evil")))).toBe("/admin/feedback?bulk=1.0.0");
  });

  it("calls nothing for an empty or malformed form", async () => {
    expect(await target(markSelectedFeedbackDone(picks([])))).toBeNull();
    expect(await target(markSelectedFeedbackDone(picks(["x"])))).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
