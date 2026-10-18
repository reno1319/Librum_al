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

const { setLibrumChoice, clearLibrumChoice } = await import("./actions");

const BOOK = "b0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  rpcResults = {};
  rpcCalls = [];
  adminCreated = 0;
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
