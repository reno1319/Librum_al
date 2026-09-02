import { describe, expect, it } from "vitest";
import {
  isValidRefundOperationalState,
  parseAttentionFilter,
  attentionFilterToParam,
  parseFinanceRefundQuery,
  parseFinanceDisputeQuery,
  encodeFinanceCursor,
  decodeFinanceCursor,
  buildFinanceHref,
  resolveFinancePage,
  FINANCE_DISPLAY_PAGE_SIZE,
  type FinanceCursor,
} from "./finance-query";

const VALID_ID = "f0000000-0000-0000-0000-000000000001";

describe("isValidRefundOperationalState", () => {
  it("accepts every real RefundOperationalState value", () => {
    const states = [
      "requested",
      "rejected",
      "refunded",
      "cancelled",
      "approved_unattempted",
      "approved_attempt_initiated",
      "approved_attempt_stale_initiated",
      "approved_attempt_unknown",
      "approved_attempt_failed",
      "approved_attempt_submitted",
    ];
    for (const state of states) {
      expect(isValidRefundOperationalState(state)).toBe(true);
    }
  });

  it("rejects an unrecognized value", () => {
    expect(isValidRefundOperationalState("some_future_state")).toBe(false);
    expect(isValidRefundOperationalState("")).toBe(false);
  });
});

describe("parseAttentionFilter", () => {
  it("defaults to 'true' for an absent value", () => {
    expect(parseAttentionFilter(undefined)).toBe("true");
  });

  it("defaults to 'true' for an invalid value, rather than passing it through", () => {
    expect(parseAttentionFilter("bogus")).toBe("true");
  });

  it("accepts 'false' and 'all' explicitly", () => {
    expect(parseAttentionFilter("false")).toBe("false");
    expect(parseAttentionFilter("all")).toBe("all");
  });
});

describe("attentionFilterToParam", () => {
  it("maps 'true'/'false' to their boolean, and 'all' to null (no filter)", () => {
    expect(attentionFilterToParam("true")).toBe(true);
    expect(attentionFilterToParam("false")).toBe(false);
    expect(attentionFilterToParam("all")).toBeNull();
  });
});

describe("parseFinanceRefundQuery", () => {
  it("defaults to attention='true', no state, no cursor, isFiltered=false, when no params are given", () => {
    const result = parseFinanceRefundQuery({});
    expect(result).toEqual({
      operationalState: null,
      attention: "true",
      cursor: null,
      isFiltered: false,
    });
  });

  it("accepts a valid refund_state", () => {
    const result = parseFinanceRefundQuery({ refund_state: "approved_unattempted" });
    expect(result.operationalState).toBe("approved_unattempted");
    expect(result.isFiltered).toBe(true);
  });

  it("drops an invalid refund_state rather than passing it through", () => {
    const result = parseFinanceRefundQuery({ refund_state: "not_a_real_state" });
    expect(result.operationalState).toBeNull();
    expect(result.isFiltered).toBe(false);
  });

  it("an explicit refund_attention=all is filtered (even though it changes nothing about the RPC call vs. default 'true' being absent)", () => {
    const result = parseFinanceRefundQuery({ refund_attention: "all" });
    expect(result.attention).toBe("all");
    expect(result.isFiltered).toBe(true);
  });

  it("a valid refund_cursor decodes and marks isFiltered", () => {
    const cursor: FinanceCursor = { sortValue: "2026-01-01T00:00:00.000Z", id: VALID_ID };
    const encoded = encodeFinanceCursor(cursor);
    const result = parseFinanceRefundQuery({ refund_cursor: encoded });
    expect(result.cursor).toEqual(cursor);
    expect(result.isFiltered).toBe(true);
  });

  it("never throws for any combination of missing/invalid values", () => {
    expect(() =>
      parseFinanceRefundQuery({
        refund_state: "bogus",
        refund_attention: "bogus",
        refund_cursor: "bogus",
      }),
    ).not.toThrow();
  });
});

