import type { AuditAction, AuditTargetType } from "@/lib/types";

// LIBRUM 2.0 ADMIN-1C PART B: pure, DB/Next.js-free helpers backing the
// audit-list Server primitive in ./actions.ts -- same "extract the
// decision logic so it's directly unit-testable" pattern already
// established by src/app/admin/(protected)/staff/staff-management-logic.ts
// and .../reports/report-review-logic.ts. No /admin/audit UI exists yet
// (Part C's own scope) -- this file exists so that layer has stable,
// tested primitives ready when it's built. URL/query-param PARSING is
// kept separate from these (a future page.tsx's own concern); everything
// here is pure validation/formatting logic only.

// ============================================================
// Known vocabulary -- must stay in sync with migration 042's own
// allow-lists inside list_admin_audit_events() (p_action/p_target_type).
// Deliberately duplicated here, not derived from a shared JSON file or
// similar: this is the same small, explicit, test-guarded duplication
// this schema already accepts between staff_has_permission() and
// ROLE_PERMISSIONS (see staff-permissions.ts's own comment) -- the
// actual safeguard against drift is the RPC boundary tests, not this
// list matching by construction.
// ============================================================

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "staff.added",
  "staff.role_changed",
  "staff.removed",
  "report.resolved",
  "report.dismissed",
  "refund.review_approved",
  "refund.review_rejected",
  "refund.issuance_submitted",
];

export function isValidAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export const AUDIT_TARGET_TYPES: readonly AuditTargetType[] = [
  "staff_members",
  "book_reports",
  "refund_requests",
];

export function isValidAuditTargetType(value: string): value is AuditTargetType {
  return (AUDIT_TARGET_TYPES as readonly string[]).includes(value);
}

// ============================================================
// Limit clamp -- mirrors list_admin_audit_events()'s own server-side
// clamp exactly (default 25, min 1, max 100). This is a friendly,
// non-authoritative pre-check only, matching every other "TS mirrors the
// RPC's own validation" pair in this codebase (e.g.
// validateAdminNotes()'s 2000-char cap vs review_refund_request()'s own
// check) -- the RPC's own clamp remains the real authority regardless of
// what a caller passes.
// ============================================================

export const AUDIT_LIST_DEFAULT_LIMIT = 25;
export const AUDIT_LIST_MIN_LIMIT = 1;
export const AUDIT_LIST_MAX_LIMIT = 100;

export function clampAuditLimit(raw: number | string | null | undefined): number {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  if (parsed === null || parsed === undefined || !Number.isFinite(parsed)) {
    return AUDIT_LIST_DEFAULT_LIMIT;
  }
  return Math.min(AUDIT_LIST_MAX_LIMIT, Math.max(AUDIT_LIST_MIN_LIMIT, Math.trunc(parsed)));
}

// ============================================================
// Date-range filter validation -- mirrors list_admin_audit_events()'s own
// `p_created_after >= p_created_before` rejection. Accepts any string
// `new Date(...)` can parse (an ISO date/datetime, matching how every
// other date input already round-trips through this app); returns null
// for an absent/empty filter, never throws.
// ============================================================

export type DateFilterValidation = { ok: true; value: string | null } | { ok: false; error: string };

export function validateAuditDateFilter(raw: string | null | undefined): DateFilterValidation {
  if (raw == null || raw.trim().length === 0) {
    return { ok: true, value: null };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "Enter a valid date." };
  }
  return { ok: true, value: parsed.toISOString() };
}

export type DateRangeValidation = { ok: true } | { ok: false; error: string };

// Only meaningful once both individual dates have already parsed
// successfully (validateAuditDateFilter above) -- this only checks their
// RELATIVE order, matching the RPC's own `p_created_after >=
// p_created_before` rejection exactly (an equal pair is also rejected,
// since a zero-width range can never match a row).
export function validateAuditDateRange(
  createdAfter: string | null,
  createdBefore: string | null,
): DateRangeValidation {
  if (createdAfter && createdBefore && createdAfter >= createdBefore) {
    return { ok: false, error: "The start date must be before the end date." };
  }
  return { ok: true };
}

// ============================================================
// Cursor encode/decode -- an opaque, base64url-encoded JSON payload
// carrying only createdAt/id (never anything sensitive -- Part A's own
// "no sensitive data in the cursor" requirement). Decoding NEVER throws:
// any malformed input (bad base64, invalid JSON, wrong shape, a
// non-string/non-uuid-shaped field) resolves to null, which callers
// treat as "no cursor" / "first page" rather than crashing the page.
// ============================================================

