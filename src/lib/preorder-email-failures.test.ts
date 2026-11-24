import { describe, expect, it } from "vitest";
import {
  failureLineStart,
  failureReaderName,
  failureReason,
  isUuid,
  parsePreorderEmailFailureRows,
} from "./preorder-email-failures";

const BOOK = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const good = {
  book_id: BOOK,
  user_id: USER,
  book_title: "Pan",
  reader_name: "Arta",
  email_kind: "released",
  send_failure: "address_refused",
  send_failed_at: "2026-11-24T07:05:00Z",
};

describe("preorder email failures", () => {
  it("reads a good row", () => {
    expect(parsePreorderEmailFailureRows([good])).toEqual([
      {
        bookId: BOOK,
        userId: USER,
        bookTitle: "Pan",
        readerName: "Arta",
        emailKind: "released",
        failure: "address_refused",
        failedAt: "2026-11-24T07:05:00Z",
      },
    ]);
  });

  it("drops malformed rows and non-arrays", () => {
    expect(parsePreorderEmailFailureRows(null)).toEqual([]);
    expect(parsePreorderEmailFailureRows({})).toEqual([]);
    const bad = [
      null,
      { ...good, book_id: "x" },
      { ...good, user_id: 5 },
      { ...good, book_title: null },
      { ...good, reader_name: 1 },
      { ...good, email_kind: "moved" },
      { ...good, send_failure: "other" },
      { ...good, send_failed_at: "not a date" },
    ];
    expect(parsePreorderEmailFailureRows(bad)).toEqual([]);
    expect(parsePreorderEmailFailureRows([{ ...good, reader_name: null }])).toHaveLength(1);
  });

  it("builds the lines", () => {
    const [row] = parsePreorderEmailFailureRows([good]);
    expect(failureLineStart(row)).toBe("“Pan”: the “book is out” email to");
    expect(failureLineStart({ ...row, emailKind: "cancelled" })).toBe("“Pan”: the “pre-order cancelled” email to");
    expect(failureReaderName(row)).toBe("Arta");
    expect(failureReaderName({ ...row, readerName: null })).toBe("a reader");
    expect(failureReaderName({ ...row, readerName: "  " })).toBe("a reader");
    expect(failureReason("address_refused")).toMatch(/won’t be tried again/);
    expect(failureReason("unclear")).toMatch(/may have arrived/);
    expect(failureReason("batch_refused")).toMatch(/tries again tomorrow/);
  });

  it("checks ids", () => {
    expect(isUuid(BOOK)).toBe(true);
    expect(isUuid("x")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});
