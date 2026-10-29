import { afterEach, describe, expect, it } from "vitest";
import { formatDateOnly, formatTimestampAsDate } from "./book-detail-dates";

describe("formatTimestampAsDate", () => {
  it("formats a real timestamp as a plain reader-friendly date", () => {
    expect(formatTimestampAsDate("2024-03-15T10:30:00.000Z")).toContain("2024");
  });
});

// ALBANIAN-2: a real instant shows as its calendar day in Tirana.
describe("formatTimestampAsDate: Albanian, Tirana day", () => {
  it("shows the Tirana day, not the UTC day, around midnight", () => {
    // 23:30 UTC on 28 Oct is 00:30 on 29 Oct in Tirana (UTC+1).
    expect(formatTimestampAsDate("2026-10-28T23:30:00.000Z")).toBe("29 tetor 2026");
  });

  it("does not depend on the host time zone", () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(formatTimestampAsDate("2026-10-28T23:30:00.000Z")).toBe("29 tetor 2026");
    } finally {
      process.env.TZ = originalTZ;
    }
  });
});

describe("formatDateOnly", () => {
  const originalTZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTZ;
  });

  it("renders the exact calendar day for a YYYY-MM-DD input", () => {
    expect(formatDateOnly("2020-01-01")).toContain("1 janar 2020");
  });

  // LIBRUM 2.0 PUBLISHING-UX-1 PART D: the actual defect this function
  // exists to avoid -- a bare `new Date("2020-01-01")` parses as UTC
  // midnight, so formatting it under a negative-UTC-offset host
  // timezone rolls the displayed day back to Dec 31, 2019. Set here
  // deterministically (rather than hoping CI happens to run in a
  // negative-offset zone) so this regression is caught regardless of
  // where tests run.
  it("does not roll the date back a day under a negative-UTC-offset host timezone", () => {
    process.env.TZ = "America/Los_Angeles"; // UTC-8 (winter)
    expect(formatDateOnly("2020-01-01")).toContain("1 janar 2020");
    expect(formatDateOnly("2020-01-01")).not.toContain("2019");
  });

  it("demonstrates the bug this function avoids: naive UTC-midnight parsing WOULD roll back", () => {
    process.env.TZ = "America/Los_Angeles";
    const naive = new Date("2020-01-01").toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    expect(naive).toContain("Dec 31, 2019");
  });

  it("also holds for a positive-UTC-offset host timezone", () => {
    process.env.TZ = "Pacific/Auckland"; // UTC+13 (summer)
    expect(formatDateOnly("2020-06-30")).toContain("30 qershor 2020");
  });
});
