// LIBRUM 2.0 ADMIN-1C PART C: pure, DB/Next.js-free URL-query helpers
// for the /admin/audit page -- the exact "future page.tsx's own concern"
// audit-log-logic.ts's own header comment deferred, extracted the same
// way src/lib/bookstore.ts's parseBookstoreQuery()/buildBookstoreHref()
// were pulled out of src/app/bookstore/page.tsx. Kept in a separate file
// from audit-log-logic.ts (the committed ADMIN-1C Part B contract)
// rather than added into it, so that file's own reviewed, finalized
// content stays untouched by this pass.
//
// GET form -> URL search params -> Server Component rerender, no client
// fetching -- every filter here is server-side, shareable, and
// bookmarkable, matching this app's own established filter pattern
// (bookstore) rather than introducing a client-side data-fetching layer
// admin pages don't otherwise use.

import {
  isValidAuditAction,
  isValidAuditTargetType,
  validateAuditDateFilter,
  resolveAuditToDateFilter,
  decodeAuditCursor,
  encodeAuditCursor,
  type AuditCursor,
} from "./audit-log-logic";
import type { AuditEventRow } from "@/lib/types";

// Raw, unvalidated shape straight from Next's searchParams -- a URL can
// contain anything, including a hand-edited or stale value, so every
// field here is a plain optional string.
export type AuditRawSearchParams = {
  action?: string;
  actor?: string;
  target_type?: string;
  from?: string;
  to?: string;
  cursor?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAuditActorId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export type ParsedAuditQuery = {
  action: string | null;
  actorId: string | null;
  targetType: string | null;
  createdAfter: string | null;
  createdBefore: string | null;
  cursor: AuditCursor | null;
  dateRangeError: string | null;
  isFiltered: boolean;
};

// Never throws, and never passes an unvalidated value through to the
// RPC -- every filter is independently checked against the SAME allow-
// list/format list_admin_audit_events() (migration 042) itself enforces.
// A value that fails validation is DROPPED (falls back to "no filter for
// that dimension") rather than either crashing the page or forwarding
// garbage server-side -- a mistyped/stale action, target_type, actor, or
// cursor in a hand-edited URL simply yields the unfiltered-by-that-
// dimension view, same graceful-fallback posture already established by
// this codebase's isKnownBookstoreSort()/decodeAuditCursor().
//
// The one deliberate exception is a REVERSED from/to date pair: that
// gets the dedicated, already-authored error message (dateRangeError)
// list_admin_audit_events()'s own 'invalid date range' rejection already
// has copy for (mapAuditRpcError, audit-log-logic.ts), shown up front
// rather than silently dropping one side -- a wasted round trip to the
// RPC would only return that exact same message anyway, and silently
// dropping one date would leave an admin looking at results they didn't
// actually ask for without any explanation.
export function parseAuditQuery(raw: AuditRawSearchParams): ParsedAuditQuery {
  const action = raw.action && isValidAuditAction(raw.action) ? raw.action : null;
  const targetType = raw.target_type && isValidAuditTargetType(raw.target_type) ? raw.target_type : null;
  const actorId = raw.actor && isValidAuditActorId(raw.actor) ? raw.actor : null;

  const fromResult = validateAuditDateFilter(raw.from);
  const toResult = resolveAuditToDateFilter(raw.to);
  const createdAfter = fromResult.ok ? fromResult.value : null;
  const createdBefore = toResult.ok ? toResult.value : null;

  const dateRangeError =
    createdAfter && createdBefore && createdAfter >= createdBefore
      ? "The start date must be before the end date."
      : null;

  const cursor = decodeAuditCursor(raw.cursor);

  return {
    action,
    actorId,
    targetType,
    createdAfter,
    createdBefore,
    cursor,
    dateRangeError,
    isFiltered: Boolean(
      action || actorId || targetType || createdAfter || createdBefore || cursor,
    ),
  };
}

const QUERY_KEYS = ["action", "actor", "target_type", "from", "to", "cursor"] as const;

// Builds an /admin/audit?... href starting from the CURRENT raw query
// params, with `overrides` applied on top -- an override of `undefined`
// removes that param entirely. The only caller in this file's sibling
// page.tsx is the "Next" pagination link (overrides cursor, keeps every
// active filter) -- mirrors buildBookstoreHref's exact same shape and
// reasoning (src/lib/bookstore.ts).
export function buildAuditHref(
  current: AuditRawSearchParams,
  overrides: Partial<AuditRawSearchParams>,
): string {
  const merged: AuditRawSearchParams = { ...current, ...overrides };
  const params = new URLSearchParams();

  for (const key of QUERY_KEYS) {
    const value = merged[key];
    if (value) params.set(key, value);
  }

  const qs = params.toString();
  return qs ? `/admin/audit?${qs}` : "/admin/audit";
}

// ADMIN-1C Part C FINAL PRE-COMMIT UI CORRECTION: the actual number of
// rows ever shown on one page. Deliberately its OWN constant, not
// audit-log-logic.ts's AUDIT_LIST_DEFAULT_LIMIT (which mirrors the RPC's
// own default p_limit when the caller omits it entirely, a DIFFERENT
// concept this page never actually relies on -- it always passes an
// explicit limit). Conflating the two would make this page's display
// size silently track a future change to the RPC's own unrelated
// default.
export const AUDIT_DISPLAY_PAGE_SIZE = 25;

export type AuditPageResult = {
  rows: AuditEventRow[];
  nextCursor: string | null;
};

// ADMIN-1C Part C FINAL PRE-COMMIT UI CORRECTION: lookahead pagination,
// replacing the prior "Next whenever exactly `limit` rows came back"
// heuristic -- that produced a FALSE Next whenever the true remaining
// count was an exact multiple of the page size (indistinguishable, from
// that heuristic's own point of view, from "there really is more").
//
// The caller (page.tsx) requests AUDIT_DISPLAY_PAGE_SIZE + 1 rows from
// listAdminAuditEvents(). This function is the ONLY place that decides
// what actually gets shown:
//   <= AUDIT_DISPLAY_PAGE_SIZE fetched -- the fetch itself already proves
//     there is nothing further (an extra row would have been fetched had
//     one existed) -- show everything fetched, no Next. This is now a
//     CONFIRMED fact, not a guess.
//   AUDIT_DISPLAY_PAGE_SIZE + 1 fetched -- only the first
//     AUDIT_DISPLAY_PAGE_SIZE are ever displayed; the extra (last
//     fetched) row is lookahead evidence ONLY, proving more exists, and
//     is never rendered. The next cursor is derived from the LAST
//     DISPLAYED row (index AUDIT_DISPLAY_PAGE_SIZE - 1), not the
//     lookahead row -- continuing keyset pagination from exactly where
//     display stopped, so the next page starts immediately after the
//     last row a human actually saw, with nothing skipped or repeated.
// No OFFSET, no total-count query -- this is still pure keyset
// pagination, just fed one extra row of foresight.
export function resolveAuditPage(
  fetchedRows: AuditEventRow[],
  displayPageSize: number = AUDIT_DISPLAY_PAGE_SIZE,
): AuditPageResult {
  if (fetchedRows.length <= displayPageSize) {
    return { rows: fetchedRows, nextCursor: null };
  }

  const rows = fetchedRows.slice(0, displayPageSize);
  const lastDisplayedRow = rows[rows.length - 1];
  return {
    rows,
    nextCursor: encodeAuditCursor({
      createdAt: lastDisplayedRow.created_at,
      id: lastDisplayedRow.id,
    }),
  };
}
