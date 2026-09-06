import { describe, expect, it } from "vitest";
import { AUTHOR_EARNINGS_SETTLEMENT_DAYS, computeSaleAvailableAt } from "./settlement-policy";

describe("AUTHOR_EARNINGS_SETTLEMENT_DAYS", () => {
  it("is 30 days -- deliberately longer than the 14-day refund window", () => {
    expect(AUTHOR_EARNINGS_SETTLEMENT_DAYS).toBe(30);
  });
});

describe("computeSaleAvailableAt", () => {
  it("adds exactly 30 days to the sale timestamp", () => {
    const saleRecordedAt = new Date("2026-01-01T12:00:00.000Z");
    const availableAt = computeSaleAvailableAt(saleRecordedAt);
    expect(availableAt.toISOString()).toBe("2026-01-31T12:00:00.000Z");
  });

  it("does not mutate the input date", () => {
    const saleRecordedAt = new Date("2026-01-01T00:00:00.000Z");
    const originalTime = saleRecordedAt.getTime();
    computeSaleAvailableAt(saleRecordedAt);
    expect(saleRecordedAt.getTime()).toBe(originalTime);
  });

  it("correctly crosses a month boundary", () => {
    const saleRecordedAt = new Date("2026-02-15T00:00:00.000Z");
    const availableAt = computeSaleAvailableAt(saleRecordedAt);
    expect(availableAt.toISOString()).toBe("2026-03-17T00:00:00.000Z");
  });

  it("correctly crosses a year boundary", () => {
    const saleRecordedAt = new Date("2026-12-15T00:00:00.000Z");
    const availableAt = computeSaleAvailableAt(saleRecordedAt);
    expect(availableAt.toISOString()).toBe("2027-01-14T00:00:00.000Z");
  });
});