export type AuditCursor = { createdAt: string; id: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeAuditCursor(cursor: AuditCursor): string {
  const json = JSON.stringify({ c: cursor.createdAt, i: cursor.id });
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeAuditCursor(raw: string | null | undefined): AuditCursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "c" in parsed &&
      "i" in parsed &&
      typeof (parsed as { c: unknown }).c === "string" &&
      typeof (parsed as { i: unknown }).i === "string"
    ) {
      const createdAt = (parsed as { c: string }).c;
      const id = (parsed as { i: string }).i;
      if (Number.isNaN(new Date(createdAt).getTime()) || !UUID_PATTERN.test(id)) {
        return null;
      }
      return { createdAt, id };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Action-label mapping (design brief §25) -- raw database action strings
// are never the primary UI label. Lives here, not in a future page.tsx,
// since it's pure and Part B's own server primitive already needs it for
// error mapping's sibling concerns.
// ============================================================

export const ACTION_LABELS: Record<AuditAction, string> = {
  "staff.added": "Staff member added",
  "staff.role_changed": "Staff role changed",
  "staff.removed": "Staff member removed",
  "report.resolved": "Report resolved",
  "report.dismissed": "Report dismissed",
  "refund.review_approved": "Refund request approved",
  "refund.review_rejected": "Refund request denied",
  "refund.issuance_submitted": "Refund submitted to Stripe",
};

const UNKNOWN_ACTION_LABEL = "Admin action";

// Never throws on an action string outside the known vocabulary (a
// migration 042+ event this build predates, for instance) -- falls back
// to a safe, generic label rather than surfacing the raw string.
export function getActionLabel(action: string): string {
  if (isValidAuditAction(action)) {
    return ACTION_LABELS[action];
  }
  return UNKNOWN_ACTION_LABEL;
}

// ============================================================
// Details formatter (design brief §26) -- renders known metadata shapes
// as a short, safe line. Never dumps raw JSON, for any action, known or
// not -- an unrecognized action returns null (the caller shows nothing
// beyond the action label itself), not a JSON.stringify fallback.
// ============================================================

const STAFF_ROLE_DISPLAY_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  moderator: "Moderator",
  support: "Support",
  editor: "Editor",
};

function displayRole(role: unknown): string {
  if (typeof role === "string" && role in STAFF_ROLE_DISPLAY_LABELS) {
    return STAFF_ROLE_DISPLAY_LABELS[role];
  }
  return "Unknown role";
}

const STATUS_DISPLAY_LABELS: Record<string, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
  requested: "Pending",
  approved: "Approved",
  rejected: "Denied",
};

function displayStatus(status: unknown): string {
  if (typeof status === "string" && status in STATUS_DISPLAY_LABELS) {
    return STATUS_DISPLAY_LABELS[status];
  }
  return "Unknown";
}

export function formatAuditDetails(action: string, metadata: unknown): string | null {
  const data = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {};

  switch (action) {
    case "staff.added":
      return `Added as ${displayRole(data.role)}`;
    case "staff.role_changed":
      return `${displayRole(data.old_role)} → ${displayRole(data.new_role)}`;
    case "staff.removed":
      return `Removed (was ${displayRole(data.role)})`;
    case "report.resolved":
    case "report.dismissed":
    case "refund.review_approved":
    case "refund.review_rejected":
      return `${displayStatus(data.old_status)} → ${displayStatus(data.new_status)}`;
    case "refund.issuance_submitted":
      return typeof data.stripe_status === "string" ? `Stripe status: ${data.stripe_status}` : null;
    default:
      return null;
  }
}

// ============================================================
// RPC error mapping -- same shape as mapStaffRpcError/mapReviewRpcError.
// ============================================================

export const GENERIC_AUDIT_ERROR_MESSAGE = "Something went wrong. Please try again.";

export const AUDIT_RPC_NOT_AUTHENTICATED_MESSAGE = "not authenticated";

const KNOWN_AUDIT_RPC_ERROR_MESSAGES: Record<string, string> = {
  "not authorized": "You don't have permission to view the audit log.",
  "invalid action filter": "That's not a valid action filter.",
  "invalid target_type filter": "That's not a valid target type filter.",
  "invalid cursor": "That pagination link is no longer valid.",
  "invalid date range": "The start date must be before the end date.",
};

export function mapAuditRpcError(error: { message?: string | null } | null | undefined): string {
  const message = error?.message?.trim();
  if (!message) {
    return GENERIC_AUDIT_ERROR_MESSAGE;
  }
  return KNOWN_AUDIT_RPC_ERROR_MESSAGES[message] ?? GENERIC_AUDIT_ERROR_MESSAGE;
}
