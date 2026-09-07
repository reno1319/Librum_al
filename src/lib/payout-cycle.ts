// LEDGER-1E-D-G: the single source of truth for the V1 monthly payout
// cycle business policy. Mirrors AUTHOR_EARNINGS_SETTLEMENT_DAYS's own
// role in src/lib/settlement-policy.ts -- one named constant module,
// never duplicated inline across the dashboard, vercel.json's own cron
// entry, or anywhere else that needs to know "when is payout day."
//
// POLICY (approved): evaluate payouts monthly, on the 5th, business
// timezone Europe/Tirane. vercel.json's own cron entry
// ("0 6 5 * *" -- 06:00 UTC, day 5, every month) cannot import this
// file (Vercel reads it as static JSON, not code), so the two are kept
// in sync manually -- PAYOUT_CYCLE_CRON_EXPRESSION below is the
// canonical value that entry must match; see
// src/lib/vercel-cron-config.test.ts, which reads vercel.json directly
// and asserts they agree.
//
// WHY 06:00 UTC (not some other hour): that instant lands on calendar
// day 5 in Europe/Tirane in BOTH CET (UTC+1 -> 07:00 local) and CEST
// (UTC+2 -> 08:00 local) -- nowhere near a day or month boundary in
// either offset (an offset of only +1/+2 hours from a 06:00 UTC
// anchor can never cross into day 6, let alone a different month), so
// the UTC calendar day and the Tirane calendar day are always
// identical for this exact hour choice. This is a real, verified
// invariant of 06:00 UTC specifically, not a coincidence to be
// assumed elsewhere -- changing the cron hour would need to
// re-verify it against Europe/Tirane's own DST transition rules.
//
// The business promise to authors is the DATE ("payouts are evaluated
// on the 5th"), never a specific clock time -- nothing in this module
// or its callers should ever surface "06:00" to an author.
export const PAYOUT_CYCLE_TIMEZONE = "Europe/Tirane";
export const PAYOUT_CYCLE_DAY_OF_MONTH = 5;
export const PAYOUT_CYCLE_CRON_HOUR_UTC = 6;
export const PAYOUT_CYCLE_CRON_EXPRESSION = "0 6 5 * *";

// The exact UTC instant the monthly cron fires for a given (year,
// zero-based UTC month) pair. `Date.UTC` normalizes an out-of-range
// month (e.g. 12 for "the month after December") into the next
// year automatically, so callers never need to special-case a
// December -> January rollover themselves.
function cycleInstantForMonth(year: number, utcMonthIndex: number): Date {
  return new Date(
    Date.UTC(year, utcMonthIndex, PAYOUT_CYCLE_DAY_OF_MONTH, PAYOUT_CYCLE_CRON_HOUR_UTC, 0, 0, 0),
  );
}

// Determines the NEXT scheduled payout-cycle date, as a canonical
// "YYYY-MM-05" string -- never a Date/instant, so no caller is ever
// tempted to surface a clock time.
//
// Boundary rule: strictly BEFORE this (UTC calendar) month's cycle
// instant -> that cycle is still upcoming, return it. AT OR AFTER it
// -> this month's cycle has already fired (or is firing at this exact
// instant), so the next one is next month's. The >= choice is
// deliberate (Section 8's own stated preference): "next" must always
// resolve to a moment strictly ahead of `now` -- a caller evaluating
// at the exact scheduled instant is (from that instant's own point of
// view) at the start of the current pass, not before it, so the
// correctly "next" cycle is the one after.
export function computeNextPayoutCycleDate(now: Date = new Date()): string {
  const thisMonthCandidate = cycleInstantForMonth(now.getUTCFullYear(), now.getUTCMonth());
  const target =
    now.getTime() < thisMonthCandidate.getTime()
      ? thisMonthCandidate
      : cycleInstantForMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);

  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, "0");
  const day = String(PAYOUT_CYCLE_DAY_OF_MONTH).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Human-readable Europe/Tirane rendering of a "YYYY-MM-05" cycle date
// (e.g. "5 October 2026"). Anchors to the REAL cron instant (06:00 UTC
// on that date) and formats with an explicit timeZone -- never
// server-local or browser-local (Section 9's own explicit requirement)
// -- so the displayed calendar day can never silently shift for a
// viewer or server running in a different timezone. Safe regardless of
// which day-of-month/hour this policy ever changes to, because the
// timezone conversion is explicit rather than relied upon to happen to
// land on the same day.
export function formatPayoutCycleDate(cycleDate: string): string {
  const hour = String(PAYOUT_CYCLE_CRON_HOUR_UTC).padStart(2, "0");
  const instant = new Date(`${cycleDate}T${hour}:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: PAYOUT_CYCLE_TIMEZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(instant);
}
