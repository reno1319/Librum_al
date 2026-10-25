import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSchemaFeatureOffLogForTests } from "@/lib/schema-feature-off";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: setLibrumChoice / clearLibrumChoice.
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

// F5: the form wrappers redirect (modelled as a throw, like Next's) and
// read the book's price with the request client.
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => mockRedirect(url) }));
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => mockRevalidatePath(p) }));

type BookRead = { data: unknown; error: { code?: string; message?: string } | null };
let bookRead: BookRead;
let bookReads: { columns: string; filters: [string, unknown][] }[];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      from: (table: string) => {
        if (table !== "public_books") throw new Error(`unexpected table ${table}`);
        const read = { columns: "", filters: [] as [string, unknown][] };
        bookReads.push(read);
        const chain = {
          select: (columns: string) => ((read.columns = columns), chain),
          eq: (column: string, value: unknown) => (read.filters.push([column, value]), chain),
          maybeSingle: () => Promise.resolve(bookRead),
        };
        return chain;
      },
    }),
}));

const {
  setLibrumChoice,
  clearLibrumChoice,
  pickLibrumChoiceFromForm,
  removeLibrumChoiceFromForm,
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
  bookRead = { data: { id: BOOK, price_all: 199 }, error: null };
  bookReads = [];
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

describe("setLibrumChoice", () => {
  it("requires catalog.feature, then calls set_librum_choice with the service role", async () => {
    rpcResults.set_librum_choice = { data: true, error: null };
    expect(await setLibrumChoice(BOOK)).toEqual({ ok: true });
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(rpcCalls).toEqual([{ name: "set_librum_choice", params: { p_book_id: BOOK } }]);
  });

  it("a caller without catalog.feature is stopped before any service-role client exists", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/"));
    await expect(setLibrumChoice(BOOK)).rejects.toBeInstanceOf(RedirectSignal);
    expect(adminCreated).toBe(0);
    expect(rpcCalls).toEqual([]);
  });

  it("false (missing or unpublished book) -> clean refusal", async () => {
    rpcResults.set_librum_choice = { data: false, error: null };
    expect(await setLibrumChoice(BOOK)).toEqual({ ok: false, reason: "not_published" });
  });

  it("a 23505 from a race -> the same clean refusal", async () => {
    rpcResults.set_librum_choice = { data: null, error: { code: "23505", message: "books_one_librum_choice" } };
    expect(await setLibrumChoice(BOOK)).toEqual({ ok: false, reason: "not_published" });
  });

  it("not a uuid -> refused without calling the database", async () => {
    expect(await setLibrumChoice("not-a-uuid")).toEqual({ ok: false, reason: "not_published" });
    expect(rpcCalls).toEqual([]);
  });

  it.each(["42883", "PGRST202"])("before the migration (%s) -> feature_off, no throw", async (code) => {
    rpcResults.set_librum_choice = { data: null, error: { code, message: "missing" } };
    expect(await setLibrumChoice(BOOK)).toEqual({ ok: false, reason: "feature_off" });
  });

  it("any other error -> error", async () => {
    rpcResults.set_librum_choice = { data: null, error: { code: "42501", message: "denied" } };
    expect(await setLibrumChoice(BOOK)).toEqual({ ok: false, reason: "error" });
  });
});

describe("clearLibrumChoice", () => {
  it("requires catalog.feature, then calls clear_librum_choice", async () => {
    expect(await clearLibrumChoice()).toEqual({ ok: true });
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(rpcCalls).toEqual([{ name: "clear_librum_choice", params: undefined }]);
  });

  it("a caller without catalog.feature is stopped before any service-role client exists", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/"));
    await expect(clearLibrumChoice()).rejects.toBeInstanceOf(RedirectSignal);
    expect(adminCreated).toBe(0);
  });

  it.each(["42883", "PGRST202"])("before the migration (%s) -> feature_off", async (code) => {
    rpcResults.clear_librum_choice = { data: null, error: { code, message: "missing" } };
    expect(await clearLibrumChoice()).toEqual({ ok: false, reason: "feature_off" });
  });

  it("any other error -> error", async () => {
    rpcResults.clear_librum_choice = { data: null, error: { code: "08006", message: "connection" } };
    expect(await clearLibrumChoice()).toEqual({ ok: false, reason: "error" });
  });
});

// ============================================================
// F5 (C1): the admin page's form wrappers.
// ============================================================
function pickForm(bookId: string | null = BOOK): FormData {
  const fd = new FormData();
  if (typeof bookId === "string") fd.set("bookId", bookId);
  return fd;
}

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
const CANT = `/admin/librum-choice?error=${encodeURIComponent("That book can't be picked.")}`;
const WRONG = `/admin/librum-choice?error=${encodeURIComponent("Something went wrong. Please try again.")}`;

