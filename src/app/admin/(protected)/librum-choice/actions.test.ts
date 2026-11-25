import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSchemaFeatureOffLogForTests } from "@/lib/schema-feature-off";

// HOME-PICKS-1: the home page cover slot actions. (LR1 patch 3 removed
// the Librum's choice actions and their tests.)
// requireStaff is mocked (same convention as blog/actions.test.ts); a
// refusal is modelled as the redirect it really throws.
class RedirectSignal extends Error {}
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
let rpcResults: Record<string, RpcResult>;
let rpcCalls: { name: string; params: unknown }[];
let adminCreated: number;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminCreated += 1;
    return {
      rpc: (name: string, params?: unknown) => {
        rpcCalls.push({ name, params });
        return Promise.resolve(rpcResults[name] ?? { data: null, error: null });
      },
    };
  },
}));

// The form wrappers redirect (modelled as a throw, like Next's).
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => mockRedirect(url) }));
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => mockRevalidatePath(p) }));

const {
  setHomeSlot,
  clearHomeSlot,
  setHomeSlotFromForm,
  removeHomeSlotFromForm,
} = await import("./actions");

const BOOK = "b0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  rpcResults = {};
  rpcCalls = [];
  adminCreated = 0;
  mockRedirect.mockClear();
  mockRevalidatePath.mockClear();
  mockRequireStaff.mockReset();
  mockRequireStaff.mockResolvedValue({ userId: "s1", role: "admin" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetSchemaFeatureOffLogForTests();
  vi.restoreAllMocks();
});

// ============================================================
// The admin page's form wrappers.
// ============================================================
async function redirectOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.message;
    throw error;
  }
  return "<no redirect>";
}

const SAVED = "/admin/librum-choice?success=Saved.";
const WRONG = `/admin/librum-choice?error=${encodeURIComponent("Something went wrong. Please try again.")}`;

// HOME-PICKS-1: the three home page cover slots.
describe("setHomeSlot / clearHomeSlot", () => {
  it("requires catalog.feature, then calls set_home_featured_slot with the staff id as set_by", async () => {
    rpcResults.set_home_featured_slot = { data: "ok", error: null };
    expect(await setHomeSlot(2, BOOK, true)).toEqual({ ok: true });
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(rpcCalls).toEqual([
      { name: "set_home_featured_slot", params: { p_slot: 2, p_book_id: BOOK, p_sponsored: true, p_set_by: "s1" } },
    ]);
  });

  it("a caller without catalog.feature is stopped before any service-role client exists", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/"));
    await expect(setHomeSlot(1, BOOK, false)).rejects.toBeInstanceOf(RedirectSignal);
    await expect(clearHomeSlot(1)).rejects.toBeInstanceOf(RedirectSignal);
    expect(adminCreated).toBe(0);
  });

  it.each([
    ["not_eligible", { ok: false, reason: "not_eligible" }],
    ["in_slot_3", { ok: false, reason: "in_other_slot", slot: 3 }],
    ["in_slot_9", { ok: false, reason: "error" }],
    ["something else", { ok: false, reason: "error" }],
  ])("the database answering %s", async (answer, expected) => {
    rpcResults.set_home_featured_slot = { data: answer, error: null };
    expect(await setHomeSlot(1, BOOK, false)).toEqual(expected);
  });

  it.each([
    ["feature_off", { code: "42883", message: "missing" }, { ok: false, reason: "feature_off" }],
    ["a unique violation", { code: "23505", message: "dup" }, { ok: false, reason: "error" }],
    ["any other error", { code: "08006", message: "connection" }, { ok: false, reason: "error" }],
  ])("%s", async (_label, error, expected) => {
    rpcResults.set_home_featured_slot = { data: null, error };
    expect(await setHomeSlot(1, BOOK, false)).toEqual(expected);
  });

  it("a malformed book id or slot never reaches the database", async () => {
    expect(await setHomeSlot(1, "not-a-uuid", false)).toEqual({ ok: false, reason: "not_eligible" });
    expect(await setHomeSlot(4 as 1, BOOK, false)).toEqual({ ok: false, reason: "not_eligible" });
    expect(await clearHomeSlot(0 as 1)).toEqual({ ok: false, reason: "error" });
    expect(rpcCalls).toEqual([]);
  });

  it("clearHomeSlot calls clear_home_featured_slot with the slot", async () => {
    expect(await clearHomeSlot(3)).toEqual({ ok: true });
    expect(rpcCalls).toEqual([{ name: "clear_home_featured_slot", params: { p_slot: 3 } }]);
  });
});

function slotForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const CANT_HOME = `/admin/librum-choice?error=${encodeURIComponent("That book can't go on the home page.")}`;

describe("setHomeSlotFromForm", () => {
  it("its own gate runs first: requireStaff rejecting -> no client, no call", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/"));
    await expect(setHomeSlotFromForm(slotForm({ slot: "1", bookId: BOOK }))).rejects.toBeInstanceOf(RedirectSignal);
    expect(adminCreated).toBe(0);
    expect(rpcCalls).toEqual([]);
  });

  it("Paid ticked -> sponsored true; revalidates the home page; Saved.", async () => {
    rpcResults.set_home_featured_slot = { data: "ok", error: null };
    expect(await redirectOf(setHomeSlotFromForm(slotForm({ slot: "1", bookId: BOOK, sponsored: "on" })))).toBe(SAVED);
    expect(rpcCalls[0].params).toMatchObject({ p_slot: 1, p_book_id: BOOK, p_sponsored: true });
    expect(mockRevalidatePath.mock.calls.map((c) => c[0])).toEqual(["/", "/librari", "/admin/librum-choice"]);
  });

  it("Paid not ticked (absent from the form) -> sponsored false", async () => {
    rpcResults.set_home_featured_slot = { data: "ok", error: null };
    await redirectOf(setHomeSlotFromForm(slotForm({ slot: "3", bookId: BOOK })));
    expect(rpcCalls[0].params).toMatchObject({ p_slot: 3, p_sponsored: false });
  });

  it("not_eligible -> That book can't go on the home page.", async () => {
    rpcResults.set_home_featured_slot = { data: "not_eligible", error: null };
    expect(await redirectOf(setHomeSlotFromForm(slotForm({ slot: "1", bookId: BOOK })))).toBe(CANT_HOME);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("a book already in slot 2 -> That book is already in slot 2.", async () => {
    rpcResults.set_home_featured_slot = { data: "in_slot_2", error: null };
    expect(await redirectOf(setHomeSlotFromForm(slotForm({ slot: "1", bookId: BOOK })))).toBe(
      `/admin/librum-choice?error=${encodeURIComponent("That book is already in slot 2.")}`,
    );
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [{ slot: "4", bookId: BOOK }],
    [{ slot: "1", bookId: "nope" }],
    [{ bookId: BOOK }],
    [{ slot: "1" }],
  ])("a bad form (%o) is refused without a call", async (fields) => {
    expect(await redirectOf(setHomeSlotFromForm(slotForm(fields)))).toBe(CANT_HOME);
    expect(rpcCalls).toEqual([]);
  });

  it("a database error -> Something went wrong", async () => {
    rpcResults.set_home_featured_slot = { data: null, error: { code: "08006", message: "connection" } };
    expect(await redirectOf(setHomeSlotFromForm(slotForm({ slot: "1", bookId: BOOK })))).toBe(WRONG);
  });
});

describe("removeHomeSlotFromForm", () => {
  it("its own gate runs first: second requireStaff refusing -> nothing cleared", async () => {
    mockRequireStaff
      .mockResolvedValueOnce({ userId: "s1", role: "admin" })
      .mockRejectedValueOnce(new RedirectSignal("/"));
    await expect(removeHomeSlotFromForm(slotForm({ slot: "2" }))).rejects.toBeInstanceOf(RedirectSignal);
    expect(rpcCalls).toEqual([]);
    expect(adminCreated).toBe(0);
  });

  it("clears the slot, revalidates, Saved.", async () => {
    expect(await redirectOf(removeHomeSlotFromForm(slotForm({ slot: "2" })))).toBe(SAVED);
    expect(rpcCalls).toEqual([{ name: "clear_home_featured_slot", params: { p_slot: 2 } }]);
    expect(mockRevalidatePath.mock.calls.map((c) => c[0])).toEqual(["/", "/librari", "/admin/librum-choice"]);
  });

  it("a bad slot -> Something went wrong, no call", async () => {
    expect(await redirectOf(removeHomeSlotFromForm(slotForm({ slot: "x" })))).toBe(WRONG);
    expect(rpcCalls).toEqual([]);
  });

  it("feature off -> Something went wrong, nothing revalidated", async () => {
    rpcResults.clear_home_featured_slot = { data: null, error: { code: "PGRST202", message: "missing" } };
    expect(await redirectOf(removeHomeSlotFromForm(slotForm({ slot: "1" })))).toBe(WRONG);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
