import { describe, expect, it, vi } from "vitest";

// POK-FULFILMENT-1: executable coverage for the REAL repository.
//
// Why this file exists. The bound on the 503 retry loop is computed from
// two database timestamps that only one statement in the application ever
// reads: the compare-and-set inside recordFulfilmentObservation. The SQL
// suite (supabase/tests/059) asserts that statement's invariants against a
// real database -- but it does so against a hand-written SQL MIRROR of the
// query, so it proves the database behaves correctly when asked the right
// question. It cannot prove that the TypeScript asks it. Nothing else in
// this repository executes pok-repository.ts at all; pok-checkout.test.ts
// runs against a mock of this module, which can only ever assert what the
// mock was told to say.
//
// So the boundary mocked here is the LAST one before the network:
// @/lib/supabase/admin. createPokRepository() itself, and every predicate,
// payload and projection it builds, is the real implementation under test.
//
// The double is a recorder rather than an in-memory database on purpose.
// What must be established is the exact query that leaves the process --
// predicates included -- and an in-memory fake would silently pass a query
// missing a WHERE clause as long as its own table happened to hold one row.

type ObservationRow = { fulfilment_gap_first_seen_at: string | null; updated_at: string };
type Call = { method: string; args: unknown[] };

// Deliberately DISTINCT hypothetical rows. The production method must
// return what the database reported AFTER the write; a pre-write read, or
// a returned stale row, resolves to PRE_WRITE here and fails the equality
// rather than passing by accident because both rows looked alike.
const PRE_WRITE: ObservationRow = {
  fulfilment_gap_first_seen_at: null,
  updated_at: "2026-09-20T09:00:00.000Z",
};
const POST_WRITE: ObservationRow = {
  fulfilment_gap_first_seen_at: "2026-09-20T09:41:00.000Z",
  updated_at: "2026-09-20T09:41:00.000Z",
};

const CHAIN_METHODS = ["update", "select", "eq", "in", "not", "is", "order", "limit"] as const;

function fakeAdmin(outcome: { rows?: "one" | "none"; error?: { message: string } } = {}) {
  const calls: Call[] = [];
  function builder() {
    // Whether THIS chain wrote is what decides which row it can see, so a
    // read-only chain (a pre-read) is answered with the pre-write row.
    let wrote = false;
    const chain: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        if (method === "update") wrote = true;
        return chain;
      };
    }
    const terminal = async (method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      if (outcome.error) return { data: null, error: outcome.error };
      if (outcome.rows === "none") return { data: null, error: null };
      return { data: wrote ? POST_WRITE : PRE_WRITE, error: null };
    };
    chain.maybeSingle = (...args: unknown[]) => terminal("maybeSingle", ...args);
    chain.single = (...args: unknown[]) => terminal("single", ...args);
    return chain;
  }
  const db = {
    from: (table: string) => { calls.push({ method: "from", args: [table] }); return builder(); },
    rpc: (...args: unknown[]) => { calls.push({ method: "rpc", args }); return Promise.resolve({ data: null, error: null }); },
  };
  return { db, calls };
}

let current = fakeAdmin();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => current.db }));

import { createPokRepository } from "./pok-repository";

const intentId = "11111111-1111-4111-8111-111111111111";
const gapCode = "fulfilment_gap_transaction_id_absent";

// The whole production statement, in order. Asserted as one value rather
// than as a pile of "was it called with" checks: a dropped predicate, an
// extra query, a pre-read, a widened projection and a reordered terminal
// are all the same failure here, and none of them can hide behind a
// partial assertion that happens not to look at the clause that changed.
const EXPECTED_CHAIN: Call[] = [
  { method: "from", args: ["pok_book_checkout_orders"] },
  { method: "update", args: [{ state: "needs_reconciliation", last_error_code: gapCode }] },
  { method: "eq", args: ["intent_id", intentId] },
  { method: "not", args: ["provider_order_id", "is", null] },
  { method: "in", args: ["state", ["ready", "needs_reconciliation"]] },
  { method: "select", args: ["fulfilment_gap_first_seen_at,updated_at"] },
  { method: "maybeSingle", args: [] },
];