describe("pickLibrumChoiceFromForm", () => {
  it("requireStaff rejecting -> rejects with 0 book reads and no service-role client", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/"));
    await expect(pickLibrumChoiceFromForm(pickForm())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(bookReads).toEqual([]);
    expect(adminCreated).toBe(0);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("a priced published book: reads its price with the request client, picks it, revalidates, Saved.", async () => {
    rpcResults.set_librum_choice = { data: true, error: null };
    expect(await redirectOf(pickLibrumChoiceFromForm(pickForm()))).toBe(SAVED);
    expect(bookReads).toEqual([{ columns: "id, price_all", filters: [["id", BOOK]] }]);
    expect(rpcCalls).toEqual([{ name: "set_librum_choice", params: { p_book_id: BOOK } }]);
    expect(mockRevalidatePath.mock.calls.map((c) => c[0])).toEqual(["/", "/bookstore", "/admin/librum-choice"]);
  });

  it("a free book (0) counts as priced", async () => {
    bookRead = { data: { id: BOOK, price_all: 0 }, error: null };
    rpcResults.set_librum_choice = { data: true, error: null };
    expect(await redirectOf(pickLibrumChoiceFromForm(pickForm()))).toBe(SAVED);
  });

  it.each([
    ["an unpriced book", { data: { id: BOOK, price_all: null }, error: null }],
    ["a book not found (draft or missing)", { data: null, error: null }],
  ])("%s is refused before set_librum_choice", async (_label, read) => {
    bookRead = read;
    expect(await redirectOf(pickLibrumChoiceFromForm(pickForm()))).toBe(CANT);
    expect(adminCreated).toBe(0);
    expect(rpcCalls).toEqual([]);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it.each([[null], ["not-a-uuid"]])("a missing or malformed id (%s) is refused without any read", async (id) => {
    expect(await redirectOf(pickLibrumChoiceFromForm(pickForm(id)))).toBe(CANT);
    expect(bookReads).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("a failed price read -> Something went wrong, nothing picked", async () => {
    bookRead = { data: null, error: { code: "08006", message: "connection" } };
    expect(await redirectOf(pickLibrumChoiceFromForm(pickForm()))).toBe(WRONG);
    expect(rpcCalls).toEqual([]);
  });

  it("not_published from the database -> That book can't be picked.", async () => {
    rpcResults.set_librum_choice = { data: false, error: null };
    expect(await redirectOf(pickLibrumChoiceFromForm(pickForm()))).toBe(CANT);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["feature_off", { data: null, error: { code: "42883", message: "missing" } }],
    ["error", { data: null, error: { code: "42501", message: "denied" } }],
  ])("%s -> Something went wrong", async (_label, result) => {
    rpcResults.set_librum_choice = result;
    expect(await redirectOf(pickLibrumChoiceFromForm(pickForm()))).toBe(WRONG);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("removeLibrumChoiceFromForm", () => {
  it("requireStaff rejecting -> rejects with no service-role client", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/"));
    await expect(removeLibrumChoiceFromForm()).rejects.toBeInstanceOf(RedirectSignal);
    expect(adminCreated).toBe(0);
    expect(rpcCalls).toEqual([]);
  });

  // LEFTOVERS (L5b): the wrapper's OWN gate. Its first requireStaff call
  // passes and the second (clearLibrumChoice's) refuses, so nothing is
  // cleared. This fails if the wrapper's gate is removed or moved after
  // the clear, since clearLibrumChoice's gate would then be the one that
  // passes.
  it("its own gate runs first: second requireStaff refusing -> nothing cleared", async () => {
    mockRequireStaff
      .mockResolvedValueOnce({ userId: "s1", role: "admin" })
      .mockRejectedValueOnce(new RedirectSignal("/"));
    await expect(removeLibrumChoiceFromForm()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff.mock.calls).toEqual([["catalog.feature"], ["catalog.feature"]]);
    expect(rpcCalls).toEqual([]);
    expect(adminCreated).toBe(0);
  });

  it("clears the pick, revalidates, Saved.", async () => {
    expect(await redirectOf(removeLibrumChoiceFromForm())).toBe(SAVED);
    expect(mockRequireStaff.mock.calls).toEqual([["catalog.feature"], ["catalog.feature"]]);
    expect(rpcCalls).toEqual([{ name: "clear_librum_choice", params: undefined }]);
    expect(mockRevalidatePath.mock.calls.map((c) => c[0])).toEqual(["/", "/bookstore", "/admin/librum-choice"]);
  });

  it.each([
    ["feature_off", { data: null, error: { code: "PGRST202", message: "missing" } }],
    ["error", { data: null, error: { code: "08006", message: "connection" } }],
  ])("%s -> Something went wrong", async (_label, result) => {
    rpcResults.clear_librum_choice = result;
    expect(await redirectOf(removeLibrumChoiceFromForm())).toBe(WRONG);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

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
    expect(mockRevalidatePath.mock.calls.map((c) => c[0])).toEqual(["/", "/bookstore", "/admin/librum-choice"]);
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
    expect(mockRevalidatePath.mock.calls.map((c) => c[0])).toEqual(["/", "/bookstore", "/admin/librum-choice"]);
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
