import { describe, expect, it, vi } from "vitest";
import {
  deriveTiranaTargetMonth,
  isSchedulerEnabled,
  parseStrictTargetMonth,
  runDryRunPass,
  runReservationPass,
  summarizeDryRunRows,
  type DryRunEligibilityRow,
} from "./payout-scheduler";

// ---------------------------------------------------------------------
// isSchedulerEnabled -- exact trimmed lowercase "true", fail closed on
// everything else (Section 8/38).
// ---------------------------------------------------------------------
describe("isSchedulerEnabled", () => {
  it("is disabled when the value is missing (undefined)", () => {
    expect(isSchedulerEnabled(undefined)).toBe(false);
  });

  it("is disabled for an empty string", () => {
    expect(isSchedulerEnabled("")).toBe(false);
  });

  it("is disabled for 'false'", () => {
    expect(isSchedulerEnabled("false")).toBe(false);
  });

  it("is disabled for '1'", () => {
    expect(isSchedulerEnabled("1")).toBe(false);
  });

  it("is disabled for 'yes'", () => {
    expect(isSchedulerEnabled("yes")).toBe(false);
  });

  it("is disabled for a random string", () => {
    expect(isSchedulerEnabled("enabled-please")).toBe(false);
  });

  it("is disabled for differently-cased 'True'/'TRUE' -- no case folding", () => {
    expect(isSchedulerEnabled("True")).toBe(false);
    expect(isSchedulerEnabled("TRUE")).toBe(false);
  });

  it("is enabled for exactly 'true'", () => {
    expect(isSchedulerEnabled("true")).toBe(true);
  });

  it("is enabled for 'true' with surrounding whitespace (trimmed)", () => {
    expect(isSchedulerEnabled("  true  ")).toBe(true);
    expect(isSchedulerEnabled("\ttrue\n")).toBe(true);
  });

  it("is disabled for 'true' with internal whitespace", () => {
    expect(isSchedulerEnabled("tr ue")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// deriveTiranaTargetMonth -- explicit Europe/Tirane timezone derivation,
// never server-local time (Section 16/41).
// ---------------------------------------------------------------------
describe("deriveTiranaTargetMonth", () => {
  it("an ordinary UTC date mid-month yields the same calendar month", () => {
    // 2026-06-15T10:00:00Z + CEST (UTC+2) = 2026-06-15T12:00 Tirane.
    expect(deriveTiranaTargetMonth(new Date("2026-06-15T10:00:00Z"))).toBe("2026-06-01");
  });

  it("summer (CEST, UTC+2): a late-UTC instant already next month in Tirane", () => {
    // 2026-07-31T22:30:00Z + 2h = 2026-08-01T00:30 Tirane -- crosses
    // into August purely due to the +2 DST offset, even though the UTC
    // instant is still July.
    expect(deriveTiranaTargetMonth(new Date("2026-07-31T22:30:00Z"))).toBe("2026-08-01");
  });

  it("winter (CET, UTC+1): a late-UTC instant already next month in Tirane", () => {
    // 2026-01-31T23:30:00Z + 1h = 2026-02-01T00:30 Tirane -- crosses
    // into February due to the +1 standard-time offset.
    expect(deriveTiranaTargetMonth(new Date("2026-01-31T23:30:00Z"))).toBe("2026-02-01");
  });

  it("a UTC instant on the LAST day of the month, still Tirane's previous day, stays in that month", () => {
    // 2026-03-01T00:30:00Z (UTC) is already March 1 in UTC. In Tirane
    // (CET, UTC+1, before the late-March DST transition) it is
    // 2026-03-01T01:30 -- also March. Chosen specifically so both UTC
    // and Tirane agree despite the offset, as a sanity check that the
    // helper reads Tirane's own rendering rather than always shifting
    // forward.
    expect(deriveTiranaTargetMonth(new Date("2026-03-01T00:30:00Z"))).toBe("2026-03-01");
  });

  it("defaults to the current time when no argument is given", () => {
    const result = deriveTiranaTargetMonth();
    expect(result).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

// ---------------------------------------------------------------------
// parseStrictTargetMonth -- exact YYYY-MM-01, never normalized
// (Section 15/41).
// ---------------------------------------------------------------------
describe("parseStrictTargetMonth", () => {
  it("accepts a well-formed YYYY-MM-01 string", () => {
    expect(parseStrictTargetMonth("2026-10-01")).toBe("2026-10-01");
  });

  it("rejects a bare YYYY-MM (no day)", () => {
    expect(parseStrictTargetMonth("2026-10")).toBeNull();
  });

  it("rejects slash-separated dates", () => {
    expect(parseStrictTargetMonth("2026/10/01")).toBeNull();
  });

  it("rejects a non-first-of-month day", () => {
    expect(parseStrictTargetMonth("2026-10-02")).toBeNull();
  });

  it("rejects an invalid month number", () => {
    expect(parseStrictTargetMonth("2026-13-01")).toBeNull();
    expect(parseStrictTargetMonth("2026-00-01")).toBeNull();
  });

  it("rejects an arbitrary non-date string", () => {
    expect(parseStrictTargetMonth("not-a-date")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(parseStrictTargetMonth(undefined)).toBeNull();
    expect(parseStrictTargetMonth(null)).toBeNull();
    expect(parseStrictTargetMonth(20261001)).toBeNull();
    expect(parseStrictTargetMonth({ year: 2026, month: 10 })).toBeNull();
  });
});

// ---------------------------------------------------------------------
// summarizeDryRunRows -- pure aggregation.
// ---------------------------------------------------------------------
function eligibleRow(overrides: Partial<DryRunEligibilityRow> = {}): DryRunEligibilityRow {
  return {
    author_id: "author-1",
    currency: "USD",
    ledger_available_minor: 100,
    reserved_minor: 0,
    payoutable_minor: 100,
    threshold_configured: true,
    threshold_minor: 50,
    active_reservation: false,
    eligible: true,
    ineligible_reason: null,
    ...overrides,
  };
}

function ineligibleRow(
  reason: DryRunEligibilityRow["ineligible_reason"],
  overrides: Partial<DryRunEligibilityRow> = {},
): DryRunEligibilityRow {
  return {
    author_id: "author-2",
    currency: "USD",
    ledger_available_minor: 10,
    reserved_minor: 0,
    payoutable_minor: 10,
    threshold_configured: true,
    threshold_minor: 50,
    active_reservation: reason === "active_reservation",
    eligible: false,
    ineligible_reason: reason,
    ...overrides,
  };
}

describe("summarizeDryRunRows", () => {
  // A: empty summary contains all six zero counters (BANK-PAYOUT-1C.1
  // Section 6A) -- migration 055 added no_minimum_policy/no_destination
  // alongside the original four.
  it("empty input yields all-zero summary, all six reason counters present", () => {
    expect(summarizeDryRunRows([])).toEqual({
      candidateCount: 0,
      eligibleCount: 0,
      ineligibleCount: 0,
      totalsByCurrency: {},
      reasonCounts: {
        no_settings: 0,
        no_minimum_policy: 0,
        no_available_balance: 0,
        active_reservation: 0,
        below_threshold: 0,
        no_destination: 0,
      },
      unknownReasonCount: 0,
    });
  });

  it("sums payoutable_minor across eligible rows, per currency", () => {
    const rows = [
      eligibleRow({ author_id: "a1", currency: "USD", payoutable_minor: 100 }),
      eligibleRow({ author_id: "a2", currency: "USD", payoutable_minor: 30 }),
      eligibleRow({ author_id: "a3", currency: "EUR", payoutable_minor: 50 }),
    ];
    const summary = summarizeDryRunRows(rows);
    expect(summary.candidateCount).toBe(3);
    expect(summary.eligibleCount).toBe(3);
    expect(summary.ineligibleCount).toBe(0);
    expect(summary.totalsByCurrency).toEqual({ USD: 130, EUR: 50 });
  });

  it("never includes ineligible rows' payoutable amounts in totalsByCurrency", () => {
    const rows = [
      eligibleRow({ currency: "USD", payoutable_minor: 100 }),
      ineligibleRow("below_threshold", { currency: "USD", payoutable_minor: 40 }),
    ];
    const summary = summarizeDryRunRows(rows);
    expect(summary.totalsByCurrency).toEqual({ USD: 100 });
  });

  it("counts ineligible_reason occurrences without fabricating no_settings", () => {
    const rows = [
      ineligibleRow("below_threshold"),
      ineligibleRow("below_threshold"),
      ineligibleRow("active_reservation"),
      ineligibleRow("no_available_balance"),
    ];
    const summary = summarizeDryRunRows(rows);
    expect(summary.reasonCounts).toEqual({
      no_settings: 0,
      no_minimum_policy: 0,
      no_available_balance: 1,
      active_reservation: 1,
      below_threshold: 2,
      no_destination: 0,
    });
    expect(summary.ineligibleCount).toBe(4);
  });

  it("treats a null payoutable_minor on an eligible row as 0 (defensive; should not occur in practice)", () => {
    const rows = [eligibleRow({ currency: "USD", payoutable_minor: null })];
    expect(summarizeDryRunRows(rows).totalsByCurrency).toEqual({ USD: 0 });
  });

  // B: no_minimum_policy increments correctly (BANK-PAYOUT-1C.1 Section
  // 6B) -- migration 055's new fail-closed gate: no active
  // payout_minimum_policy row for the currency.
  it("counts no_minimum_policy rows correctly, with no NaN/undefined corruption", () => {
    const rows = [ineligibleRow("no_minimum_policy"), ineligibleRow("no_minimum_policy")];
    const summary = summarizeDryRunRows(rows);
    expect(summary.reasonCounts.no_minimum_policy).toBe(2);
    expect(summary.ineligibleCount).toBe(2);
    expect(Number.isNaN(summary.reasonCounts.no_minimum_policy)).toBe(false);
  });

  // C: no_destination increments correctly (BANK-PAYOUT-1C.1 Section
  // 6C) -- migration 055's new gate: settings+policy+balance all
  // satisfied, but no saved payout destination.
  it("counts no_destination rows correctly, with no NaN/undefined corruption", () => {
    const rows = [ineligibleRow("no_destination")];
    const summary = summarizeDryRunRows(rows);
    expect(summary.reasonCounts.no_destination).toBe(1);
    expect(Number.isNaN(summary.reasonCounts.no_destination)).toBe(false);
  });

  // D: mixed old/new reasons count correctly (BANK-PAYOUT-1C.1 Section
  // 6D) -- every one of the six reasons in a single batch, each
  // counted independently and exactly once.
  it("counts a mix of pre-055 and migration-055 reasons independently and correctly", () => {
    const rows = [
      ineligibleRow("no_settings"),
      ineligibleRow("no_minimum_policy"),
      ineligibleRow("no_available_balance"),
      ineligibleRow("active_reservation"),
      ineligibleRow("below_threshold"),
      ineligibleRow("no_destination"),
      eligibleRow({ currency: "USD", payoutable_minor: 20 }),
    ];
    const summary = summarizeDryRunRows(rows);
    expect(summary.reasonCounts).toEqual({
      no_settings: 1,
      no_minimum_policy: 1,
      no_available_balance: 1,
      active_reservation: 1,
      below_threshold: 1,
      no_destination: 1,
    });
    expect(summary.eligibleCount).toBe(1);
    expect(summary.ineligibleCount).toBe(6);
    expect(summary.unknownReasonCount).toBe(0);
  });

  // F: an unexpected runtime reason (e.g. a future migration's DB
  // string this module hasn't been updated for yet) cannot produce
  // NaN/null numeric corruption anywhere in the summary
  // (BANK-PAYOUT-1C.1 Section 6F/5) -- it is bucketed into
  // unknownReasonCount instead, and every one of the six typed
  // counters stays a clean, defined number.
  it("an unrecognized future ineligible_reason is bucketed safely, never corrupts the typed counters", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const futureRow = ineligibleRow("no_settings", {
      ineligible_reason: "some_future_reason_not_yet_known" as unknown as DryRunEligibilityRow["ineligible_reason"],
    });
    const summary = summarizeDryRunRows([futureRow]);

    expect(summary.unknownReasonCount).toBe(1);
    expect(summary.ineligibleCount).toBe(1);
    for (const count of Object.values(summary.reasonCounts)) {
      expect(typeof count).toBe("number");
      expect(Number.isNaN(count)).toBe(false);
    }
    expect(summary.reasonCounts).toEqual({
      no_settings: 0,
      no_minimum_policy: 0,
      no_available_balance: 0,
      active_reservation: 0,
      below_threshold: 0,
      no_destination: 0,
    });
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    consoleErrorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------
// runDryRunPass -- exactly one RPC call, no arguments, no mutation RPC.
// ---------------------------------------------------------------------
type FakeRpcImpl = (name: string, params?: unknown) => Promise<{ data: unknown; error: unknown }>;

function makeFakeAdminClient(rpcImpl: FakeRpcImpl) {
  return { rpc: vi.fn(rpcImpl) };
}

describe("runDryRunPass", () => {
  it("calls dry_run_scheduled_payouts with no arguments", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const supabase = { rpc };
    await runDryRunPass(supabase as never);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("dry_run_scheduled_payouts");
  });

  it("returns an aggregated summary on success", async () => {
    const rows = [eligibleRow({ currency: "USD", payoutable_minor: 75 })];
    const supabase = makeFakeAdminClient(async () => ({ data: rows, error: null }));
    const result = await runDryRunPass(supabase as never);
    expect(result).toEqual({
      ok: true,
      summary: {
        candidateCount: 1,
        eligibleCount: 1,
        ineligibleCount: 0,
        totalsByCurrency: { USD: 75 },
        reasonCounts: {
          no_settings: 0,
          no_minimum_policy: 0,
          no_available_balance: 0,
          active_reservation: 0,
          below_threshold: 0,
          no_destination: 0,
        },
        unknownReasonCount: 0,
      },
    });
  });

  it("returns ok:false with a safe message on RPC error", async () => {
    const supabase = makeFakeAdminClient(async () => ({ data: null, error: { message: "db unavailable" } }));
    const result = await runDryRunPass(supabase as never);
    expect(result).toEqual({ ok: false, message: "db unavailable" });
  });

  // E: runDryRunPass returns a correct, safe summary for BOTH
  // migration-055 reasons end-to-end (BANK-PAYOUT-1C.1 Section 6E) --
  // not just the pure summarizeDryRunRows() unit above.
  it("returns a correct summary for a mix including no_minimum_policy and no_destination rows", async () => {
    const rows = [
      eligibleRow({ author_id: "a1", currency: "USD", payoutable_minor: 60 }),
      ineligibleRow("no_minimum_policy", { author_id: "a2" }),
      ineligibleRow("no_destination", { author_id: "a3" }),
    ];
    const supabase = makeFakeAdminClient(async () => ({ data: rows, error: null }));
    const result = await runDryRunPass(supabase as never);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.candidateCount).toBe(3);
      expect(result.summary.eligibleCount).toBe(1);
      expect(result.summary.ineligibleCount).toBe(2);
      expect(result.summary.totalsByCurrency).toEqual({ USD: 60 });
      expect(result.summary.reasonCounts.no_minimum_policy).toBe(1);
      expect(result.summary.reasonCounts.no_destination).toBe(1);
      expect(result.summary.unknownReasonCount).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------
// runReservationPass -- the full orchestration sequence.
// ---------------------------------------------------------------------
function runningRow(overrides: Record<string, unknown> = {}) {
  return {
    payout_run_id: "run-1",
    payout_run_key: "monthly:2026-10",
    payout_run_scheduled_for: "2026-10-01",
    payout_run_status: "running",
    payout_run_started_at: "2026-10-01T00:00:00Z",
    payout_run_completed_at: null,
    is_new: true,
    ...overrides,
  };
}

describe("runReservationPass", () => {
  it("a completed run short-circuits: no dry-run scan, no reserve, no complete call", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_scheduled_payout_run") {
        return { data: [runningRow({ payout_run_status: "completed", payout_run_id: "run-done" })], error: null };
      }
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    const result = await runReservationPass(supabase as never, "2026-09-01");

    expect(result).toEqual({ ok: true, alreadyCompleted: true, runId: "run-done", runKey: "monthly:2026-10" });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("a start-run RPC error (including the deterministic failed-run rejection) is a controlled failure with no further calls", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_scheduled_payout_run") {
        return {
          data: null,
          error: { message: "start_scheduled_payout_run: scheduled payout run monthly:2026-08 is failed and requires explicit recovery" },
        };
      }
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    const result = await runReservationPass(supabase as never, "2026-08-01");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("start_run_failed");
      expect(result.message).toMatch(/failed and requires explicit recovery/);
    }
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("a dry-run scan failure after a successful start leaves the run untouched (no reserve/complete calls)", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: null, error: { message: "scan failed" } };
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    const result = await runReservationPass(supabase as never, "2026-10-01");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("dry_run_failed");
      expect(result.runId).toBe("run-1");
    }
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("a full successful pass: start -> scan -> reserve each eligible candidate -> complete", async () => {
    const candidates: DryRunEligibilityRow[] = [
      eligibleRow({ author_id: "author-a", currency: "USD", payoutable_minor: 100 }),
      eligibleRow({ author_id: "author-b", currency: "EUR", payoutable_minor: 50 }),
      ineligibleRow("below_threshold", { author_id: "author-c" }),
    ];
    const reserveCalls: unknown[] = [];
    const rpc = vi.fn(async (name: string, params?: unknown) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "reserve_author_payout") {
        reserveCalls.push(params);
        const p = params as { p_author_id: string; p_currency: string };
        return {
          data: [{ payout_id: `p-${p.p_author_id}`, amount_minor: p.p_currency === "USD" ? 100 : 50, currency: p.p_currency }],
          error: null,
        };
      }
      if (name === "complete_scheduled_payout_run") return { data: [runningRow({ payout_run_status: "completed" })], error: null };
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    const result = await runReservationPass(supabase as never, "2026-10-01");

    expect(reserveCalls).toHaveLength(2);
    expect(reserveCalls).toContainEqual({ p_author_id: "author-a", p_currency: "USD", p_payout_run_id: "run-1" });
    expect(reserveCalls).toContainEqual({ p_author_id: "author-b", p_currency: "EUR", p_payout_run_id: "run-1" });
    expect(result).toEqual({
      ok: true,
      alreadyCompleted: false,
      runId: "run-1",
      runKey: "monthly:2026-10",
      candidateCount: 3,
      eligibleCount: 2,
      reservedCount: 2,
      skippedCount: 0,
      totalsByCurrency: { USD: 100, EUR: 50 },
    });
    expect(rpc).toHaveBeenCalledWith("complete_scheduled_payout_run", { p_run_id: "run-1" });
  });

  it("dry-run said eligible but reserve returns zero rows with no error: counted as skipped, not an error, run still completes", async () => {
    const candidates: DryRunEligibilityRow[] = [eligibleRow({ author_id: "author-a", currency: "USD" })];
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "reserve_author_payout") return { data: [], error: null };
      if (name === "complete_scheduled_payout_run") return { data: [runningRow({ payout_run_status: "completed" })], error: null };
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    const result = await runReservationPass(supabase as never, "2026-10-01");

    expect(result.ok).toBe(true);
    if (result.ok && !result.alreadyCompleted) {
      expect(result.reservedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    }
    expect(rpc).toHaveBeenCalledWith("complete_scheduled_payout_run", { p_run_id: "run-1" });
  });

  it("one candidate's unexpected RPC error does not block evaluating the rest, but blocks completion", async () => {
    const candidates: DryRunEligibilityRow[] = [
      eligibleRow({ author_id: "author-fail", currency: "USD" }),
      eligibleRow({ author_id: "author-ok", currency: "USD" }),
    ];
    const rpc = vi.fn(async (name: string, params?: unknown) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "reserve_author_payout") {
        const p = params as { p_author_id: string };
        if (p.p_author_id === "author-fail") {
          return { data: null, error: { message: "connection reset" } };
        }
        return { data: [{ payout_id: "p-ok", amount_minor: 20, currency: "USD" }], error: null };
      }
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    const result = await runReservationPass(supabase as never, "2026-10-01");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("candidate_errors");
      expect(result.errorCount).toBe(1);
      expect(result.reservedCount).toBe(1);
    }
    // complete_scheduled_payout_run must never be called.
    expect(rpc).not.toHaveBeenCalledWith("complete_scheduled_payout_run", expect.anything());
  });

  it("a thrown (non-RPC-error) exception for one candidate is also caught and counted", async () => {
    const candidates: DryRunEligibilityRow[] = [eligibleRow({ author_id: "author-throws", currency: "USD" })];
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "reserve_author_payout") throw new Error("network exploded");
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    const result = await runReservationPass(supabase as never, "2026-10-01");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("candidate_errors");
      expect(result.errorCount).toBe(1);
    }
  });

  it("ineligible candidates never trigger a reserve_author_payout call", async () => {
    const candidates: DryRunEligibilityRow[] = [
      ineligibleRow("below_threshold", { author_id: "author-a" }),
      ineligibleRow("active_reservation", { author_id: "author-b" }),
    ];
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "complete_scheduled_payout_run") return { data: [runningRow({ payout_run_status: "completed" })], error: null };
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    await runReservationPass(supabase as never, "2026-10-01");

    expect(rpc).not.toHaveBeenCalledWith("reserve_author_payout", expect.anything());
  });

  it("a failure to complete the run is reported, distinct from a candidate error", async () => {
    const candidates: DryRunEligibilityRow[] = [eligibleRow({ author_id: "author-a", currency: "USD" })];
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "reserve_author_payout") return { data: [{ payout_id: "p1", amount_minor: 10, currency: "USD" }], error: null };
      if (name === "complete_scheduled_payout_run") return { data: null, error: { message: "commit failed" } };
      throw new Error(`unexpected RPC call: ${name}`);
    });
    const supabase = { rpc };

    const result = await runReservationPass(supabase as never, "2026-10-01");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("complete_failed");
      expect(result.errorCount).toBe(0);
      expect(result.reservedCount).toBe(1);
    }
  });
});
