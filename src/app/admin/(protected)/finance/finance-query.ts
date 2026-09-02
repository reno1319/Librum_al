// ADMIN-1D PART C: pure, DB/Next.js-free URL-query and pagination
// helpers for the /admin/finance page -- the same "future page.tsx's own
// concern" split ../audit/audit-query.ts already established relative to
// its own committed Part B contract file (finance-logic.ts here). Kept
// separate from finance-logic.ts (the reviewed, committed ADMIN-1D
// Part B contract) so that file's finalized content stays untouched by
// this pass.
//
// GET form -> URL search params -> Server Component rerender, no client
// fetching -- every filter here is server-side, shareable, and
// bookmarkable, matching ../audit/page.tsx's own established pattern.
// /admin/finance has THREE independently-paginated sections (refunds,
// disputes, checkout exceptions) sharing one query string, so every
// helper below is scoped by an explicit prefix (refund_/dispute_/
// checkout_) rather than reusing bare "cursor"/"attention" keys that
// would collide across sections.

import type { RefundOperationalState } from "@/lib/types";

export type FinanceRawSearchParams = {
  refund_state?: string;
  refund_attention?: string;
  refund_cursor?: string;
  dispute_attention?: string;
  dispute_cursor?: string;
  checkout_cursor?: string;
};

