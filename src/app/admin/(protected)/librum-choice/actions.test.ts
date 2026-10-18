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
        if (table !== "books") throw new Error(`unexpected table ${table}`);
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

const { setLibrumChoice, clearLibrumChoice, pickLibrumChoiceFromForm, removeLibrumChoiceFromForm } = await import(
  "./actions"
);

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
