import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MIN_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  isValidAuditAction,
  isValidAuditTargetType,
  clampAuditLimit,
  validateAuditDateFilter,
  validateAuditDateRange,
  resolveAuditToDateFilter,
  encodeAuditCursor,
  decodeAuditCursor,
  ACTION_LABELS,
  getActionLabel,
  formatAuditDetails,
  resolveAuditActorDisplay,
  resolveAuditTargetDisplay,
  resolveActorFilterOptions,
  shortAuditTargetRef,
  mapAuditRpcError,
  GENERIC_AUDIT_ERROR_MESSAGE,
  AUDIT_RPC_NOT_AUTHENTICATED_MESSAGE,
} from "./audit-log-logic";

describe("isValidAuditAction", () => {
  it("accepts every one of the eight known actions", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(isValidAuditAction(action)).toBe(true);
    }
  });

  it("rejects an unknown action", () => {
    expect(isValidAuditAction("staff.promoted")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidAuditAction("")).toBe(false);
  });
});

describe("isValidAuditTargetType", () => {
  it("accepts every one of the three known target types", () => {
    for (const targetType of AUDIT_TARGET_TYPES) {
      expect(isValidAuditTargetType(targetType)).toBe(true);
    }
  });

  it("rejects an unknown target type", () => {
    expect(isValidAuditTargetType("purchases")).toBe(false);
  });
});

describe("clampAuditLimit", () => {
  it("defaults to 25 for null/undefined", () => {
    expect(clampAuditLimit(null)).toBe(AUDIT_LIST_DEFAULT_LIMIT);
    expect(clampAuditLimit(undefined)).toBe(AUDIT_LIST_DEFAULT_LIMIT);
  });

  it("defaults to 25 for a non-numeric string", () => {
    expect(clampAuditLimit("not-a-number")).toBe(AUDIT_LIST_DEFAULT_LIMIT);
  });

  it("raises anything below the minimum up to 1", () => {
    expect(clampAuditLimit(0)).toBe(AUDIT_LIST_MIN_LIMIT);
    expect(clampAuditLimit(-5)).toBe(AUDIT_LIST_MIN_LIMIT);
  });

  it("caps anything above the maximum to 100", () => {
    expect(clampAuditLimit(500)).toBe(AUDIT_LIST_MAX_LIMIT);
    expect(clampAuditLimit(101)).toBe(AUDIT_LIST_MAX_LIMIT);
  });

  it("passes a valid in-range value through unchanged", () => {
    expect(clampAuditLimit(50)).toBe(50);
    expect(clampAuditLimit("50")).toBe(50);
  });

  it("truncates a fractional value", () => {
    expect(clampAuditLimit(10.9)).toBe(10);
  });
});

