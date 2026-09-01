import { describe, expect, it } from "vitest";
import { encodeAuditCursor } from "./audit-log-logic";
import {
  parseAuditQuery,
  buildAuditHref,
  resolveAuditPage,
  AUDIT_DISPLAY_PAGE_SIZE,
  isValidAuditActorId,
} from "./audit-query";
import type { AuditEventRow } from "@/lib/types";

const VALID_ACTOR_ID = "f0000000-0000-0000-0000-000000000001";

describe("isValidAuditActorId", () => {
  it("accepts a well-formed UUID", () => {
    expect(isValidAuditActorId(VALID_ACTOR_ID)).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    expect(isValidAuditActorId("not-a-uuid")).toBe(false);
    expect(isValidAuditActorId("")).toBe(false);
  });
});

describe("parseAuditQuery", () => {
  it("defaults every field to null/false when no params are given", () => {
    const result = parseAuditQuery({});
    expect(result).toEqual({
      action: null,
      actorId: null,
      targetType: null,
      createdAfter: null,
      createdBefore: null,
      cursor: null,
      dateRangeError: null,
      isFiltered: false,
    });
  });

  it("accepts a valid action", () => {
    const result = parseAuditQuery({ action: "staff.added" });
    expect(result.action).toBe("staff.added");
    expect(result.isFiltered).toBe(true);
  });

  it("drops an invalid action rather than passing it through", () => {
    const result = parseAuditQuery({ action: "staff.promoted" });
    expect(result.action).toBeNull();
    expect(result.isFiltered).toBe(false);
  });

  it("accepts a valid target type", () => {
    const result = parseAuditQuery({ target_type: "refund_requests" });
    expect(result.targetType).toBe("refund_requests");
    expect(result.isFiltered).toBe(true);
  });

  it("drops an invalid target type rather than passing it through", () => {
    const result = parseAuditQuery({ target_type: "purchases" });
    expect(result.targetType).toBeNull();
    expect(result.isFiltered).toBe(false);
  });

  it("accepts a valid actor UUID", () => {
    const result = parseAuditQuery({ actor: VALID_ACTOR_ID });
    expect(result.actorId).toBe(VALID_ACTOR_ID);
    expect(result.isFiltered).toBe(true);
  });

  it("drops an invalid actor UUID rather than passing it through", () => {
    const result = parseAuditQuery({ actor: "not-a-uuid" });
    expect(result.actorId).toBeNull();
    expect(result.isFiltered).toBe(false);
  });

  it("accepts a valid from/to date pair, from inclusive and to exclusive-next-day", () => {
    const result = parseAuditQuery({ from: "2026-01-01", to: "2026-01-31" });
    expect(result.createdAfter).toBe(new Date("2026-01-01T00:00:00.000Z").toISOString());
    expect(result.createdBefore).toBe(new Date("2026-02-01T00:00:00.000Z").toISOString());
    expect(result.dateRangeError).toBeNull();
    expect(result.isFiltered).toBe(true);
  });

  it("drops an invalid/unparseable date rather than passing it through", () => {
    const result = parseAuditQuery({ from: "not-a-date" });
    expect(result.createdAfter).toBeNull();
    expect(result.dateRangeError).toBeNull();
    expect(result.isFiltered).toBe(false);
  });

  it("flags a reversed date range with a controlled error, without crashing", () => {
    const result = parseAuditQuery({ from: "2026-02-01", to: "2026-01-01" });
    expect(result.dateRangeError).toBe("The start date must be before the end date.");
  });

  it("flags an equal from/to pair as reversed too (a zero-width range)", () => {
    // from=2026-01-01 -> createdAfter = 2026-01-01T00:00:00Z (inclusive)
    // to=2025-12-31   -> createdBefore = 2026-01-01T00:00:00Z (exclusive)
    // These resolve to the identical instant, which must be rejected the
    // same way the RPC's own `p_created_after >= p_created_before` would.
    const result = parseAuditQuery({ from: "2026-01-01", to: "2025-12-31" });
    expect(result.dateRangeError).toBe("The start date must be before the end date.");
  });

  it("missing from/to values produce no error and no date filters", () => {
    const result = parseAuditQuery({});
    expect(result.createdAfter).toBeNull();
    expect(result.createdBefore).toBeNull();
    expect(result.dateRangeError).toBeNull();
  });

  it("no cursor -> cursor is null", () => {
    const result = parseAuditQuery({});
    expect(result.cursor).toBeNull();
  });

  it("a valid cursor decodes correctly", () => {
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: VALID_ACTOR_ID };
    const encoded = encodeAuditCursor(cursor);
    const result = parseAuditQuery({ cursor: encoded });
    expect(result.cursor).toEqual(cursor);
    expect(result.isFiltered).toBe(true);
  });

  it("a malformed cursor decodes to null rather than throwing", () => {
    expect(() => parseAuditQuery({ cursor: "garbage!!!" })).not.toThrow();
    const result = parseAuditQuery({ cursor: "garbage!!!" });
    expect(result.cursor).toBeNull();
    expect(result.isFiltered).toBe(false);
  });

  it("never throws for any combination of missing/invalid values", () => {
    expect(() =>
      parseAuditQuery({
        action: "bogus",
        actor: "bogus",
        target_type: "bogus",
        from: "bogus",
        to: "bogus",
        cursor: "bogus",
      }),
    ).not.toThrow();
  });
});

