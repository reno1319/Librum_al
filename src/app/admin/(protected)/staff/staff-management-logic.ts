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

// ============================================================
// ADMIN-1B PART C: pure UI-support helpers for /admin/staff. Additive
// only -- everything above this line is Part B's committed contract,
// unmodified. Same "extract the decision so it's directly testable"
// discipline as the rest of this file.
// ============================================================

// Human labels, in the exact order the design brief's own Add-staff
// dropdown lists them (owner, admin, moderator, support, editor) --
// deliberately a SEPARATE ordering from STAFF_ROLES above (which exists
// only for validation, where order is irrelevant) since this one drives
// what an admin actually sees top-to-bottom in the UI.
export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  owner: "Owner",
  admin: "Admin",
  moderator: "Moderator",
  support: "Support",
  editor: "Editor",
};

export const STAFF_ROLE_OPTIONS: readonly { value: StaffRole; label: string }[] = (
  ["owner", "admin", "moderator", "support", "editor"] as const
).map((value) => ({ value, label: STAFF_ROLE_LABELS[value] }));

// Shown next to the Editor option -- 'editor' currently carries zero
// permissions (src/lib/staff-permissions.ts's own ROLE_PERMISSIONS),
// so an admin choosing it should not be left wondering whether that was
// a mistake. Purely informational; does not alter the role's actual
// permissions, which remain defined exactly once, in
// src/lib/staff-permissions.ts.
export const EDITOR_ROLE_HELP_TEXT =
  "Editorial role. This role currently does not have access to the administration dashboard.";

// Whether the CURRENT signed-in staff member (canManage already implies
// they hold staff.manage) should see mutating controls for a given
// roster row. False for their own row regardless of canManage -- the
// self-action invariant (migration 041's own explicit
// `target_user_id = actor` rejection in change_staff_role()/
// remove_staff_member()) should be visibly reflected in the UI, not
// just enforced invisibly server-side after a confusing failed attempt.
export function canManageStaffRow(rowUserId: string, currentUserId: string, canManage: boolean): boolean {
  return canManage && rowUserId !== currentUserId;
}

// Owner is the one role whose grant is high-risk enough to need its own
// stronger confirmation copy, regardless of whether this is a brand-new
// addition or a change to an existing staff member's role -- see
// getRoleChangeConfirmationMessage below for the change-to-owner case.
function grantOwnerConfirmationMessage(displayName?: string): string {
  const subject = displayName ? `Grant Owner access to ${displayName}?` : "Grant Owner access to this account?";
  return `${subject}\n\nOwners have full administrative authority, including staff management.`;
}

// Confirmation copy for the Add-staff form's submit button. Returns
// null for every role except 'owner' -- the UI only ever confirms the
// one high-risk case (see the design brief's own "Add as Owner
// confirmation" requirement); every other role is added without an
// extra confirmation step, matching how ordinary role changes below
// also stay unconfirmed-by-default except where the brief specifically
// calls for it.
export function getAddStaffConfirmationMessage(role: StaffRole): string | null {
  if (role !== "owner") return null;
  return grantOwnerConfirmationMessage();
}

// PART C CORRECTION: demoting an existing Owner away from the role gets
// its own dedicated, stronger copy -- distinct from both the
// promotion-to-owner copy and the plain ordinary-change template. Purely
// informational: it neither counts current Owners nor claims the
// operation is safe -- migration 041's staff_members_protect_last_owner
// trigger remains the sole authority that actually blocks removing the
// last Owner; this text just makes sure the person clicking Save
// understands the stakes before the backend gets a chance to reject it.
function demoteOwnerConfirmationMessage(displayName: string): string {
  return `Remove Owner access from ${displayName}?\n\nThey will lose staff-management authority. Librum must retain at least one Owner.`;
}

// Confirmation copy for a per-row role change -- three distinct branches:
//   A. promotion TO owner: the strong grant-owner copy (same as a
//      brand-new Owner addition).
//   B. demotion FROM owner (currentRole === "owner", newRole !== "owner"):
//      the dedicated demote-owner copy above.
//   C. everything else: one plain, factual template ("Change {name}'s
//      role from X to Y?").
export function getRoleChangeConfirmationMessage(
  displayName: string,
  currentRole: StaffRole,
  newRole: StaffRole,
): string {
  if (newRole === "owner") {
    return grantOwnerConfirmationMessage(displayName);
  }
  if (currentRole === "owner") {
    return demoteOwnerConfirmationMessage(displayName);
  }
  return `Change ${displayName}'s role from ${STAFF_ROLE_LABELS[currentRole]} to ${STAFF_ROLE_LABELS[newRole]}?`;
}

// Pure equivalent of RoleChangeRow's own `changed` check -- extracted so
// "an unchanged role keeps Save disabled" is directly testable without a
// DOM. Identical logic to what the component already computed inline;
// this is a name for it, not new behavior.
export function isRoleChangeSubmittable(selectedRole: StaffRole, currentRole: StaffRole): boolean {
  return selectedRole !== currentRole;
}

// Shared confirm-then-submit gate used by every mutating control's
// submit button (AddStaffForm/RoleChangeRow/RemoveStaffButton). This
// codebase's vitest runs with `environment: "node"` (vitest.config.mts)
// -- there is no jsdom/React Testing Library, so a real click can't be
// simulated. Extracting the gating decision into a plain function lets
// tests call it directly with a fake `confirm` and a fake event, proving
// the exact behavior a DOM harness would otherwise have to simulate:
// null message -> proceed without ever calling confirm; confirm() ->
// false blocks the submit (preventDefault), true lets it through.
export function handleConfirmGatedSubmit(
  confirmMessage: string | null,
  confirm: (message: string) => boolean,
  event: { preventDefault: () => void },
): void {
  if (confirmMessage === null) return;
  if (!confirm(confirmMessage)) {
    event.preventDefault();
  }
}

// Confirmation copy for the Remove-staff control. Deliberately never
// mentions the Librum account itself -- removing staff status and
// deleting an account are two entirely different, unrelated operations
// (see the Part B account-deletion guard, which this page never calls
// into), and this copy is written so it cannot be misread as the
// stronger of the two.
export function getRemoveStaffConfirmationMessage(displayName: string): string {
  return `Remove ${displayName} from Librum staff?\n\nThey will immediately lose access to staff-only areas.`;
}

export const STAFF_ADDED_SUCCESS_MESSAGE = "Staff member added.";
export const STAFF_ROLE_CHANGED_SUCCESS_MESSAGE = "Role updated.";
export const STAFF_REMOVED_SUCCESS_MESSAGE = "Staff member removed.";

// Presentational only -- added_at/created_at is already a plain ISO
// timestamp from list_staff_members(); this just gives every row a
// short, locale-formatted date instead of a raw ISO string, matching
// the exact toLocaleDateString shape already used by
// src/app/admin/(protected)/refunds/page.tsx for the same purpose.
export function formatStaffAddedDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
