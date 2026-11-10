import { afterEach, describe, expect, it, vi } from "vitest";
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

  // B6: summer time (CEST, UTC+2) -- a fixed UTC+1 would say 28 korrik.
  it("uses Tirana summer time (UTC+2) around midnight", () => {
    expect(formatTimestampAsDate("2026-07-28T22:30:00.000Z")).toBe("29 korrik 2026");
    expect(formatTimestampAsDate("2026-07-28T21:59:00.000Z")).toBe("28 korrik 2026");
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

// X21: formatDateOnly no longer goes through Intl (a browser without
// Albanian locale data printed English months), but its output must stay
// exactly what the server printed before (emails, book page, pre-order
// hint).
describe("formatDateOnly: fixed Albanian months (X21)", () => {
  const OLD_OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" };
  const oldFormat = (dateOnly: string) => new Date(`${dateOnly}T00:00:00Z`).toLocaleDateString("sq", OLD_OPTIONS);

  it("prints every month exactly as before", () => {
    const expected = [
      "5 janar 2026",
      "5 shkurt 2026",
      "5 mars 2026",
      "5 prill 2026",
      "5 maj 2026",
      "5 qershor 2026",
      "5 korrik 2026",
      "5 gusht 2026",
      "5 shtator 2026",
      "5 tetor 2026",
      "5 nëntor 2026",
      "5 dhjetor 2026",
    ];
    for (let m = 1; m <= 12; m++) {
      const day = `2026-${String(m).padStart(2, "0")}-05`;
      expect(formatDateOnly(day)).toBe(expected[m - 1]);
      expect(formatDateOnly(day)).toBe(oldFormat(day));
    }
  });

  it("matches the old Intl output byte for byte for every day 1900-2100", () => {
    // One formatter with the old options (same output as the old
    // toLocaleDateString call, much faster over ~73,000 days).
    const old = new Intl.DateTimeFormat("sq", OLD_OPTIONS);
    let checked = 0;
    for (let t = Date.UTC(1900, 0, 1); t <= Date.UTC(2100, 11, 31); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const want = old.format(new Date(`${day}T00:00:00Z`));
      if (formatDateOnly(day) !== want) expect(formatDateOnly(day)).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(73_414);
  });

  it("keeps the old answer for odd input", () => {
    for (const odd of ["", "nope", "2026-13-01", "0099-01-05", "2026-02-30"]) expect(formatDateOnly(odd)).toBe(oldFormat(odd));
  });

  it("does not use the runtime's locale data (a browser without Albanian)", () => {
    const spy = vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("November 21, 2026");
    const spyIntl = vi.spyOn(Intl, "DateTimeFormat");
    try {
      expect(formatDateOnly("2026-11-21")).toBe("21 nëntor 2026");
      expect(spy).not.toHaveBeenCalled();
      expect(spyIntl).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      spyIntl.mockRestore();
    }
  });
});