describe("buildAuditHref", () => {
  it("returns the bare path when no params are active", () => {
    expect(buildAuditHref({}, {})).toBe("/admin/audit");
  });

  it("preserves existing filters while adding a cursor override", () => {
    const href = buildAuditHref(
      { action: "staff.added", target_type: "staff_members" },
      { cursor: "opaque-token" },
    );
    expect(href).toContain("action=staff.added");
    expect(href).toContain("target_type=staff_members");
    expect(href).toContain("cursor=opaque-token");
  });

  it("an override of undefined removes that param entirely", () => {
    const href = buildAuditHref({ action: "staff.added", cursor: "old-token" }, { cursor: undefined });
    expect(href).not.toContain("cursor=");
    expect(href).toContain("action=staff.added");
  });

  it("filter URL preserves filters while adding the next cursor (the actual Next-link use case)", () => {
    const current = { action: "refund.issuance_submitted", from: "2026-01-01" };
    const href = buildAuditHref(current, { cursor: "next-token" });
    expect(href).toBe(
      "/admin/audit?action=refund.issuance_submitted&from=2026-01-01&cursor=next-token",
    );
  });
});

// ADMIN-1C Part C FINAL PRE-COMMIT UI CORRECTION: lookahead pagination.
// resolveAuditPage() is handed exactly what a AUDIT_DISPLAY_PAGE_SIZE + 1
// fetch would return -- these tests cover the full required matrix: 0,
// 1, 24 (well under), 25 (exactly at the boundary -- no Next, since the
// fetch itself already proves nothing more exists), and 26 (one over --
// 25 displayed + Next, cursor from row 25 specifically, never row 26).
describe("resolveAuditPage", () => {
  function makeRows(n: number): AuditEventRow[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `row-${i}`,
      actor_id: "f0000000-0000-0000-0000-000000000001",
      actor_display_name: "Owner One",
      action: "staff.added",
      target_type: "staff_members",
      target_id: "f0000000-0000-0000-0000-000000000006",
      metadata: {},
      created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));
  }

  it("0 rows: displays nothing, no Next", () => {
    const result = resolveAuditPage(makeRows(0));
    expect(result.rows).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("1 row: displays it, no Next", () => {
    const result = resolveAuditPage(makeRows(1));
    expect(result.rows).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("24 rows (well under the page size): displays all 24, no Next", () => {
    const result = resolveAuditPage(makeRows(24));
    expect(result.rows).toHaveLength(24);
    expect(result.nextCursor).toBeNull();
  });

  it("exactly AUDIT_DISPLAY_PAGE_SIZE (25) rows: displays all 25, NO Next -- the fetch itself already proves this was everything", () => {
    const rows = makeRows(AUDIT_DISPLAY_PAGE_SIZE);
    const result = resolveAuditPage(rows);
    expect(result.rows).toHaveLength(AUDIT_DISPLAY_PAGE_SIZE);
    expect(result.rows).toEqual(rows);
    expect(result.nextCursor).toBeNull();
  });

  it("AUDIT_DISPLAY_PAGE_SIZE + 1 (26) rows: displays only the first 25, and shows Next", () => {
    const rows = makeRows(AUDIT_DISPLAY_PAGE_SIZE + 1);
    const result = resolveAuditPage(rows);
    expect(result.rows).toHaveLength(AUDIT_DISPLAY_PAGE_SIZE);
    expect(result.rows).toEqual(rows.slice(0, AUDIT_DISPLAY_PAGE_SIZE));
    expect(result.nextCursor).not.toBeNull();
  });

  it("the 26th (lookahead) row is never rendered", () => {
    const rows = makeRows(AUDIT_DISPLAY_PAGE_SIZE + 1);
    const lookaheadRow = rows[AUDIT_DISPLAY_PAGE_SIZE];
    const result = resolveAuditPage(rows);

    expect(result.rows.some((r) => r.id === lookaheadRow.id)).toBe(false);
  });

  it("the next cursor is derived from row 25 (the last DISPLAYED row), not row 26 (the lookahead row)", () => {
    const rows = makeRows(AUDIT_DISPLAY_PAGE_SIZE + 1);
    const row25 = rows[AUDIT_DISPLAY_PAGE_SIZE - 1];
    const row26 = rows[AUDIT_DISPLAY_PAGE_SIZE];
    const result = resolveAuditPage(rows);

    const expectedFromRow25 = encodeAuditCursor({ createdAt: row25.created_at, id: row25.id });
    const wouldBeFromRow26 = encodeAuditCursor({ createdAt: row26.created_at, id: row26.id });

    expect(result.nextCursor).toBe(expectedFromRow25);
    expect(result.nextCursor).not.toBe(wouldBeFromRow26);
  });

  it("never uses OFFSET semantics -- a custom displayPageSize is honored exactly", () => {
    const rows = makeRows(5);
    const result = resolveAuditPage(rows, 3);
    expect(result.rows).toHaveLength(3);
    expect(result.nextCursor).not.toBeNull();
  });
});