describe("validateAuditDateFilter", () => {
  it("returns null for an absent/empty filter", () => {
    expect(validateAuditDateFilter(null)).toEqual({ ok: true, value: null });
    expect(validateAuditDateFilter(undefined)).toEqual({ ok: true, value: null });
    expect(validateAuditDateFilter("")).toEqual({ ok: true, value: null });
    expect(validateAuditDateFilter("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts a valid ISO date and normalizes it", () => {
    const result = validateAuditDateFilter("2026-01-01");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(new Date("2026-01-01").toISOString());
    }
  });

  it("rejects an unparseable date", () => {
    const result = validateAuditDateFilter("not-a-date");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Enter a valid date.");
    }
  });
});

describe("validateAuditDateRange", () => {
  it("passes when only one side is present", () => {
    expect(validateAuditDateRange("2026-01-01T00:00:00.000Z", null)).toEqual({ ok: true });
    expect(validateAuditDateRange(null, "2026-01-01T00:00:00.000Z")).toEqual({ ok: true });
  });

  it("passes when neither side is present", () => {
    expect(validateAuditDateRange(null, null)).toEqual({ ok: true });
  });

  it("passes when after is strictly before before", () => {
    expect(
      validateAuditDateRange("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    ).toEqual({ ok: true });
  });

  it("rejects when after is on or after before", () => {
    const equal = validateAuditDateRange("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    expect(equal.ok).toBe(false);

    const reversed = validateAuditDateRange("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    expect(reversed.ok).toBe(false);
  });
});

describe("encodeAuditCursor / decodeAuditCursor", () => {
  const CURSOR = { createdAt: "2026-01-01T00:00:00.000Z", id: "e0000000-0000-0000-0000-000000000001" };

  it("round-trips a valid cursor", () => {
    const encoded = encodeAuditCursor(CURSOR);
    expect(decodeAuditCursor(encoded)).toEqual(CURSOR);
  });

  it("is opaque -- does not contain the raw values as plain substrings", () => {
    const encoded = encodeAuditCursor(CURSOR);
    expect(encoded).not.toContain(CURSOR.createdAt);
    expect(encoded).not.toContain(CURSOR.id);
  });

  it("decodes null/undefined/empty as null (no cursor), never throwing", () => {
    expect(decodeAuditCursor(null)).toBeNull();
    expect(decodeAuditCursor(undefined)).toBeNull();
    expect(decodeAuditCursor("")).toBeNull();
  });

  it("decodes garbage base64 as null, never throwing", () => {
    expect(decodeAuditCursor("not-valid-base64url!!!")).toBeNull();
  });

  it("decodes valid base64url that isn't JSON as null, never throwing", () => {
    const notJson = Buffer.from("this is not json", "utf8").toString("base64url");
    expect(decodeAuditCursor(notJson)).toBeNull();
  });

  it("decodes JSON with the wrong shape as null", () => {
    const wrongShape = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url");
    expect(decodeAuditCursor(wrongShape)).toBeNull();
  });

  it("decodes an invalid createdAt as null", () => {
    const badDate = Buffer.from(JSON.stringify({ c: "not-a-date", i: CURSOR.id }), "utf8").toString(
      "base64url",
    );
    expect(decodeAuditCursor(badDate)).toBeNull();
  });

  it("decodes a non-UUID-shaped id as null", () => {
    const badId = Buffer.from(JSON.stringify({ c: CURSOR.createdAt, i: "not-a-uuid" }), "utf8").toString(
      "base64url",
    );
    expect(decodeAuditCursor(badId)).toBeNull();
  });

  it("never puts sensitive-looking data in the cursor by construction -- only createdAt/id are ever encoded", () => {
    const encoded = encodeAuditCursor(CURSOR);
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    expect(Object.keys(decoded).sort()).toEqual(["c", "i"]);
  });
});

describe("ACTION_LABELS / getActionLabel", () => {
  it("every known action has a human label, not the raw action string", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(ACTION_LABELS[action]).toBeTruthy();
      expect(ACTION_LABELS[action]).not.toBe(action);
    }
  });

  it("getActionLabel returns the mapped label for a known action", () => {
    expect(getActionLabel("staff.added")).toBe("Staff member added");
    expect(getActionLabel("refund.issuance_submitted")).toBe("Refund submitted to Stripe");
  });

  it("getActionLabel falls back to a safe generic label for an unknown action, never the raw string", () => {
    const label = getActionLabel("something.totally_unknown");
    expect(label).toBe("Admin action");
    expect(label).not.toContain("totally_unknown");
  });
});

describe("formatAuditDetails", () => {
  it("staff.added: shows the granted role", () => {
    expect(formatAuditDetails("staff.added", { role: "support" })).toBe("Added as Support");
  });

  it("staff.role_changed: shows old -> new role", () => {
    expect(formatAuditDetails("staff.role_changed", { old_role: "support", new_role: "moderator" })).toBe(
      "Support → Moderator",
    );
  });

  it("staff.removed: shows the role held at removal", () => {
    expect(formatAuditDetails("staff.removed", { role: "admin" })).toBe("Removed (was Admin)");
  });

  it("report.resolved / report.dismissed: shows old -> new status", () => {
    expect(formatAuditDetails("report.resolved", { old_status: "open", new_status: "resolved" })).toBe(
      "Open → Resolved",
    );
    expect(formatAuditDetails("report.dismissed", { old_status: "open", new_status: "dismissed" })).toBe(
      "Open → Dismissed",
    );
  });

  it("refund.review_approved / refund.review_rejected: shows old -> new status", () => {
    expect(
      formatAuditDetails("refund.review_approved", { old_status: "requested", new_status: "approved" }),
    ).toBe("Pending → Approved");
    expect(
      formatAuditDetails("refund.review_rejected", { old_status: "requested", new_status: "rejected" }),
    ).toBe("Pending → Denied");
  });

  it("refund.issuance_submitted: shows the Stripe status only, never the raw refund id", () => {
    const result = formatAuditDetails("refund.issuance_submitted", {
      stripe_refund_id: "re_abc123",
      stripe_status: "pending",
    });
    expect(result).toBe("Stripe status: pending");
    expect(result).not.toContain("re_abc123");
  });

  it("returns null for an unknown action -- never dumps raw JSON", () => {
    const metadata = { some: "unexpected", shape: 123 };
    const result = formatAuditDetails("something.totally_unknown", metadata);
    expect(result).toBeNull();
  });

  it("never renders raw JSON.stringify output for any known action either", () => {
    for (const action of AUDIT_ACTIONS) {
      const result = formatAuditDetails(action, { a: 1, b: 2, c: 3 });
      if (result !== null) {
        expect(result).not.toMatch(/[{}[\]]/);
      }
    }
  });

  it("handles missing/malformed metadata without throwing", () => {
    expect(() => formatAuditDetails("staff.added", null)).not.toThrow();
    expect(() => formatAuditDetails("staff.added", undefined)).not.toThrow();
    expect(() => formatAuditDetails("staff.added", "not an object")).not.toThrow();
    expect(formatAuditDetails("staff.added", {})).toBe("Added as Unknown role");
  });
});

describe("resolveAuditToDateFilter", () => {
  it("returns null for an absent/empty filter", () => {
    expect(resolveAuditToDateFilter(null)).toEqual({ ok: true, value: null });
    expect(resolveAuditToDateFilter(undefined)).toEqual({ ok: true, value: null });
    expect(resolveAuditToDateFilter("")).toEqual({ ok: true, value: null });
  });

  it("advances a valid date by exactly one UTC day (the exclusive upper bound)", () => {
    const result = resolveAuditToDateFilter("2026-01-15");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(new Date("2026-01-16T00:00:00.000Z").toISOString());
    }
  });

  it("correctly rolls over a month boundary", () => {
    const result = resolveAuditToDateFilter("2026-01-31");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(new Date("2026-02-01T00:00:00.000Z").toISOString());
    }
  });

  it("correctly rolls over a year boundary", () => {
    const result = resolveAuditToDateFilter("2026-12-31");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(new Date("2027-01-01T00:00:00.000Z").toISOString());
    }
  });

  it("propagates the same rejection as validateAuditDateFilter for an unparseable date", () => {
    const result = resolveAuditToDateFilter("not-a-date");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Enter a valid date.");
    }
  });
});

