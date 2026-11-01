import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readRightsBasisForPages } from "./librum-download-rights";

const BOOK_ID = "9b2e4c1a-7d3f-4e8a-9c5b-1f2e3d4c5b6a";

function fakeAdmin(result: { data: unknown; error: unknown } | Error) {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain = {
    select: (...a: unknown[]) => (calls.push(["select", ...a]), chain),
    eq: (...a: unknown[]) => (calls.push(["eq", ...a]), chain),
    order: (...a: unknown[]) => (calls.push(["order", ...a]), chain),
    limit: (...a: unknown[]) => (calls.push(["limit", ...a]), chain),
    maybeSingle: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
  const from = vi.fn((table: string) => (calls.push(["from", table]), chain));
  return { client: { from } as unknown as SupabaseClient, calls };
}

describe("readRightsBasisForPages (BD3 patch 3)", () => {
  it("reads only the basis column of this one book's newest declaration", async () => {
    const { client, calls } = fakeAdmin({ data: { basis: "public_domain" }, error: null });
    expect(await readRightsBasisForPages(client, BOOK_ID)).toEqual({ ok: true, basis: "public_domain" });
    expect(calls).toEqual([
      ["from", "book_rights_declarations"],
      ["select", "basis"],
      ["eq", "book_id", BOOK_ID],
      ["order", "declared_at", { ascending: false }],
      ["limit", 1],
    ]);
  });

  it("every known basis passes; an unknown value or no row is ok with basis null (the ordinary page)", async () => {
    for (const basis of ["own_rights", "public_domain", "public_domain_original"]) {
      expect(await readRightsBasisForPages(fakeAdmin({ data: { basis }, error: null }).client, BOOK_ID)).toEqual({ ok: true, basis });
    }
    expect(await readRightsBasisForPages(fakeAdmin({ data: { basis: "other" }, error: null }).client, BOOK_ID)).toEqual({ ok: true, basis: null });
    expect(await readRightsBasisForPages(fakeAdmin({ data: null, error: null }).client, BOOK_ID)).toEqual({ ok: true, basis: null });
  });

  it("a failed or thrown read is not ok (the route then adds no pages), and logs nothing itself (audit r1, N3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readRightsBasisForPages(fakeAdmin({ data: null, error: { code: "42501", message: "secret" } }).client, BOOK_ID)).toEqual({ ok: false });
    expect(await readRightsBasisForPages(fakeAdmin(new Error("boom")).client, BOOK_ID)).toEqual({ ok: false });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