function observe(outcome: Parameters<typeof fakeAdmin>[0] = {}) {
  current = fakeAdmin(outcome);
  return { result: createPokRepository().recordFulfilmentObservation(intentId, gapCode), calls: current.calls };
}

describe("POK-FULFILMENT-1: recordFulfilmentObservation, the real query", () => {
  it("issues exactly the production compare-and-set, in order, and nothing else", async () => {
    const { result, calls } = observe();
    await result;
    expect(calls).toEqual(EXPECTED_CHAIN);
  });

  it("scopes the write to this intent", async () => {
    const { result, calls } = observe();
    await result;
    expect(calls).toContainEqual({ method: "eq", args: ["intent_id", intentId] });
    // One equality on the primary key, never a looser match that could
    // reach a second mapping.
    expect(calls.filter(c => c.method === "eq")).toHaveLength(1);
  });

  it("requires a recorded provider order id", async () => {
    const { result, calls } = observe();
    await result;
    // A mapping with no order id has no provider attempt to ask about, and
    // flagging it would retire nothing and bound nothing.
    expect(calls).toContainEqual({ method: "not", args: ["provider_order_id", "is", null] });
  });

  it("admits exactly ready and needs_reconciliation, excluding creating and retired", async () => {
    const { result, calls } = observe();
    await result;
    const states = calls.find(c => c.method === "in")?.args[1] as string[];
    // Exact, not "contains": 'creating' would let a diagnostic write land
    // between repo.recordProviderOrder and repo.ready and cost the reader
    // the checkout URL, and 'retired' would flag an attempt whose death is
    // already final. Order is asserted too, so the predicate cannot drift.
    expect(states).toEqual(["ready", "needs_reconciliation"]);
    expect(states).not.toContain("creating");
    expect(states).not.toContain("retired");
  });

  it("writes only the state and the error code", async () => {
    const { result, calls } = observe();
    await result;
    const payload = calls.find(c => c.method === "update")?.args[0] as Record<string, unknown>;
    // fulfilment_gap_first_seen_at is DATABASE-OWNED: the trigger raises
    // on any statement that supplies it, so a payload that grew a third
    // key would not merely be untidy, it could start failing in production.
    expect(Object.keys(payload).sort()).toEqual(["last_error_code", "state"]);
    expect(payload).toEqual({ state: "needs_reconciliation", last_error_code: gapCode });
  });

  it("selects exactly the two timestamps the retry bound is computed from", async () => {
    const { result, calls } = observe();
    await result;
    expect(calls).toContainEqual({ method: "select", args: ["fulfilment_gap_first_seen_at,updated_at"] });
  });

  it("returns the POST-write row unchanged, never a pre-write read", async () => {
    const { result, calls } = observe();
    expect(await result).toEqual(POST_WRITE);
    // Both halves matter: the returned row is the one the write produced,
    // and there was no second statement that could have produced it.
    expect(await result).not.toEqual(PRE_WRITE);
    expect(calls.filter(c => c.method === "from")).toHaveLength(1);
    expect(calls.filter(c => c.method === "maybeSingle" || c.method === "single")).toHaveLength(1);
  });

  it("returns null when the compare-and-set matches no row", async () => {
    const { result } = observe({ rows: "none" });
    // Zero rows is not an error: the mapping moved to a state this write
    // may not touch. fulfillPokCheckout treats it as a failed observation
    // and answers blocked, never an unbounded retry.
    expect(await result).toBeNull();
  });

  it("throws exactly POK_FULFILMENT_OBSERVATION_WRITE_FAILED on a database error", async () => {
    const { result } = observe({ error: { message: "connection reset" } });
    // The route turns a throw into a 503 and the callback is retried. A
    // swallowed error would answer 200 and lose the observation, which is
    // the one outcome that can never be recovered from the provider.
    await expect(result).rejects.toThrow("POK_FULFILMENT_OBSERVATION_WRITE_FAILED");
    // The provider's own message must not escape into the application error.
    await expect(result).rejects.not.toThrow("connection reset");
  });
});