describe("parseFinanceDisputeQuery", () => {
  it("defaults to attention='true', no cursor, isFiltered=false, when no params are given", () => {
    const result = parseFinanceDisputeQuery({});
    expect(result).toEqual({ attention: "true", cursor: null, isFiltered: false });
  });

  it("accepts dispute_attention=false and marks isFiltered", () => {
    const result = parseFinanceDisputeQuery({ dispute_attention: "false" });
    expect(result.attention).toBe("false");
    expect(result.isFiltered).toBe(true);
  });

  it("a valid dispute_cursor decodes and marks isFiltered", () => {
    const cursor: FinanceCursor = { sortValue: "2026-01-01T00:00:00.000Z", id: VALID_ID };
    const encoded = encodeFinanceCursor(cursor);
    const result = parseFinanceDisputeQuery({ dispute_cursor: encoded });
    expect(result.cursor).toEqual(cursor);
    expect(result.isFiltered).toBe(true);
  });

  it("a refund_* param never affects the dispute query -- independent key prefixes", () => {
    const result = parseFinanceDisputeQuery({
      refund_state: "approved_unattempted",
      refund_attention: "all",
      refund_cursor: encodeFinanceCursor({ sortValue: "2026-01-01T00:00:00.000Z", id: VALID_ID }),
    });
    expect(result).toEqual({ attention: "true", cursor: null, isFiltered: false });
  });
});

describe("encodeFinanceCursor / decodeFinanceCursor", () => {
  it("round-trips a valid cursor", () => {
    const cursor: FinanceCursor = { sortValue: "2026-03-14T12:00:00.000Z", id: VALID_ID };
    expect(decodeFinanceCursor(encodeFinanceCursor(cursor))).toEqual(cursor);
  });

  it("null/undefined/empty decode to null", () => {
    expect(decodeFinanceCursor(null)).toBeNull();
    expect(decodeFinanceCursor(undefined)).toBeNull();
    expect(decodeFinanceCursor("")).toBeNull();
  });

  it("a malformed cursor decodes to null rather than throwing", () => {
    expect(() => decodeFinanceCursor("garbage!!!")).not.toThrow();
    expect(decodeFinanceCursor("garbage!!!")).toBeNull();
  });

  it("a cursor with an invalid id (not a UUID) decodes to null", () => {
    const json = JSON.stringify({ s: "2026-01-01T00:00:00.000Z", i: "not-a-uuid" });
    const encoded = Buffer.from(json, "utf8").toString("base64url");
    expect(decodeFinanceCursor(encoded)).toBeNull();
  });

  it("a cursor with an unparseable sortValue decodes to null", () => {
    const json = JSON.stringify({ s: "not-a-date", i: VALID_ID });
    const encoded = Buffer.from(json, "utf8").toString("base64url");
    expect(decodeFinanceCursor(encoded)).toBeNull();
  });

  it("a cursor missing a required field decodes to null", () => {
    const json = JSON.stringify({ s: "2026-01-01T00:00:00.000Z" });
    const encoded = Buffer.from(json, "utf8").toString("base64url");
    expect(decodeFinanceCursor(encoded)).toBeNull();
  });
});

describe("buildFinanceHref", () => {
  it("returns the bare path when no params are active", () => {
    expect(buildFinanceHref({}, {})).toBe("/admin/finance");
  });

  it("preserves existing filters across all three sections while adding one override", () => {
    const href = buildFinanceHref(
      { refund_state: "approved_unattempted", dispute_attention: "false", checkout_cursor: "tok" },
      { refund_cursor: "next-token" },
    );
    expect(href).toContain("refund_state=approved_unattempted");
    expect(href).toContain("dispute_attention=false");
    expect(href).toContain("checkout_cursor=tok");
    expect(href).toContain("refund_cursor=next-token");
  });

  it("advancing one section's cursor never disturbs another section's own cursor/filter", () => {
    const current = {
      refund_cursor: "refund-page-2",
      dispute_cursor: "dispute-page-3",
      checkout_cursor: "checkout-page-1",
    };
    const href = buildFinanceHref(current, { dispute_cursor: "dispute-page-4" });
    expect(href).toContain("refund_cursor=refund-page-2");
    expect(href).toContain("dispute_cursor=dispute-page-4");
    expect(href).not.toContain("dispute_cursor=dispute-page-3");
    expect(href).toContain("checkout_cursor=checkout-page-1");
  });

  it("an override of undefined removes that param entirely", () => {
    const href = buildFinanceHref({ refund_state: "requested", refund_cursor: "old" }, { refund_cursor: undefined });
    expect(href).not.toContain("refund_cursor=");
    expect(href).toContain("refund_state=requested");
  });
});

