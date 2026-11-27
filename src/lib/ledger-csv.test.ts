import { describe, expect, it } from "vitest";
import {
  AUTHOR_LEDGER_CSV_HEADERS,
  STAFF_LEDGER_CSV_HEADERS,
  buildAuthorLedgerCsv,
  buildStaffLedgerCsv,
  csvMinorAmount,
  csvRatePercent,
  csvTextCell,
  csvTiranaDate,
  ledgerCsvFilename,
  ledgerCsvHeaders,
  ledgerEntryLabel,
  type LedgerCsvRow,
} from "./ledger-csv";

// CSV-1 (idea 35): the text of the two ledger downloads.

const SALE: LedgerCsvRow = {
  entry_type: "sale",
  amount_minor: 55930,
  currency: "ALL",
  gross_amount_minor: 79900,
  librum_amount_minor: 23970,
  royalty_rate_bps: 7000,
  created_at: "2026-11-24T10:00:00Z",
  book_title: "Dimri në Tiranë",
};

describe("csvMinorAmount", () => {
  it("writes lek with a dot for qindarka and drops ,00 on whole amounts", () => {
    expect(csvMinorAmount(50000)).toBe("500");
    expect(csvMinorAmount(55930)).toBe("559.30");
    expect(csvMinorAmount(-13930)).toBe("-139.30");
    expect(csvMinorAmount(150000000)).toBe("1500000");
    expect(csvMinorAmount(5)).toBe("0.05");
    expect(csvMinorAmount(-5)).toBe("-0.05");
    expect(csvMinorAmount(0)).toBe("0");
  });
  it("leaves a missing amount empty", () => {
    expect(csvMinorAmount(null)).toBe("");
  });
  it("refuses a non-integer amount instead of guessing", () => {
    expect(() => csvMinorAmount(1.5)).toThrow();
  });
});

describe("csvRatePercent", () => {
  it("turns basis points into a percent", () => {
    expect(csvRatePercent(7000)).toBe("70");
    expect(csvRatePercent(5000)).toBe("50");
    expect(csvRatePercent(7550)).toBe("75.5");
    expect(csvRatePercent(null)).toBe("");
  });
});

describe("csvTiranaDate", () => {
  it("dates a move by its Tirana day, not the UTC day", () => {
    // 23:30 UTC on 30 Nov is 00:30 on 1 Dec in Tirana (UTC+1).
    expect(csvTiranaDate("2026-11-30T23:30:00Z")).toBe("2026-12-01");
    expect(csvTiranaDate("2026-11-30T22:30:00Z")).toBe("2026-11-30");
    // Summer time (UTC+2).
    expect(csvTiranaDate("2026-07-31T22:30:00Z")).toBe("2026-08-01");
  });
});

describe("csvTextCell", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvTextCell("Plain")).toBe("Plain");
    expect(csvTextCell("Ujku, dhe qengji")).toBe('"Ujku, dhe qengji"');
    expect(csvTextCell('Ai tha "po"')).toBe('"Ai tha ""po"""');
    expect(csvTextCell("Dy\nrreshta")).toBe('"Dy\nrreshta"');
  });
  it("keeps ë and ç as they are", () => {
    expect(csvTextCell("Çelësi i ëndrrave")).toBe("Çelësi i ëndrrave");
  });
  it("stops a title or name from running as a spreadsheet formula", () => {
    expect(csvTextCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvTextCell("+1")).toBe("'+1");
    expect(csvTextCell("-2")).toBe("'-2");
    expect(csvTextCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvTextCell("\tx")).toBe("'\tx");
  });
  it("leaves a missing value empty", () => {
    expect(csvTextCell(null)).toBe("");
    expect(csvTextCell(undefined)).toBe("");
  });
});

describe("ledgerEntryLabel", () => {
  it("uses the Bilanci words and never drops an unknown type", () => {
    expect(ledgerEntryLabel("sale")).toBe("Shitje");
    expect(ledgerEntryLabel("refund")).toBe("Rimbursim");
    expect(ledgerEntryLabel("payout")).toBe("Pagesë për autorin");
    expect(ledgerEntryLabel("adjustment")).toBe("Rregullim");
    expect(ledgerEntryLabel("payout_reversal")).toBe("Anulim i pagesës");
    expect(ledgerEntryLabel("something_new")).toBe("something_new");
  });
});

describe("buildAuthorLedgerCsv", () => {
  it("starts with a UTF-8 BOM and the Albanian headers, CRLF lines", () => {
    const csv = buildAuthorLedgerCsv([]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe("﻿" + AUTHOR_LEDGER_CSV_HEADERS.join(",") + "\r\n");
    expect(AUTHOR_LEDGER_CSV_HEADERS).toEqual([
      "Data",
      "Lloji",
      "Libri",
      "Çmimi i paguar",
      "Pjesa e Librum",
      "Pjesa juaj",
      "%",
      "Monedha",
    ]);
  });
  it("writes each ledger row with the split stored on it, untouched", () => {
    const refund: LedgerCsvRow = {
      entry_type: "refund",
      amount_minor: -13930,
      currency: "ALL",
      gross_amount_minor: null,
      librum_amount_minor: null,
      royalty_rate_bps: null,
      created_at: "2026-11-17T09:00:00Z",
      book_title: "Kujtimet e detit",
    };
    const payout: LedgerCsvRow = { ...refund, entry_type: "payout", amount_minor: -150000, book_title: null };
    const lines = buildAuthorLedgerCsv([SALE, refund, payout]).slice(1).split("\r\n");
    expect(lines[1]).toBe("2026-11-24,Shitje,Dimri në Tiranë,799,239.70,559.30,70,ALL");
    expect(lines[2]).toBe("2026-11-17,Rimbursim,Kujtimet e detit,,,-139.30,,ALL");
    expect(lines[3]).toBe("2026-11-17,Pagesë për autorin,,,,-1500,,ALL");
    expect(lines[4]).toBe("");
    expect(lines).toHaveLength(5);
  });
});

describe("buildStaffLedgerCsv", () => {
  it("adds the account name and the pen name after the date, with the staff headers", () => {
    const csv = buildStaffLedgerCsv([{ ...SALE, author_name: "Arta, Provë", pen_name: "A. T. Hija" }]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(STAFF_LEDGER_CSV_HEADERS.join(","));
    expect(STAFF_LEDGER_CSV_HEADERS[1]).toBe("Autori");
    expect(STAFF_LEDGER_CSV_HEADERS[2]).toBe("Pseudonimi");
    expect(STAFF_LEDGER_CSV_HEADERS[7]).toBe("Pjesa e autorit");
    expect(lines[1]).toBe('2026-11-24,"Arta, Provë",A. T. Hija,Shitje,Dimri në Tiranë,799,239.70,559.30,70,ALL');
  });
});

describe("download headers", () => {
  it("is a never-cached CSV attachment named by the Tirana date", () => {
    expect(ledgerCsvFilename("librum-bilanci", new Date("2026-11-30T23:30:00Z"))).toBe("librum-bilanci-2026-12-01.csv");
    const headers = ledgerCsvHeaders("x.csv");
    expect(headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(headers["Content-Disposition"]).toBe('attachment; filename="x.csv"');
    expect(headers["Cache-Control"]).toBe("no-store, max-age=0");
  });
});
