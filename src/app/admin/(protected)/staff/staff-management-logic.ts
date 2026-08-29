import type { StaffRole } from "@/lib/types";

// LIBRUM 2.0 ADMIN-1B PART B: pure, DB/Next.js-free helpers backing the
// staff-management Server Actions in ./actions.ts -- same "extract the
// decision logic so it's directly unit-testable" pattern already
// established by src/app/admin/(protected)/reports/report-review-logic.ts
// and src/app/admin/(protected)/refunds/refund-review-logic.ts. No UI
// exists yet to call these from (Part C's own scope) -- this file exists
// so the Server Action layer has stable, tested primitives ready when
// that UI is built.

export const STAFF_ROLES: readonly StaffRole[] = [
  "owner",
  "admin",
  "editor",
  "moderator",
  "support",
];

// Mirrors the exact domain add_staff_member_by_email()/change_staff_role()
// (migration 041) validate server-side -- this is a friendly, fast
// pre-check only; the RPC's own `if new_role not in (...)` is the actual
// authority, matching validateAdminNotes()'s own established relationship
// to review_book_report()'s server-side check.
export function isValidStaffRole(role: string): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

// Mirrors add_staff_member_by_email()'s own `lower(trim(coalesce(...)))`
// normalization exactly, so a value this function accepts is guaranteed
// to also be accepted (or rejected for the same account-lookup reasons,
// never a normalization mismatch) by the RPC. Returns null for an empty
// (post-trim) value rather than an empty string, so callers can treat
// "no email" as a single, obvious falsy case.
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export const GENERIC_STAFF_ERROR_MESSAGE = "Something went wrong. Please try again.";

// The exact string every staff-management RPC raises via `raise
// exception 'not authenticated'` (migration 041) when auth.uid() is
// null. Handled as a special case by callers (e.g. redirect to login),
// not through the generic mapping below -- same convention
// report-review-logic.ts's own REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE
// establishes.
export const STAFF_RPC_NOT_AUTHENTICATED_MESSAGE = "not authenticated";

// Every other exception message the four staff-management RPCs
// (list_staff_members, add_staff_member_by_email, change_staff_role,
// remove_staff_member) and the staff_members_protect_last_owner()
// trigger can raise, mapped to stable, non-leaking, admin-facing copy.
// Deliberately NOT a passthrough of error.message -- same
// LAUNCH-FIX-1A ERR-2 posture this app applies everywhere else: no raw
// Postgres/RPC text, no SQLSTATE, no table/policy/function names ever
// reach the browser. Every message the RPCs can actually raise (per
// migration 041's own source) has an entry here; nothing else is a
// "known" message.
const KNOWN_STAFF_RPC_ERROR_MESSAGES: Record<string, string> = {
  "not authorized": "You don't have permission to manage staff.",
  "invalid role": "That's not a valid staff role.",
  "invalid email": "Enter an email address.",
  "no verified Librum account was found for that email":
    "No verified Librum account was found for that email.",
  "already staff": "That account is already staff.",
  "staff member not found": "This staff member no longer exists.",
  "cannot change your own role": "You can't change your own role.",
  "cannot remove yourself": "You can't remove yourself from staff.",
  "at least one owner is required": "Librum must always have at least one owner.",
};

export function mapStaffRpcError(error: { message?: string | null } | null | undefined): string {
  const message = error?.message?.trim();
  if (!message) {
    return GENERIC_STAFF_ERROR_MESSAGE;
  }
  return KNOWN_STAFF_RPC_ERROR_MESSAGES[message] ?? GENERIC_STAFF_ERROR_MESSAGE;
}
