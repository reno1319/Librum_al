import type { createAdminClient } from "@/lib/supabase/admin";

// LEDGER-1E-D-D: application-layer orchestration for the payout
// scheduler, built entirely on the already-live migration-053 RPCs
// (author_payout_eligibility, dry_run_scheduled_payouts,
// start_scheduled_payout_run, reserve_author_payout,
// complete_scheduled_payout_run). This module owns zero eligibility
// logic of its own -- every eligibility/threshold/active-reservation
// decision is made exclusively by the database, exactly once, inside
// those RPCs. What lives here is orchestration: deciding WHEN to call
// them, aggregating their results into a safe operational summary, and
// making sure a partial failure never gets reported as a clean
// success.
//
// Server-only. Never imported by a "use client" file -- these types
// and functions are deliberately NOT re-exported from src/lib/types.ts
// (which client bundles do import).

type AdminSupabaseClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------
// PAYOUT_SCHEDULER_ENABLED -- fail-closed feature switch.
//
// Exact rule (Section 8/38): the RAW environment value, trimmed of
// surrounding whitespace, must be byte-identical to the lowercase
// literal "true". Every other value -- missing, empty, "false", "1",
// "yes", differently-cased ("True"/"TRUE"), or anything malformed --
// is treated as disabled. This is deliberately NOT a generic
// truthy-string parser (no "1"/"yes"/"on" acceptance) precisely so a
// typo or a copy-pasted non-boolean value can never accidentally arm
// real reservation creation.
// ---------------------------------------------------------------------
export function isSchedulerEnabled(raw: string | undefined): boolean {
  return raw?.trim() === "true";
}

// ---------------------------------------------------------------------
// Current Europe/Tirane calendar month, as the canonical
// YYYY-MM-01 target-month string start_scheduled_payout_run() expects.
//
// Deliberately timezone-explicit (Section 16): reads the year/month AS
// RENDERED in Europe/Tirane via Intl.DateTimeFormat's own timeZone
// option, never the server process's local timezone and never manual
// UTC-offset arithmetic (which would silently break across the DST
// transition Europe/Tirane observes). A UTC instant that has already
// rolled into next month in Tirane (e.g. 23:30 UTC on the 31st, which
// is past midnight in Tirane during EET/EEST) correctly yields that
// NEXT month here, exactly mirroring the DB's own
// `date_trunc('month', now() at time zone 'Europe/Tirane')` computation
// in start_scheduled_payout_run().
// ---------------------------------------------------------------------
export function deriveTiranaTargetMonth(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) {
    // Intl guarantees these parts for a valid timeZone/options pair --
    // this branch exists only so a TypeScript-safe fallback exists,
    // never expected to execute.
    throw new Error("deriveTiranaTargetMonth: failed to derive year/month");
  }
  return `${year}-${month}-01`;
}

// ---------------------------------------------------------------------
// Strict targetMonth parser for the POST { mode: "reserve" } body.
//
// Accepts ONLY the exact "YYYY-MM-01" shape with a syntactically valid
// month (01-12) -- never "YYYY-MM" (Section 15's own explicit reject
// list), never a different separator, never a non-"01" day, never a
// normalized/guessed date. The DB's own p_target_month validation
// (first-of-month, non-future) remains the ultimate authority; this is
// a cheap, deterministic pre-filter that rejects obviously-malformed
// input before ever reaching a database round trip.
// ---------------------------------------------------------------------
const STRICT_TARGET_MONTH_PATTERN = /^(\d{4})-(\d{2})-01$/;

export function parseStrictTargetMonth(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = STRICT_TARGET_MONTH_PATTERN.exec(input);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return input;
}

// ---------------------------------------------------------------------
// dry_run_scheduled_payouts() row shape -- mirrors
// author_payout_eligibility()'s own RETURNS TABLE exactly (migration
// 053 Part 1/3, extended by migration 055 Part 7 with two new
// ineligible_reason values: no_minimum_policy and no_destination,
// inserted into the DB's own locked priority chain between
// no_settings/no_available_balance and below_threshold/eligible
// respectively). Local to this module, never broadened into the
// shared/public financial types client bundles import.
// ---------------------------------------------------------------------
export type DryRunEligibilityRow = {
  author_id: string;
  currency: string;
  ledger_available_minor: number | null;
  reserved_minor: number;
  payoutable_minor: number | null;
  threshold_configured: boolean;
  threshold_minor: number | null;
  active_reservation: boolean;
  eligible: boolean;
  ineligible_reason:
    | "no_settings"
    | "no_minimum_policy"
    | "no_available_balance"
    | "active_reservation"
    | "below_threshold"
    | "no_destination"
    | null;
};