const REFUND_OPERATIONAL_STATES: readonly RefundOperationalState[] = [
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

export function isValidRefundOperationalState(value: string): value is RefundOperationalState {
  return (REFUND_OPERATIONAL_STATES as readonly string[]).includes(value);
}

// Three-way attention filter, applied identically to both the refund and
// dispute sections: "true" (the default -- ALSO what an absent/invalid
// value resolves to, per this codebase's established graceful-fallback
// convention) shows only needs_attention=true rows; "false" shows only
// needs_attention=false rows; "all" shows every row regardless. This is
// a deliberate three-state choice, not a plain boolean, specifically so
// the page can default to an attention-first view (ADMIN-1D Part C's own
// design brief) while still letting staff explicitly see the complete
// list -- "all" is a real, reachable, bookmarkable URL state, never a
// hidden/inaccessible one.
export type AttentionFilterValue = "true" | "false" | "all";

export function parseAttentionFilter(raw: string | undefined): AttentionFilterValue {
  if (raw === "false" || raw === "all") return raw;
  return "true";
}

// null = no filter (RPC's own p_needs_attention default); true/false map
// directly. Never recomputes needs_attention itself -- this only decides
// which value to pass as a FILTER to the already-authoritative RPC.
export function attentionFilterToParam(value: AttentionFilterValue): boolean | null {
  if (value === "all") return null;
  return value === "true";
}

export type ParsedFinanceRefundQuery = {
  operationalState: RefundOperationalState | null;
  attention: AttentionFilterValue;
  cursor: FinanceCursor | null;
  isFiltered: boolean;
};

export function parseFinanceRefundQuery(raw: FinanceRawSearchParams): ParsedFinanceRefundQuery {
  const operationalState =
    raw.refund_state && isValidRefundOperationalState(raw.refund_state) ? raw.refund_state : null;
  const attention = parseAttentionFilter(raw.refund_attention);
  const cursor = decodeFinanceCursor(raw.refund_cursor);

  return {
    operationalState,
    attention,
    cursor,
    isFiltered: Boolean(operationalState || raw.refund_attention || cursor),
  };
}

export type ParsedFinanceDisputeQuery = {
  attention: AttentionFilterValue;
  cursor: FinanceCursor | null;
  isFiltered: boolean;
};

export function parseFinanceDisputeQuery(raw: FinanceRawSearchParams): ParsedFinanceDisputeQuery {
  const attention = parseAttentionFilter(raw.dispute_attention);
  const cursor = decodeFinanceCursor(raw.dispute_cursor);

  return {
    attention,
    cursor,
    isFiltered: Boolean(raw.dispute_attention || cursor),
  };
}

// ============================================================
// Keyset cursor -- generic {sortValue, id} pair, base64url-encoded JSON,
// same technique as ../audit/audit-log-logic.ts's encodeAuditCursor/
// decodeAuditCursor (Buffer base64url, short key names, strict decode
// validation), generalized here since finance's three paginated sections
// key on three DIFFERENT timestamp columns (requested_at/created_at/
// completed_at) rather than audit's single created_at -- "sortValue" is
// deliberately generic rather than named after any one of them.
// ============================================================

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FinanceCursor = { sortValue: string; id: string };

export function encodeFinanceCursor(cursor: FinanceCursor): string {
  const json = JSON.stringify({ s: cursor.sortValue, i: cursor.id });
  return Buffer.from(json, "utf8").toString("base64url");
}

// Never throws -- a malformed/hand-edited cursor always decodes to null
// (treated as "first page"), matching decodeAuditCursor's exact posture.
export function decodeFinanceCursor(raw: string | null | undefined): FinanceCursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "s" in parsed &&
      "i" in parsed &&
      typeof (parsed as { s: unknown }).s === "string" &&
      typeof (parsed as { i: unknown }).i === "string"
    ) {
      const sortValue = (parsed as { s: string }).s;
      const id = (parsed as { i: string }).i;
      if (Number.isNaN(new Date(sortValue).getTime()) || !UUID_PATTERN.test(id)) {
        return null;
      }
      return { sortValue, id };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Href building -- one shared function covering every param across all
// three sections, mirroring buildAuditHref's exact shape. Each section's
// own "Next" link overrides only its own cursor key, leaving every other
// active filter/cursor (including the OTHER two sections' own state)
// untouched -- so advancing the refund list's page can never accidentally
// reset the dispute or checkout sections' own current page.
// ============================================================

const QUERY_KEYS = [
  "refund_state",
  "refund_attention",
  "refund_cursor",
  "dispute_attention",
  "dispute_cursor",
  "checkout_cursor",
] as const;

export function buildFinanceHref(
  current: FinanceRawSearchParams,
  overrides: Partial<FinanceRawSearchParams>,
): string {
  const merged: FinanceRawSearchParams = { ...current, ...overrides };
  const params = new URLSearchParams();

  for (const key of QUERY_KEYS) {
    const value = merged[key];
    if (value) params.set(key, value);
  }

  const qs = params.toString();
  return qs ? `/admin/finance?${qs}` : "/admin/finance";
}

// ============================================================
// Lookahead pagination -- same technique as resolveAuditPage
// (../audit/audit-query.ts): the caller requests FINANCE_DISPLAY_PAGE_SIZE
// + 1 rows; this function is the ONLY place that decides what's actually
// shown. <= displayPageSize fetched proves there is nothing further (no
// Next); exactly displayPageSize + 1 fetched means only the first
// displayPageSize are ever rendered, and the lookahead row is used
// SOLELY to derive nextCursor from the LAST DISPLAYED row -- never
// rendered itself. No OFFSET, no total-count query, generic over row
// shape via getCursorFields so all three sections (refund/dispute/
// checkout, three different row types) share this one implementation.
// ============================================================

export const FINANCE_DISPLAY_PAGE_SIZE = 25;

export type FinancePageResult<T> = {
  rows: T[];
  nextCursor: string | null;
};

export function resolveFinancePage<T>(
  fetchedRows: T[],
  getCursorFields: (row: T) => FinanceCursor,
  displayPageSize: number = FINANCE_DISPLAY_PAGE_SIZE,
): FinancePageResult<T> {
  if (fetchedRows.length <= displayPageSize) {
    return { rows: fetchedRows, nextCursor: null };
  }

  const rows = fetchedRows.slice(0, displayPageSize);
  const lastDisplayedRow = rows[rows.length - 1];
  return {
    rows,
    nextCursor: encodeFinanceCursor(getCursorFields(lastDisplayedRow)),
  };
}
