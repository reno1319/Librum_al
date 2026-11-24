import { beforeEach, describe, expect, it, vi } from "vitest";

// G4 (g4q5 a, g4q6 a, g4e2 a): "Send again" and "Mark handled" on a failed
// pre-order email. people.view first, ids checked, the database function
// with the request client; false means already handled; only "Send
// again" runs the sweep.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => mockRevalidate(p) }));
const mockRequireStaff = vi.fn(async (_permission: string) => ({ userId: "staff-1", role: "admin" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mockRpc }) }));
const mockSchedule = vi.fn();
vi.mock("@/lib/preorder-emails", () => ({
  scheduleWaitingReaderEmails: (label: string) => mockSchedule(label),
}));

const { sendFailedPreorderEmailAgain, markFailedPreorderEmailHandled } = await import(
  "./failed-preorder-email-actions"
);
const { FAILED_EMAIL_ERROR_MESSAGE, FAILED_EMAIL_GONE_MESSAGE } = await import("@/lib/preorder-email-failures");

const BOOK = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function form(bookId: string | null = BOOK, userId: string | null = USER): FormData {
  const f = new FormData();
  if (bookId !== null) f.set("book_id", bookId);
  if (userId !== null) f.set("user_id", userId);
  return f;
}

async function target(run: Promise<void>): Promise<string> {
  await expect(run).rejects.toBeInstanceOf(RedirectSignal);
  return decodeURIComponent(String(mockRedirect.mock.calls.at(-1)?.[0]));
}

describe("failed pre-order email actions", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRevalidate.mockClear();
    mockSchedule.mockClear();
    mockRequireStaff.mockReset().mockResolvedValue({ userId: "staff-1", role: "admin" });
    mockRpc.mockReset().mockResolvedValue({ data: true, error: null });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("Send again: people.view, the resend function, then the sweep", async () => {
    expect(await target(sendFailedPreorderEmailAgain(form()))).toBe("/admin");
    expect(mockRequireStaff).toHaveBeenCalledWith("people.view");
    expect(mockRpc).toHaveBeenCalledWith("staff_resend_preorder_email", { p_book_id: BOOK, p_user_id: USER });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockRevalidate).toHaveBeenCalledWith("/admin");
  });

  it("Mark handled: the handled function and no sweep", async () => {
    expect(await target(markFailedPreorderEmailHandled(form()))).toBe("/admin");
    expect(mockRpc).toHaveBeenCalledWith("staff_mark_preorder_email_handled", { p_book_id: BOOK, p_user_id: USER });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it("stops when the staff check refuses, before any database call", async () => {
    mockRequireStaff.mockRejectedValueOnce(new RedirectSignal("/admin/login"));
    await expect(sendFailedPreorderEmailAgain(form())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ["a bad book id", form("not-a-uuid")],
    ["a missing user id", form(BOOK, null)],
  ])("refuses %s without calling the database", async (_label, f) => {
    expect(await target(markFailedPreorderEmailHandled(f))).toBe(`/admin?error=${FAILED_EMAIL_ERROR_MESSAGE}`);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("shows the error line when the database call fails, and no sweep", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "not authorized" } });
    expect(await target(sendFailedPreorderEmailAgain(form()))).toBe(`/admin?error=${FAILED_EMAIL_ERROR_MESSAGE}`);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it("false means already handled: the gone line, no sweep", async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await target(sendFailedPreorderEmailAgain(form()))).toBe(`/admin?error=${FAILED_EMAIL_GONE_MESSAGE}`);
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});