// The exact six ineligible_reason values migration 055's
// author_payout_eligibility() can produce (BANK-PAYOUT-1C.1). Kept as
// its own named type so reasonCounts can never silently drift out of
// sync with DryRunEligibilityRow['ineligible_reason'] again.
export type DryRunReasonCounts = {
  no_settings: number;
  no_minimum_policy: number;
  no_available_balance: number;
  active_reservation: number;
  below_threshold: number;
  no_destination: number;
};

const KNOWN_INELIGIBLE_REASONS: ReadonlySet<string> = new Set<keyof DryRunReasonCounts>([
  "no_settings",
  "no_minimum_policy",
  "no_available_balance",
  "active_reservation",
  "below_threshold",
  "no_destination",
]);

export type DryRunSummary = {
  candidateCount: number;
  eligibleCount: number;
  ineligibleCount: number;
  // Sum of payoutable_minor across ELIGIBLE rows only, per currency --
  // the amount reserve mode would attempt to reserve for each
  // currency if run right now. Ineligible rows' payoutable_minor is
  // deliberately excluded (it can be null, negative, or simply not a
  // real payoutable amount).
  totalsByCurrency: Record<string, number>;
  reasonCounts: DryRunReasonCounts;
  // A defensive, always-present counter for a row whose
  // ineligible_reason is a non-null string outside the six known DB
  // reasons above -- e.g. a future migration adds a seventh reason
  // before this module is updated for it. Kept as its own separately-
  // typed field rather than folded into reasonCounts (BANK-PAYOUT-1C.1
  // Section 5), so an unrecognized reason can never produce a NaN or
  // undefined entry in the typed six-reason contract or in the JSON
  // this summary is serialized into.
  unknownReasonCount: number;
};

// Pure aggregation -- no I/O, no eligibility logic of its own (every
// eligible/ineligible_reason value is taken verbatim from the DB row).
// no_settings will typically read 0 here (Section 17's own note: a
// bulk dry-run scan is seeded from author_payout_settings itself, so a
// "no settings row" candidate structurally cannot appear in it) -- that
// 0 is a real, honestly-computed count, not a fabricated one.
export function summarizeDryRunRows(rows: DryRunEligibilityRow[]): DryRunSummary {
  const totalsByCurrency: Record<string, number> = {};
  const reasonCounts: DryRunReasonCounts = {
    no_settings: 0,
    no_minimum_policy: 0,
    no_available_balance: 0,
    active_reservation: 0,
    below_threshold: 0,
    no_destination: 0,
  };
  let eligibleCount = 0;
  let unknownReasonCount = 0;

  for (const row of rows) {
    if (row.eligible) {
      eligibleCount += 1;
      const amount = row.payoutable_minor ?? 0;
      totalsByCurrency[row.currency] = (totalsByCurrency[row.currency] ?? 0) + amount;
    } else if (row.ineligible_reason) {
      // A genuine runtime membership check against reasonCounts' own
      // keys (Section 5) -- NOT trusting the compile-time
      // ineligible_reason union alone, since the actual value comes
      // from an untrusted `as DryRunEligibilityRow[]` cast over live
      // RPC data, which the TypeScript type cannot enforce at runtime.
      if (KNOWN_INELIGIBLE_REASONS.has(row.ineligible_reason)) {
        reasonCounts[row.ineligible_reason as keyof DryRunReasonCounts] += 1;
      } else {
        unknownReasonCount += 1;
        console.error("[payout-scheduler] dry-run row has an unrecognized ineligible_reason", {
          ineligibleReason: row.ineligible_reason,
        });
      }
    }
  }

  return {
    candidateCount: rows.length,
    eligibleCount,
    ineligibleCount: rows.length - eligibleCount,
    totalsByCurrency,
    reasonCounts,
    unknownReasonCount,
  };
}

