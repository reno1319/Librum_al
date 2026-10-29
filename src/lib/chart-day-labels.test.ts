import { describe, expect, it } from "vitest";
import { chartDayLabels, chartDayTitle } from "@/lib/chart-day-labels";

function day(month: number, date: number) {
  return new Date(Date.UTC(2026, month, date));
}

describe("chartDayLabels (FIX1 X13)", () => {
  it("names the month on the first bar only, within one month", () => {
    expect(chartDayLabels([day(9, 12), day(9, 13), day(9, 14)])).toEqual([
      { day: "12", month: "tet" },
      { day: "13", month: null },
      { day: "14", month: null },
    ]);
  });

  it("names the new month where it changes", () => {
    expect(chartDayLabels([day(8, 29), day(8, 30), day(9, 1), day(9, 2)])).toEqual([
      { day: "29", month: "sht" },
      { day: "30", month: null },
      { day: "1", month: "tet" },
      { day: "2", month: null },
    ]);
  });

  it("handles a year change and an empty chart", () => {
    expect(chartDayLabels([day(11, 31), new Date(Date.UTC(2027, 0, 1))])).toEqual([
      { day: "31", month: "dhj" },
      { day: "1", month: "jan" },
    ]);
    expect(chartDayLabels([])).toEqual([]);
  });
});

describe("chartDayTitle (SQ-16)", () => {
  it("reads the same day and lowercase month as the label", () => {
    expect(chartDayTitle(day(9, 28))).toBe("28 tet");
    expect(chartDayTitle(day(10, 1))).toBe("1 nën");
    expect(chartDayLabels([day(9, 28)])[0].month).toBe(chartDayTitle(day(9, 28)).split(" ")[1]);
  });
});