describe("resolveAuditActorDisplay", () => {
  it("returns the display name when present", () => {
    expect(resolveAuditActorDisplay("Renato Kalemi")).toBe("Renato Kalemi");
  });

  it("falls back to a neutral label when the actor is null, never a raw UUID or email", () => {
    expect(resolveAuditActorDisplay(null)).toBe("Former/deleted staff account");
  });
});

describe("shortAuditTargetRef", () => {
  it("returns the leading UUID group before the first hyphen", () => {
    expect(shortAuditTargetRef("f0000000-0000-0000-0000-000000000030")).toBe("f0000000");
  });

  it("returns 'unknown' for a null target id", () => {
    expect(shortAuditTargetRef(null)).toBe("unknown");
  });
});

describe("resolveAuditTargetDisplay", () => {
  it("staff_members: labeled, but never linked -- no staff-detail route exists", () => {
    const result = resolveAuditTargetDisplay("staff_members", "f0000000-0000-0000-0000-000000000006");
    expect(result.label).toBe("Staff member · f0000000");
    expect(result.href).toBeNull();
  });

  it("book_reports: labeled and linked to /admin/reports/<target_id>", () => {
    const result = resolveAuditTargetDisplay("book_reports", "f0000000-0000-0000-0000-000000000020");
    expect(result.label).toBe("Book report · f0000000");
    expect(result.href).toBe("/admin/reports/f0000000-0000-0000-0000-000000000020");
  });

  it("refund_requests: labeled and linked to /admin/refunds/<target_id>", () => {
    const result = resolveAuditTargetDisplay("refund_requests", "f0000000-0000-0000-0000-000000000030");
    expect(result.label).toBe("Refund request · f0000000");
    expect(result.href).toBe("/admin/refunds/f0000000-0000-0000-0000-000000000030");
  });

  it("an unknown target_type gets a safe fallback label and no link, never throwing", () => {
    const result = resolveAuditTargetDisplay("purchases", "f0000000-0000-0000-0000-000000000099");
    expect(result.label).toBe("Unknown target · f0000000");
    expect(result.href).toBeNull();
  });

  it("a null target_id never produces a link, even for a linkable target_type", () => {
    const result = resolveAuditTargetDisplay("book_reports", null);
    expect(result.label).toBe("Book report · unknown");
    expect(result.href).toBeNull();
  });
});

