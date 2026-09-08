import { describe, expect, it } from "vitest";
import {
  formatMinorAmount,
  entryTypeLabel,
  hasAnyLedgerActivity,
  resolveActivityPage,
  ACTIVITY_DISPLAY_PAGE_SIZE,
  payoutStatusLabel,
  resolvePayoutHistoryPage,
  PAYOUT_HISTORY_DISPLAY_PAGE_SIZE,
  maskIban,
  PAYOUT_DESTINATION_CURRENCY,
  isBankPayoutSetupEnabled,
} from "./balance-logic";
import type {
  AuthorFinancialSummaryRow,
  AuthorFinancialActivityRow,
  AuthorPayoutHistoryRow,
} from "@/lib/types";

function makeSummaryRow(overrides: Partial<AuthorFinancialSummaryRow> = {}): AuthorFinancialSummaryRow {
  return {
    currency: "USD",
    lifetime_sale_minor: 0,
    lifetime_refund_minor: 0,
    lifetime_adjustment_minor: 0,
    net_earnings_minor: 0,
    paid_out_minor: 0,
    pending_minor: 0,
    available_minor: 0,
    current_balance_minor: 0,
    ...overrides,
  };
}

function makeActivityRow(overrides: Partial<AuthorFinancialActivityRow> = {}): AuthorFinancialActivityRow {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    entry_type: "sale",
    amount_minor: 100,
    currency: "USD",
    gross_amount_minor: 125,
    librum_amount_minor: 25,
    royalty_rate_bps: 8000,
    available_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    book_id: null,
    book_title: null,
    ...overrides,
  };
}

function makePayoutHistoryRow(overrides: Partial<AuthorPayoutHistoryRow> = {}): AuthorPayoutHistoryRow {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    amount_minor: 100,
    currency: "USD",
    status: "pending",
    created_at: "2026-01-01T00:00:00Z",
    processing_at: null,
    paid_at: null,
    failed_at: null,
    ...overrides,
  };
}

describe("formatMinorAmount", () => {
  it("formats positive USD minor units as dollars, display-only", () => {
    expect(formatMinorAmount(640, "USD")).toBe("$6.40");
  });

  it("formats EUR with its own currency symbol, never mixed with USD", () => {
    const formatted = formatMinorAmount(500, "EUR");
    expect(formatted).toContain("5.00");
    expect(formatted).not.toContain("$");
  });

  it("never clamps a negative balance to zero -- renders the negative sign", () => {
    const formatted = formatMinorAmount(-800, "USD");
    expect(formatted).toMatch(/-/);
    expect(formatted).toContain("8.00");
  });

  it("formats zero without throwing", () => {
    expect(formatMinorAmount(0, "USD")).toBe("$0.00");
  });
});

describe("entryTypeLabel", () => {
  it("labels every known entry_type", () => {
    expect(entryTypeLabel("sale")).toBe("Sale");
    expect(entryTypeLabel("refund")).toBe("Refund");
    expect(entryTypeLabel("payout")).toBe("Payout");
    expect(entryTypeLabel("adjustment")).toBe("Adjustment");
  });
});

describe("hasAnyLedgerActivity", () => {
  it("is false for an empty summary (fresh production state, zero ledger rows)", () => {
    expect(hasAnyLedgerActivity([])).toBe(false);
  });

  it("is false when every lifetime/paid_out field is zero", () => {
    expect(hasAnyLedgerActivity([makeSummaryRow()])).toBe(false);
  });

  it("is true when any currency row has a nonzero lifetime_sale_minor", () => {
    expect(hasAnyLedgerActivity([makeSummaryRow({ lifetime_sale_minor: 640 })])).toBe(true);
  });

  it("is true when only paid_out_minor is nonzero", () => {
    expect(hasAnyLedgerActivity([makeSummaryRow({ paid_out_minor: 640 })])).toBe(true);
  });

  it("is true when at least one of several currency rows has activity", () => {
    expect(
      hasAnyLedgerActivity([makeSummaryRow({ currency: "EUR" }), makeSummaryRow({ currency: "USD", lifetime_refund_minor: 200 })]),
    ).toBe(true);
  });
});

