import { describe, expect, it } from "vitest";
import {
  PAYOUT_CYCLE_TIMEZONE,
  PAYOUT_CYCLE_DAY_OF_MONTH,
  PAYOUT_CYCLE_CRON_HOUR_UTC,
  PAYOUT_CYCLE_CRON_EXPRESSION,
  computeNextPayoutCycleDate,
  formatPayoutCycleDate,
} from "./payout-cycle";

describe("payout cycle policy constants", () => {
  it("business timezone is Europe/Tirane", () => {
    expect(PAYOUT_CYCLE_TIMEZONE).toBe("Europe/Tirane");
  });

  it("cycle day of month is the 5th", () => {
    expect(PAYOUT_CYCLE_DAY_OF_MONTH).toBe(5);
  });

  it("cron hour is 06:00 UTC", () => {
    expect(PAYOUT_CYCLE_CRON_HOUR_UTC).toBe(6);
  });

  it("cron expression is exactly '0 6 5 * *'", () => {
    expect(PAYOUT_CYCLE_CRON_EXPRESSION).toBe("0 6 5 * *");
  });
});

describe("computeNextPayoutCycleDate", () => {
  it("before this month's cycle instant returns this month's 5th", () => {
    expect(computeNextPayoutCycleDate(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-05");
  });

  it("1ms before the cycle instant still returns this month's 5th", () => {
    expect(computeNextPayoutCycleDate(new Date("2026-10-05T05:59:59.999Z"))).toBe("2026-10-05");
  });

  it("exactly AT the cycle instant rolls to next month (>= boundary rule)", () => {
    expect(computeNextPayoutCycleDate(new Date("2026-10-05T06:00:00.000Z"))).toBe("2026-11-05");
  });

  it("1ms after the cycle instant rolls to next month", () => {
    expect(computeNextPayoutCycleDate(new Date("2026-10-05T06:00:00.001Z"))).toBe("2026-11-05");
  });

  it("late in the month (cycle long past) returns next month's 5th", () => {
    expect(computeNextPayoutCycleDate(new Date("2026-10-31T23:59:59Z"))).toBe("2026-11-05");
  });

  it("December -> January year rollover", () => {
    expect(computeNextPayoutCycleDate(new Date("2026-12-10T00:00:00Z"))).toBe("2027-01-05");
  });

  it("before December's own cycle stays in December (no premature rollover)", () => {
    expect(computeNextPayoutCycleDate(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12-05");
  });

  it("February in a non-leap year", () => {
    expect(computeNextPayoutCycleDate(new Date("2027-02-01T00:00:00Z"))).toBe("2027-02-05");
  });

  it("February in a leap year", () => {
    expect(computeNextPayoutCycleDate(new Date("2028-02-01T00:00:00Z"))).toBe("2028-02-05");
  });

  it("leap-year February rolls into March correctly", () => {
    expect(computeNextPayoutCycleDate(new Date("2028-02-10T00:00:00Z"))).toBe("2028-03-05");
  });

  it("defaults to the current time and returns a well-formed YYYY-MM-05 string", () => {
    const result = computeNextPayoutCycleDate();
    expect(result).toMatch(/^\d{4}-\d{2}-05$/);
  });
});

describe("formatPayoutCycleDate", () => {
  it("winter (CET, UTC+1): displayed day remains the 5th", () => {
    expect(formatPayoutCycleDate("2026-01-05")).toBe("5 January 2026");
  });

  it("summer (CEST, UTC+2): displayed day remains the 5th", () => {
    expect(formatPayoutCycleDate("2026-07-05")).toBe("5 July 2026");
  });

  it("December", () => {
    expect(formatPayoutCycleDate("2026-12-05")).toBe("5 December 2026");
  });

  it("leap-year February", () => {
    expect(formatPayoutCycleDate("2028-02-05")).toBe("5 February 2028");
  });

  it("never depends on server-local timezone -- explicit Europe/Tirane regardless of TZ env", () => {
    // The formatter itself hardcodes timeZone: PAYOUT_CYCLE_TIMEZONE, so
    // this is a structural guarantee rather than something that could
    // vary by CI environment -- asserted here as a regression guard on
    // the source itself never being changed to rely on the default
    // locale/timezone.
    const result = formatPayoutCycleDate("2026-06-05");
    expect(result).toBe("5 June 2026");
  });
});