// Lookahead pagination -- same required matrix as resolveAuditPage:
// 0, 1, 24, 25 (exactly at boundary, no Next), 26 (one over, Next shown,
// cursor from row 25 not row 26). Exercised generically via a minimal
// row shape since resolveFinancePage is used across three different row
// types in page.tsx.
describe("resolveFinancePage", () => {
  type Row = { id: string; sortValue: string };

  function makeRows(n: number): Row[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `f0000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      sortValue: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));
  }

  const getCursorFields = (row: Row): FinanceCursor => ({ sortValue: row.sortValue, id: row.id });

  it("0 rows: displays nothing, no Next", () => {
    const result = resolveFinancePage(makeRows(0), getCursorFields);
    expect(result.rows).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("1 row: displays it, no Next", () => {
    const result = resolveFinancePage(makeRows(1), getCursorFields);
    expect(result.rows).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("24 rows (well under the page size): displays all 24, no Next", () => {
    const result = resolveFinancePage(makeRows(24), getCursorFields);
    expect(result.rows).toHaveLength(24);
    expect(result.nextCursor).toBeNull();
  });

  it("exactly FINANCE_DISPLAY_PAGE_SIZE (25) rows: displays all 25, NO Next", () => {
    const rows = makeRows(FINANCE_DISPLAY_PAGE_SIZE);
    const result = resolveFinancePage(rows, getCursorFields);
    expect(result.rows).toHaveLength(FINANCE_DISPLAY_PAGE_SIZE);
    expect(result.rows).toEqual(rows);
    expect(result.nextCursor).toBeNull();
  });

  it("FINANCE_DISPLAY_PAGE_SIZE + 1 (26) rows: displays only the first 25, and shows Next", () => {
    const rows = makeRows(FINANCE_DISPLAY_PAGE_SIZE + 1);
    const result = resolveFinancePage(rows, getCursorFields);
    expect(result.rows).toHaveLength(FINANCE_DISPLAY_PAGE_SIZE);
    expect(result.rows).toEqual(rows.slice(0, FINANCE_DISPLAY_PAGE_SIZE));
    expect(result.nextCursor).not.toBeNull();
  });

  it("the 26th (lookahead) row is never rendered", () => {
    const rows = makeRows(FINANCE_DISPLAY_PAGE_SIZE + 1);
    const lookaheadRow = rows[FINANCE_DISPLAY_PAGE_SIZE];
    const result = resolveFinancePage(rows, getCursorFields);
    expect(result.rows.some((r) => r.id === lookaheadRow.id)).toBe(false);
  });

  it("the next cursor is derived from row 25 (the last DISPLAYED row), not row 26 (the lookahead row)", () => {
    const rows = makeRows(FINANCE_DISPLAY_PAGE_SIZE + 1);
    const row25 = rows[FINANCE_DISPLAY_PAGE_SIZE - 1];
    const row26 = rows[FINANCE_DISPLAY_PAGE_SIZE];
    const result = resolveFinancePage(rows, getCursorFields);

    const expectedFromRow25 = encodeFinanceCursor(getCursorFields(row25));
    const wouldBeFromRow26 = encodeFinanceCursor(getCursorFields(row26));

    expect(result.nextCursor).toBe(expectedFromRow25);
    expect(result.nextCursor).not.toBe(wouldBeFromRow26);
  });

  it("never uses OFFSET semantics -- a custom displayPageSize is honored exactly", () => {
    const rows = makeRows(5);
    const result = resolveFinancePage(rows, getCursorFields, 3);
    expect(result.rows).toHaveLength(3);
    expect(result.nextCursor).not.toBeNull();
  });
});