export type DryRunPassResult = { ok: true; summary: DryRunSummary } | { ok: false; message: string };

// The entire dry-run mode's DB surface: exactly one call to
// dry_run_scheduled_payouts(), which is itself STABLE and
// structurally incapable of mutating anything (migration 053 Part 3).
// No other RPC is ever called from this path.
export async function runDryRunPass(supabase: AdminSupabaseClient): Promise<DryRunPassResult> {
  const { data, error } = await supabase.rpc("dry_run_scheduled_payouts");
  if (error) {
    return { ok: false, message: safeErrorMessage(error) };
  }
  return { ok: true, summary: summarizeDryRunRows((data ?? []) as DryRunEligibilityRow[]) };
}

// ---------------------------------------------------------------------
// start_scheduled_payout_run() / reserve_author_payout() /
// complete_scheduled_payout_run() row shapes -- mirror migration 053's
// renamed, non-colliding RETURNS TABLE columns exactly.
// ---------------------------------------------------------------------
type ScheduledPayoutRunRow = {
  payout_run_id: string;
  payout_run_key: string;
  payout_run_scheduled_for: string;
  payout_run_status: string;
  payout_run_started_at: string;
  payout_run_completed_at: string | null;
  is_new: boolean;
};

type ReservePayoutRow = {
  payout_id: string;
  amount_minor: number;
  currency: string;
};

export type ReservationRunResult =
  | {
      ok: true;
      alreadyCompleted: true;
      runId: string;
      runKey: string;
    }
  | {
      ok: true;
      alreadyCompleted: false;
      runId: string;
      runKey: string;
      candidateCount: number;
      eligibleCount: number;
      reservedCount: number;
      skippedCount: number;
      totalsByCurrency: Record<string, number>;
    }
  | {
      ok: false;
      reason: "start_run_failed" | "dry_run_failed" | "candidate_errors" | "complete_failed";
      message: string;
      runId?: string;
      runKey?: string;
      candidateCount?: number;
      eligibleCount?: number;
      reservedCount?: number;
      skippedCount?: number;
      errorCount?: number;
      totalsByCurrency?: Record<string, number>;
    };

// Never dumps a raw Supabase/Postgres error object (Section 30) --
// extracts only a plain string message, falling back to a generic one
// if the shape is ever unexpected.
function safeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Unexpected error";
}