describe("resolveActorFilterOptions", () => {
  const ROSTER = [
    { user_id: "f0000000-0000-0000-0000-000000000001", display_name: "Owner One" },
    { user_id: "f0000000-0000-0000-0000-000000000002", display_name: "Admin Two" },
  ];

  it("no active actor: returns exactly the roster, no synthetic option", () => {
    const options = resolveActorFilterOptions(ROSTER, null);
    expect(options).toEqual([
      { value: "f0000000-0000-0000-0000-000000000001", label: "Owner One" },
      { value: "f0000000-0000-0000-0000-000000000002", label: "Admin Two" },
    ]);
  });

  it("current-staff actor: the matching roster option is returned, no synthetic option added", () => {
    const options = resolveActorFilterOptions(ROSTER, "f0000000-0000-0000-0000-000000000002");
    expect(options).toHaveLength(2);
    expect(options).toContainEqual({
      value: "f0000000-0000-0000-0000-000000000002",
      label: "Admin Two",
    });
  });

  it("former/unknown valid actor UUID: appends one synthetic selected option, preserving the real UUID as its value", () => {
    const formerId = "f0000000-0000-0000-0000-000000000099";
    const options = resolveActorFilterOptions(ROSTER, formerId);

    expect(options).toHaveLength(3);
    const synthetic = options.find((o) => o.value === formerId);
    expect(synthetic).toBeTruthy();
    expect(synthetic?.label).toBe("Former/deleted staff account · f0000000");
  });

  it("the synthetic option's label never contains an email address", () => {
    const formerId = "f0000000-0000-0000-0000-000000000099";
    const options = resolveActorFilterOptions(ROSTER, formerId);
    const synthetic = options.find((o) => o.value === formerId);

    expect(synthetic?.label).not.toContain("@");
  });

  it("an empty roster with a former actor still produces exactly one synthetic option", () => {
    const formerId = "f0000000-0000-0000-0000-000000000099";
    const options = resolveActorFilterOptions([], formerId);
    expect(options).toEqual([
      { value: formerId, label: "Former/deleted staff account · f0000000" },
    ]);
  });

  it("an empty roster with no active actor returns no options at all", () => {
    expect(resolveActorFilterOptions([], null)).toEqual([]);
  });
});

describe("mapAuditRpcError", () => {
  it("maps every known RPC error message to stable, non-leaking copy", () => {
    expect(mapAuditRpcError({ message: "not authorized" })).toBe(
      "You don't have permission to view the audit log.",
    );
    expect(mapAuditRpcError({ message: "invalid action filter" })).toBe(
      "That's not a valid action filter.",
    );
    expect(mapAuditRpcError({ message: "invalid target_type filter" })).toBe(
      "That's not a valid target type filter.",
    );
    expect(mapAuditRpcError({ message: "invalid cursor" })).toBe(
      "That pagination link is no longer valid.",
    );
    expect(mapAuditRpcError({ message: "invalid date range" })).toBe(
      "The start date must be before the end date.",
    );
  });

  it("falls back to the generic message for an unrecognized error", () => {
    expect(mapAuditRpcError({ message: 'relation "public.admin_audit_log" does not exist' })).toBe(
      GENERIC_AUDIT_ERROR_MESSAGE,
    );
  });

  it("never leaks the raw unrecognized message text", () => {
    const mapped = mapAuditRpcError({ message: "duplicate key value violates unique constraint" });
    expect(mapped).not.toContain("duplicate key");
    expect(mapped).not.toContain("constraint");
  });

  it("falls back to the generic message for a null/undefined/empty error", () => {
    expect(mapAuditRpcError(null)).toBe(GENERIC_AUDIT_ERROR_MESSAGE);
    expect(mapAuditRpcError(undefined)).toBe(GENERIC_AUDIT_ERROR_MESSAGE);
    expect(mapAuditRpcError({ message: "" })).toBe(GENERIC_AUDIT_ERROR_MESSAGE);
    expect(mapAuditRpcError({ message: "   " })).toBe(GENERIC_AUDIT_ERROR_MESSAGE);
  });

  it("does not map the 'not authenticated' message -- callers handle that case separately", () => {
    expect(AUDIT_RPC_NOT_AUTHENTICATED_MESSAGE).toBe("not authenticated");
  });
});
