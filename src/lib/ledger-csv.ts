// CSV-1 (idea 35): the author's and the staff's ledger downloads.
// Renato's choices (11-27): both files (ex1 b), numbers straight from
// the ledger -- the split stored on each row, never recomputed here
// (ex2 a), a comma-separated CSV with a UTF-8 BOM so Excel shows ë/ç
// (ex3 a), Albanian headers in both files (ex5 a).
//
// Pure functions only: no Supabase, no Next.js. The two route handlers
// do the reading and the auth; this file only turns rows into text.

export type LedgerCsvRow = {
  entry_type: string;
  amount_minor: number;
  currency: string;
  gross_amount_minor: number | null;
  librum_amount_minor: number | null;
  royalty_rate_bps: number | null;
  created_at: string;
  book_title: string | null;
};

// cs1 a (11-27): the staff file names both the account (Autori) and the
// pen name the book is published under (Pseudonimi). A payout or an
// adjustment has no book, so its Pseudonimi cell is empty.
export type StaffLedgerCsvRow = LedgerCsvRow & { author_name: string | null; pen_name: string | null };

// The author's own Bilanci labels (balance-logic.ts ENTRY_TYPE_LABELS),
// plus payout_reversal, which the ledger CHECK allows but the Bilanci
// type does not list yet. Any other value is written as-is rather than
// dropped, so a new entry type can never silently vanish from a file.
const ENTRY_TYPE_LABELS: Record<string, string> = {
  sale: "Shitje",
  refund: "Rimbursim",
  payout: "Pagesë për autorin",
  payout_reversal: "Anulim i pagesës",
  adjustment: "Rregullim",
};

export function ledgerEntryLabel(entryType: string): string {
  return ENTRY_TYPE_LABELS[entryType] ?? entryType;
}

export const AUTHOR_LEDGER_CSV_HEADERS = [
  "Data",
  "Lloji",
  "Libri",
  "Çmimi i paguar",
  "Pjesa e Librum",
  "Pjesa juaj",
  "%",
  "Monedha",
] as const;

export const STAFF_LEDGER_CSV_HEADERS = [
  "Data",
  "Autori",
  "Pseudonimi",
  "Lloji",
  "Libri",
  "Çmimi i paguar",
  "Pjesa e Librum",
  "Pjesa e autorit",
  "%",
  "Monedha",
] as const;

// A file this big would pass Vercel's ~4.5 MB response limit. Failing
// with a clear message beats handing someone a cut-off file that looks
// complete.
export const MAX_LEDGER_CSV_ROWS = 30000;

const UTF8_BOM = "﻿";
const LINE_END = "\r\n";

// A text cell (book title, author name) that starts with = + - @ or a
// tab/CR would run as a formula when opened in Excel or Sheets ("CSV
// injection"). A leading apostrophe makes the spreadsheet show it as
// plain text. Numbers this file writes itself never go through here.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvTextCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// Minor units (qindarka/cents) to a plain number Excel reads as a
// number: a dot for decimals, no thousands separator, the ",00" dropped
// on whole amounts (50000 -> "500", 55930 -> "559.30", -13930 ->
// "-139.30"). String slicing on the integer, never a float division.
export function csvMinorAmount(minor: number | null): string {
  if (minor === null || minor === undefined) return "";
  if (!Number.isSafeInteger(minor)) throw new Error("ledger amount is not a safe integer");
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor)).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-2);
  return fraction === "00" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

// 7000 bps -> "70", 7550 -> "75.5", null -> "".
export function csvRatePercent(bps: number | null): string {
  if (bps === null || bps === undefined) return "";
  return String(bps / 100);
}

const TIRANA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Tirane",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// The row's Tirana calendar date as YYYY-MM-DD (en-CA formats it that
// way), like the Sales page's Tirana days -- a move at 00:30 Tirana
// time on the 1st is dated the 1st, not the server's UTC day before.
export function csvTiranaDate(value: string | Date): string {
  return TIRANA_DATE.format(new Date(value));
}

function moneyCells(row: LedgerCsvRow): string[] {
  return [
    csvMinorAmount(row.gross_amount_minor),
    csvMinorAmount(row.librum_amount_minor),
    csvMinorAmount(row.amount_minor),
    csvRatePercent(row.royalty_rate_bps),
    csvTextCell(row.currency),
  ];
}

function toCsv(headers: readonly string[], lines: string[][]): string {
  return UTF8_BOM + [headers.map(csvTextCell), ...lines].map((cells) => cells.join(",")).join(LINE_END) + LINE_END;
}

export function buildAuthorLedgerCsv(rows: LedgerCsvRow[]): string {
  return toCsv(
    AUTHOR_LEDGER_CSV_HEADERS,
    rows.map((row) => [
      csvTiranaDate(row.created_at),
      csvTextCell(ledgerEntryLabel(row.entry_type)),
      csvTextCell(row.book_title),
      ...moneyCells(row),
    ]),
  );
}

export function buildStaffLedgerCsv(rows: StaffLedgerCsvRow[]): string {
  return toCsv(
    STAFF_LEDGER_CSV_HEADERS,
    rows.map((row) => [
      csvTiranaDate(row.created_at),
      csvTextCell(row.author_name),
      csvTextCell(row.pen_name),
      csvTextCell(ledgerEntryLabel(row.entry_type)),
      csvTextCell(row.book_title),
      ...moneyCells(row),
    ]),
  );
}

export function ledgerCsvFilename(prefix: string, now: Date): string {
  return `${prefix}-${csvTiranaDate(now)}.csv`;
}

// A download, never cached anywhere: it is one person's money data.
export function ledgerCsvHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  };
}