// ---------------------------------------------------------------------
// The full reservation orchestration pass (Section 18):
//   1. start_scheduled_payout_run(targetMonth)
//   2/3/4. inspect the returned run -- completed is a no-op; a
//      "failed" run rejection surfaces as an RPC error (migration 053's
//      own deterministic exception) and is handled by the generic
//      start-error path below, with no special-casing needed here.
//   5. dry_run_scheduled_payouts() as the candidate/eligibility scan.
//   6/7/8. reserve_author_payout() once per eligible candidate,
//      independently -- one candidate's outcome never affects another.
//   9. complete_scheduled_payout_run() ONLY if zero unexpected errors
//      occurred across the whole pass.
//
// Crash/retry safety (Section 24) and overlapping-invocation safety
// (Section 25) require NO application-level state here at all: every
// step is naturally idempotent/resumable because the DB RPCs
// themselves are (start returns the same running row on retry; a
// candidate already reserved by an earlier partial pass or a
// concurrent invocation simply yields a zero-row, non-error result
// from reserve_author_payout on this pass). No in-memory lock, no
// checkpoint table.
// ---------------------------------------------------------------------
export async function runReservationPass(
  supabase: AdminSupabaseClient,
  targetMonth: string,
): Promise<ReservationRunResult> {
  const { data: startRows, error: startError } = await supabase.rpc("start_scheduled_payout_run", {
    p_target_month: targetMonth,
  });

  if (startError) {
    // Covers BOTH an unexpected DB/connection failure AND the
    // deterministic "existing run is failed, requires explicit
    // recovery" rejection (migration 053 Part 4) -- either way, the
    // correct application behavior is identical: report a controlled
    // failure, call nothing else, never retry/reopen/mutate.
    return { ok: false, reason: "start_run_failed", message: safeErrorMessage(startError) };
  }

  const run = (startRows as ScheduledPayoutRunRow[] | null)?.[0];
  if (!run) {
    return { ok: false, reason: "start_run_failed", message: "start_scheduled_payout_run returned no row" };
  }

  if (run.payout_run_status === "completed") {
    return { ok: true, alreadyCompleted: true, runId: run.payout_run_id, runKey: run.payout_run_key };
  }

  const { data: candidateRows, error: dryRunError } = await supabase.rpc("dry_run_scheduled_payouts");
  if (dryRunError) {
    // The run stays 'running' -- a future retry (this same route,
    // called again for the same target month) resumes cleanly, since
    // start_scheduled_payout_run is idempotent against an existing
    // running row.
    return {
      ok: false,
      reason: "dry_run_failed",
      message: safeErrorMessage(dryRunError),
      runId: run.payout_run_id,
      runKey: run.payout_run_key,
    };
  }

  const candidates = (candidateRows ?? []) as DryRunEligibilityRow[];
  const eligible = candidates.filter((candidate) => candidate.eligible);

  let reservedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const totalsByCurrency: Record<string, number> = {};

  for (const candidate of eligible) {
    try {
      const { data: reserveRows, error: reserveError } = await supabase.rpc("reserve_author_payout", {
        p_author_id: candidate.author_id,
        p_currency: candidate.currency,
        p_payout_run_id: run.payout_run_id,
      });

      if (reserveError) {
        errorCount += 1;
        // Author id + currency, never email/display name/provider
        // data (Section 29) -- the minimum needed for internal
        // diagnosis of which candidate failed.
        console.error("[payout-scheduler] reserve_author_payout failed for a candidate", {
          authorId: candidate.author_id,
          currency: candidate.currency,
          message: safeErrorMessage(reserveError),
        });
        continue;
      }

      const reserved = ((reserveRows ?? []) as ReservePayoutRow[])[0];
      if (reserved) {
        reservedCount += 1;
        totalsByCurrency[reserved.currency] = (totalsByCurrency[reserved.currency] ?? 0) + reserved.amount_minor;
      } else {
        // Zero rows with NO error is a normal, expected outcome
        // (Section 20/22): the candidate's eligibility changed between
        // the scan and this call, or a concurrent caller already won
        // the active-reservation slot. Not a failure.
        skippedCount += 1;
      }
    } catch (unexpectedError) {
      errorCount += 1;
      console.error("[payout-scheduler] unexpected error reserving a candidate", {
        authorId: candidate.author_id,
        currency: candidate.currency,
        message: safeErrorMessage(unexpectedError),
      });
    }
  }

  if (errorCount > 0) {
    // The pass did not finish cleanly -- leave the run 'running' by
    // simply never calling complete_scheduled_payout_run. A future
    // retry resumes: already-reserved candidates are naturally
    // blocked/no-op, remaining eligible candidates may still reserve.
    return {
      ok: false,
      reason: "candidate_errors",
      message: `${errorCount} candidate(s) failed unexpectedly during reservation`,
      runId: run.payout_run_id,
      runKey: run.payout_run_key,
      candidateCount: candidates.length,
      eligibleCount: eligible.length,
      reservedCount,
      skippedCount,
      errorCount,
      totalsByCurrency,
    };
  }

  const { error: completeError } = await supabase.rpc("complete_scheduled_payout_run", {
    p_run_id: run.payout_run_id,
  });

  if (completeError) {
    return {
      ok: false,
      reason: "complete_failed",
      message: safeErrorMessage(completeError),
      runId: run.payout_run_id,
      runKey: run.payout_run_key,
      candidateCount: candidates.length,
      eligibleCount: eligible.length,
      reservedCount,
      skippedCount,
      errorCount: 0,
      totalsByCurrency,
    };
  }

  return {
    ok: true,
    alreadyCompleted: false,
    runId: run.payout_run_id,
    runKey: run.payout_run_key,
    candidateCount: candidates.length,
    eligibleCount: eligible.length,
    reservedCount,
    skippedCount,
    totalsByCurrency,
  };
}
