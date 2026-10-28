import { describe, expect, it } from "vitest";
import { chartDayLabels } from "@/lib/chart-day-labels";

function day(month: number, date: number) {
  return new Date(2026, month, date);
}

describe("chartDayLabels (FIX1 X13)", () => {
  it("names the month on the first bar only, within one month", () => {
    expect(chartDayLabels([day(9, 12), day(9, 13), day(9, 14)])).toEqual([
      { day: "12", month: "Tet" },
      { day: "13", month: null },
      { day: "14", month: null },
    ]);
  });

  it("names the new month where it changes", () => {
    expect(chartDayLabels([day(8, 29), day(8, 30), day(9, 1), day(9, 2)])).toEqual([
      { day: "29", month: "Sht" },
      { day: "30", month: null },
      { day: "1", month: "Tet" },
      { day: "2", month: null },
    ]);
  });

  it("handles a year change and an empty chart", () => {
    expect(chartDayLabels([day(11, 31), new Date(2027, 0, 1)])).toEqual([
      { day: "31", month: "Dhj" },
      { day: "1", month: "Jan" },
    ]);
    expect(chartDayLabels([])).toEqual([]);
  });
});
