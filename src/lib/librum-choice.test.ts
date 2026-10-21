import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSchemaFeatureOffLogForTests } from "./schema-feature-off";

type Result = { data: unknown; error: { code?: string; message?: string } | null };
let result: Result;
let calls: { method: string; args: unknown[] }[];

vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      from(table: string) {
        calls.push({ method: "from", args: [table] });
        const builder: Record<string, (...args: unknown[]) => unknown> = {};
        for (const method of ["select", "eq", "not"]) {
          builder[method] = (...args: unknown[]) => {
            calls.push({ method, args });
            return builder;
          };
        }
        builder.maybeSingle = () => Promise.resolve(result);
        return builder;
      },
    }),
}));

const { getLibrumChoiceBook } = await import("./librum-choice");

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetSchemaFeatureOffLogForTests();
  vi.restoreAllMocks();
});

describe("getLibrumChoiceBook", () => {
  it("asks only for a picked AND published book", async () => {
    result = { data: { id: "b1", status: "published", librum_choice_at: "2026-10-18T08:00:00Z" }, error: null };
    expect(await getLibrumChoiceBook()).toEqual({ id: "b1", status: "published", librum_choice_at: "2026-10-18T08:00:00Z" });
    expect(calls).toEqual([
      { method: "from", args: ["books"] },
      { method: "select", args: ["*, pen:public_pen_names(id, name)"] },
      { method: "not", args: ["librum_choice_at", "is", null] },
      { method: "eq", args: ["status", "published"] },
    ]);
  });

  it("nothing picked (or the pick was unpublished) -> null", async () => {
    result = { data: null, error: null };
    expect(await getLibrumChoiceBook()).toBeNull();
  });

  it.each(["42703", "PGRST204"])("before the migration (%s) -> null, no throw, warned once", async (code) => {
    result = { data: null, error: { code, message: "missing" } };
    expect(await getLibrumChoiceBook()).toBeNull();
    expect(await getLibrumChoiceBook()).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("any other error -> null and logged as an error", async () => {
    result = { data: null, error: { code: "08006", message: "connection" } };
    expect(await getLibrumChoiceBook()).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
