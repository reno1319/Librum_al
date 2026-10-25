import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSchemaFeatureOffLogForTests } from "./schema-feature-off";

// HOME-PICKS-1: the two slot reads. The public one reads the public view
// with the request client; the staff one checks catalog.feature before it
// creates the service-role client.
class RedirectSignal extends Error {}
type Result = { data: unknown; error: { code?: string; message?: string } | null };
let result: Result;
let calls: { client: string; method: string; args: unknown[] }[];
let adminCreated: number;
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

function client(name: string) {
  return {
    from(table: string) {
      calls.push({ client: name, method: "from", args: [table] });
      const builder: Record<string, unknown> = {
        select: (...args: unknown[]) => (calls.push({ client: name, method: "select", args }), builder),
        order: (...args: unknown[]) => (calls.push({ client: name, method: "order", args }), builder),
        then: (resolve: (v: unknown) => unknown) => resolve(result),
      };
      return builder;
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: () => Promise.resolve(client("request")) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminCreated += 1;
    return client("admin");
  },
}));

const { getPublicHomeSlots, getHomeSlotsForStaff } = await import("./home-picks");

const ROWS = [
  { slot: 1, book_id: "b1", sponsored: true },
  { slot: 2, book_id: "b2", sponsored: false },
];

beforeEach(() => {
  calls = [];
  adminCreated = 0;
  result = { data: ROWS, error: null };
  mockRequireStaff.mockReset();
  mockRequireStaff.mockResolvedValue({ userId: "s1", role: "owner" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetSchemaFeatureOffLogForTests();
  vi.restoreAllMocks();
});

describe("getPublicHomeSlots", () => {
  it("reads slot, book_id and sponsored from the public view with the request client, in slot order", async () => {
    expect(await getPublicHomeSlots()).toEqual(ROWS);
    expect(calls).toEqual([
      { client: "request", method: "from", args: ["public_home_featured_slots"] },
      { client: "request", method: "select", args: ["slot, book_id, sponsored"] },
      { client: "request", method: "order", args: ["slot", { ascending: true }] },
    ]);
    expect(adminCreated).toBe(0);
  });

  it("drops malformed rows", async () => {
    result = { data: [...ROWS, { slot: "3", book_id: "b3", sponsored: false }, { slot: 3, book_id: null }, null], error: null };
    expect(await getPublicHomeSlots()).toEqual(ROWS);
  });

  it.each([
    ["before the migration (feature off)", { code: "PGRST205", message: "missing" }],
    ["any other error", { code: "08006", message: "connection" }],
  ])("%s -> [] (the fan shows the newest books)", async (_label, error) => {
    result = { data: null, error };
    expect(await getPublicHomeSlots()).toEqual([]);
  });
});

describe("getHomeSlotsForStaff", () => {
  it("a caller without catalog.feature is stopped before any service-role client exists", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/"));
    await expect(getHomeSlotsForStaff()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(adminCreated).toBe(0);
  });

  it("reads the table itself with the service-role client (a not-live book's slot too)", async () => {
    expect(await getHomeSlotsForStaff()).toEqual({ ok: true, slots: ROWS });
    expect(calls[0]).toEqual({ client: "admin", method: "from", args: ["home_featured_slots"] });
    expect(calls[1]).toEqual({ client: "admin", method: "select", args: ["slot, book_id, sponsored"] });
  });

  it("feature off -> no slots; any other error -> not ok", async () => {
    result = { data: null, error: { code: "42P01", message: "missing" } };
    expect(await getHomeSlotsForStaff()).toEqual({ ok: true, slots: [] });
    result = { data: null, error: { code: "08006", message: "connection" } };
    expect(await getHomeSlotsForStaff()).toEqual({ ok: false });
  });
});