describe("resolveActivityPage", () => {
  it("shows every row and no next cursor when fewer than displayPageSize+1 were fetched", () => {
    const rows = [makeActivityRow({ id: "1" }), makeActivityRow({ id: "2" })];
    const result = resolveActivityPage(rows, 25);
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("shows exactly displayPageSize rows and no next cursor when exactly displayPageSize were fetched", () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeActivityRow({ id: String(i) }));
    const result = resolveActivityPage(rows, 25);
    expect(result.rows).toHaveLength(25);
    expect(result.nextCursor).toBeNull();
  });

  it("drops the lookahead row and derives the cursor from the last DISPLAYED row", () => {
    const rows = Array.from({ length: 26 }, (_, i) =>
      makeActivityRow({ id: String(i), created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    const result = resolveActivityPage(rows, 25);
    expect(result.rows).toHaveLength(25);
    expect(result.rows[24].id).toBe("24");
    expect(result.nextCursor).toEqual({ createdAt: "2026-01-25T00:00:00Z", id: "24" });
  });

  it("uses ACTIVITY_DISPLAY_PAGE_SIZE (25) as the default page size", () => {
    expect(ACTIVITY_DISPLAY_PAGE_SIZE).toBe(25);
  });
});

describe("payoutStatusLabel", () => {
  it("labels every known payout status with safe, factual, non-promissory copy", () => {
    expect(payoutStatusLabel("pending")).toBe("Pending");
    expect(payoutStatusLabel("processing")).toBe("Processing");
    expect(payoutStatusLabel("paid")).toBe("Paid");
    expect(payoutStatusLabel("failed")).toBe("Failed");
    expect(payoutStatusLabel("cancelled")).toBe("Cancelled");
  });

  it("never labels reconciling as failed or paid -- it means Librum is still confirming the outcome", () => {
    const label = payoutStatusLabel("reconciling");
    expect(label.toLowerCase()).not.toContain("fail");
    expect(label.toLowerCase()).not.toBe("paid");
    expect(label).toBe("Under review");
  });
});

describe("resolvePayoutHistoryPage", () => {
  it("shows every row and no next cursor when fewer than displayPageSize+1 were fetched", () => {
    const rows = [makePayoutHistoryRow({ id: "1" }), makePayoutHistoryRow({ id: "2" })];
    const result = resolvePayoutHistoryPage(rows, 10);
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("shows exactly displayPageSize rows and no next cursor when exactly displayPageSize were fetched", () => {
    const rows = Array.from({ length: 10 }, (_, i) => makePayoutHistoryRow({ id: String(i) }));
    const result = resolvePayoutHistoryPage(rows, 10);
    expect(result.rows).toHaveLength(10);
    expect(result.nextCursor).toBeNull();
  });

  it("drops the lookahead row and derives the cursor from the last DISPLAYED row", () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      makePayoutHistoryRow({ id: String(i), created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    const result = resolvePayoutHistoryPage(rows, 10);
    expect(result.rows).toHaveLength(10);
    expect(result.rows[9].id).toBe("9");
    expect(result.nextCursor).toEqual({ createdAt: "2026-01-10T00:00:00Z", id: "9" });
  });

  it("uses PAYOUT_HISTORY_DISPLAY_PAGE_SIZE (10) as the default page size", () => {
    expect(PAYOUT_HISTORY_DISPLAY_PAGE_SIZE).toBe(10);
  });
});

// ---------------------------------------------------------------------
// PAYOUT_DESTINATION_CURRENCY -- BANK-PAYOUT-1E Section 4/7: the fixed
// V1 currency, never caller-selected.
// ---------------------------------------------------------------------
describe("PAYOUT_DESTINATION_CURRENCY", () => {
  it("is fixed to ALL", () => {
    expect(PAYOUT_DESTINATION_CURRENCY).toBe("ALL");
  });
});

// ---------------------------------------------------------------------
// maskIban -- BANK-PAYOUT-1E Section 5: never the full IBAN once saved,
// but still enough of it to recognize the account.
// ---------------------------------------------------------------------
describe("maskIban", () => {
  it("masks a real Albanian IBAN, keeping the country prefix and last 4 characters visible", () => {
    const masked = maskIban("AL47212110090000000235698741");
    expect(masked).not.toContain("212110090000000235698");
    expect(masked.startsWith("AL")).toBe(true);
    expect(masked.endsWith("8741")).toBe(true);
  });

  it("normalizes spaces and lowercase before masking (matches the RPC's own normalization)", () => {
    const spaced = maskIban("al47 2121 1009 0000 0002 3569 8741");
    const unspaced = maskIban("AL47212110090000000235698741");
    expect(spaced.replace(/\s+/g, "")).toBe(unspaced.replace(/\s+/g, ""));
  });

  it("never returns the full unmasked middle section of a real-length IBAN", () => {
    const masked = maskIban("GB29NWBK60161331926819");
    expect(masked).toContain("•");
    expect(masked).not.toContain("NWBK60161331926819".slice(0, 10));
  });

  it("contains no digits from the masked middle section, only the visible prefix/suffix", () => {
    const iban = "AL47212110090000000235698741";
    const masked = maskIban(iban);
    const middle = iban.slice(2, -4); // everything except country prefix + last 4
    expect(masked).not.toContain(middle);
  });

  it("never throws on a very short or malformed string", () => {
    expect(() => maskIban("")).not.toThrow();
    expect(() => maskIban("AL")).not.toThrow();
    expect(() => maskIban("not-an-iban")).not.toThrow();
  });

  it("returns a short string as-is (too short to usefully mask)", () => {
    expect(maskIban("AL47")).toBe("AL47");
  });
});

// ---------------------------------------------------------------------
// isBankPayoutSetupEnabled -- BANK-PAYOUT-1E.1 Section 10: exact
// trimmed lowercase "true", fail closed on everything else. Same
// contract/test matrix as isSchedulerEnabled() (src/lib/payout-
// scheduler.ts), deliberately duplicated rather than shared, since the
// two switches gate genuinely different concerns (UI rollout vs.
// reservation execution) and must never be collapsed into one.
// ---------------------------------------------------------------------
describe("isBankPayoutSetupEnabled", () => {
  it("is disabled when the value is missing (undefined)", () => {
    expect(isBankPayoutSetupEnabled(undefined)).toBe(false);
  });

  it("is disabled for an empty string", () => {
    expect(isBankPayoutSetupEnabled("")).toBe(false);
  });

  it("is disabled for 'false'", () => {
    expect(isBankPayoutSetupEnabled("false")).toBe(false);
  });

  it("is disabled for '1'", () => {
    expect(isBankPayoutSetupEnabled("1")).toBe(false);
  });

  it("is disabled for 'yes'", () => {
    expect(isBankPayoutSetupEnabled("yes")).toBe(false);
  });

  it("is disabled for differently-cased 'True'/'TRUE' -- no case folding", () => {
    expect(isBankPayoutSetupEnabled("True")).toBe(false);
    expect(isBankPayoutSetupEnabled("TRUE")).toBe(false);
  });

  it("is enabled for exactly 'true'", () => {
    expect(isBankPayoutSetupEnabled("true")).toBe(true);
  });

  it("is enabled for 'true' with surrounding whitespace (trimmed)", () => {
    expect(isBankPayoutSetupEnabled("  true  ")).toBe(true);
    expect(isBankPayoutSetupEnabled("\ttrue\n")).toBe(true);
  });

  it("is disabled for 'true' with internal whitespace", () => {
    expect(isBankPayoutSetupEnabled("tr ue")).toBe(false);
  });
});
