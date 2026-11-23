import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { readAuthorPaymentDetailsReadinessAsStaff, readPaymentDetailsReadiness, readOwnPaymentDetailsState } =
  await import("./author-tax-readiness");

// BUILD 3: only yes/no ever comes back; failures fail closed.
describe("payment details readiness", () => {
  const client = (result: { data: unknown; error: unknown }) =>
    ({ rpc: vi.fn(async () => result) }) as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> };

  it("the author asks author_payment_details_ready_self, with no author id", async () => {
    const c = client({ data: true, error: null });
    expect(await readPaymentDetailsReadiness(c)).toBe("ready");
    expect(c.rpc).toHaveBeenCalledWith("author_payment_details_ready_self");
  });

  it("staff ask author_payment_details_ready_for about the book's author", async () => {
    const c = client({ data: true, error: null });
    expect(await readAuthorPaymentDetailsReadinessAsStaff(c, "a1")).toBe("ready");
    expect(c.rpc).toHaveBeenCalledWith("author_payment_details_ready_for", { p_author_id: "a1" });
  });

  it("false is missing; an error or a non-boolean is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const read of [
      (c: SupabaseClient) => readPaymentDetailsReadiness(c),
      (c: SupabaseClient) => readAuthorPaymentDetailsReadinessAsStaff(c, "a1"),
    ]) {
      expect(await read(client({ data: false, error: null }))).toBe("missing");
      expect(await read(client({ data: null, error: { code: "42501" } }))).toBe("unavailable");
      expect(await read(client({ data: "yes", error: null }))).toBe("unavailable");
    }
  });
});

describe("readOwnPaymentDetailsState", () => {
  function client(tax: { data: unknown; error: unknown }, bank: { data: unknown; error: unknown }) {
    const selected: string[] = [];
    const from = (table: string) => ({
      select: (cols: string) => {
        selected.push(`${table}:${cols}`);
        const chain = {
          eq: () => chain,
          maybeSingle: async () => (table === "author_tax_details" ? tax : bank),
        };
        return chain;
      },
    });
    return { c: { from } as unknown as SupabaseClient, selected };
  }

  it("reads only the author_id column of each part", async () => {
    const { c, selected } = client({ data: { author_id: "a1" }, error: null }, { data: null, error: null });
    expect(await readOwnPaymentDetailsState(c, "a1")).toEqual({ ok: true, hasTaxDetails: true, hasBankAccount: false });
    expect(selected).toEqual(["author_tax_details:author_id", "author_payout_destinations:author_id"]);
  });

  it("a read error is not ok", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { c } = client({ data: null, error: { code: "x" } }, { data: null, error: null });
    expect(await readOwnPaymentDetailsState(c, "a1")).toEqual({ ok: false });
  });
});
