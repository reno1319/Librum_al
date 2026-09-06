// LEDGER-1D: pure, DB/Next.js-free helpers for the author-facing
// Financial Balance page -- money formatting, activity labels, the
// empty-state decision, and keyset-pagination display logic. Kept
// separate from actions.ts/page.tsx so every rule here is unit-testable
// without a database, matching this codebase's established convention
// (src/app/(public)/dashboard/sales/revenue-logic.ts,
// src/app/admin/(protected)/audit/audit-log-logic.ts).

import type { AuthorFinancialSummaryRow, AuthorFinancialActivityRow } from "@/lib/types";

// Integer minor units in, formatted string out -- the only place in
// this page's code that ever divides by 100. Never used for arithmetic;
// every balance computation happens in the SQL layer (migration 050) on
// bigint minor units, exactly as LEDGER-1D requires. Intl.NumberFormat
// is currency-aware (not a hardcoded "$"), so EUR/USD (or any future
// currency the ledger holds) each render with their own correct symbol
// and placement -- the two are never combined into one figure.
export function formatMinorAmount(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    signDisplay: "auto",
  }).format(amountMinor / 100);
}

const ENTRY_TYPE_LABELS: Record<AuthorFinancialActivityRow["entry_type"], string> = {
  sale: "Sale",
  refund: "Refund",
  payout: "Payout",
  adjustment: "Adjustment",
};

export function entryTypeLabel(entryType: AuthorFinancialActivityRow["entry_type"]): string {
  return ENTRY_TYPE_LABELS[entryType];
}

// A currency row is worth showing once it has ever recorded a single
// sale, refund, adjustment, or payout -- i.e. once any of its lifetime
// fields is non-zero. A currency that only ever had a zero-sum wash
// (not possible today, but not this function's job to assume) still
// counts as "has activity" via net_earnings/paid_out, so this checks
// every lifetime/paid_out field rather than just lifetime_sale_minor.
export function hasAnyLedgerActivity(summary: AuthorFinancialSummaryRow[]): boolean {
  return summary.some(
    (row) =>
      row.lifetime_sale_minor !== 0 ||
      row.lifetime_refund_minor !== 0 ||
      row.lifetime_adjustment_minor !== 0 ||
      row.paid_out_minor !== 0,
  );
}

// Keyset-pagination display logic, identical in shape to
// resolveAuditPage() (src/app/admin/(protected)/audit/audit-query.ts):
// the caller fetches `displayPageSize + 1` rows, and this function is
// the only place that decides what's actually shown. <= displayPageSize
// fetched proves there is nothing further (no Next). Exactly
// displayPageSize + 1 fetched means the last row is lookahead evidence
// only -- never rendered -- and the next cursor is derived from the
// last DISPLAYED row, not the lookahead row.
export const ACTIVITY_DISPLAY_PAGE_SIZE = 25;

export type ActivityPageResult = {
  rows: AuthorFinancialActivityRow[];
  nextCursor: { createdAt: string; id: string } | null;
};

export function resolveActivityPage(
  fetchedRows: AuthorFinancialActivityRow[],
  displayPageSize: number = ACTIVITY_DISPLAY_PAGE_SIZE,
): ActivityPageResult {
  if (fetchedRows.length <= displayPageSize) {
    return { rows: fetchedRows, nextCursor: null };
  }

  const rows = fetchedRows.slice(0, displayPageSize);
  const lastDisplayedRow = rows[rows.length - 1];
  return {
    rows,
    nextCursor: { createdAt: lastDisplayedRow.created_at, id: lastDisplayedRow.id },
  };
}
