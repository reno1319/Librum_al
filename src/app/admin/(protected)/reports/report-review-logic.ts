import type { BookReportStatus } from "@/lib/types";

// LIBRUM 2.0 LAUNCH-FIX-1B MOD-1: mirrors src/app/admin/refunds/
// refund-review-logic.ts's own shape closely (same pure-decision-
// function pattern), but is its own independent file rather than a
// shared import -- refund/dispute logic is explicitly protected work
// for this pass, and this is genuinely a different decision (two
// statuses, not five; a different starting state; different
// confirmation copy that must NOT imply a content action -- see
// getReviewConfirmationMessage below), not a refactor opportunity.

// Matches review_book_report()'s own 2000-character cap (migration
// 039) -- mirrored here only so the UI can give a friendly message
// before submission; the RPC's own check remains the actual authority.
export const ADMIN_NOTES_MAX_LENGTH = 2000;

export const REPORT_STATUS_LABELS: Record<BookReportStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

// A report only ever exposes Resolve/Dismiss controls in the 'open'
// state -- review_book_report() (migration 039) only ever transitions
// a row `where status = 'open'`; 'resolved'/'dismissed' are both
// terminal for it. Presentational only: the RPC re-checks the current
// status itself and is what actually decides whether a transition is
// legal, regardless of what this function says.
export function canReview(status: BookReportStatus): boolean {
  return status === "open";
}

// Triage ordering (MOD-1 brief, section 10): open reports first, oldest
// first within that group (the ones waiting longest get attention
// first); closed reports after, most-recently-reviewed first within
// that group (so a recently-closed report is easy to find again).
// Deliberately NOT one uniform sort direction across both groups --
// unlike refund-review-logic.ts's compareForTriage, which sorts
// "pending first, then newest first" uniformly, because refund triage
// only ever cares about recency; report triage explicitly cares about
// oldest-open first (the brief's own stated operational priority).
// Pure, so it's applied client-side after a single plain DB fetch --
// same technique already used for refunds (see admin/refunds/page.tsx).
export function compareForTriage<
  T extends { status: BookReportStatus; created_at: string; reviewed_at: string | null },
>(a: T, b: T): number {
  const aOpen = a.status === "open" ? 0 : 1;
  const bOpen = b.status === "open" ? 0 : 1;
  if (aOpen !== bOpen) {
    return aOpen - bOpen;
  }
  if (a.status === "open") {
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  }
  const aReviewed = a.reviewed_at ?? a.created_at;
  const bReviewed = b.reviewed_at ?? b.created_at;
  return aReviewed < bReviewed ? 1 : aReviewed > bReviewed ? -1 : 0;
}

// Confirmation copy for the Resolve/Dismiss buttons (report-review-
// buttons.tsx) -- extracted as a pure function for the same reason as
// refund-review-logic.ts's getReviewConfirmationMessage: directly
// testable without a DOM/browser testing setup. The "resolved" message
// exists specifically to prevent the "resolved implies the book was
// taken down" misunderstanding the MOD-1 brief explicitly warns
// against (section 16): resolving here only ever calls
// review_book_report(), which writes status = 'resolved' and nothing
// else -- no unpublish/delete/suspend as a result -- so the
// confirmation says so explicitly rather than implying otherwise.
export function getReviewConfirmationMessage(decision: "resolved" | "dismissed"): string {
  if (decision === "resolved") {
    return "Mark this report as resolved? This records that it's been reviewed and closed -- it does not unpublish the book or take any other action.";
  }
  return "Dismiss this report? This records that it needed no action.";
}

export type AdminNotesValidation = { ok: true; value: string | null } | { ok: false; error: string };

// admin_notes is optional on the RPC side (p_admin_notes accepts null,
// and neither decision requires notes) -- this only ever rejects notes
// that are too long, matching the RPC's own 2000-character check, so a
// submission that would fail server-side gets a friendly client-side
// message instead of a raw exception.
export function validateAdminNotes(raw: FormDataEntryValue | null): AdminNotesValidation {
  if (raw == null) {
    return { ok: true, value: null };
  }
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > ADMIN_NOTES_MAX_LENGTH) {
    return {
      ok: false,
      error: `Please keep notes under ${ADMIN_NOTES_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

export const GENERIC_REVIEW_ERROR_MESSAGE = "We couldn't review this report. Please try again.";

// The exact string review_book_report() raises via `raise exception
// 'not authenticated'` (migration 039). Handled as a special case by
// the caller (redirect to login), not through the generic mapping
// below -- same reasoning as refund-review-logic.ts's own
// REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE.
export const REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE = "not authenticated";

// Every other exception message the RPC can raise, mapped to
// admin-facing copy. Deliberately NOT a passthrough of error.message --
// same LAUNCH-FIX-1A ERR-2 posture applied throughout this app: nothing
// in this map, and nothing outside it either (see mapReviewRpcError
// below), ever surfaces raw Postgres/RPC text to the browser.
const KNOWN_REVIEW_RPC_ERROR_MESSAGES: Record<string, string> = {
  "not authorized": "You don't have permission to review book reports.",
  "p_decision must be 'resolved' or 'dismissed'": "Invalid decision.",
  "p_admin_notes must be 2000 characters or fewer": `Notes must be ${ADMIN_NOTES_MAX_LENGTH} characters or fewer.`,
  "no reviewable report found for this id": "This report has already been reviewed.",
};

export function mapReviewRpcError(error: { message?: string | null } | null | undefined): string {
  const message = error?.message?.trim();
  if (!message) {
    return GENERIC_REVIEW_ERROR_MESSAGE;
  }
  return KNOWN_REVIEW_RPC_ERROR_MESSAGES[message] ?? GENERIC_REVIEW_ERROR_MESSAGE;
}

// Shared resolution for reporter_id/reviewed_by/book author_id --
// book_reports has THREE separate foreign keys into profiles, so a
// PostgREST embed on this table would be ambiguous about which one
// "profiles(...)" refers to (the exact same reason refund_requests'
// admin pages do one flat, explicit profiles lookup instead of an
// embed -- see refund-review-logic.ts's own resolveProfileDisplayName).
// whenNull and whenMissing are separate messages on purpose: a null id
// (reviewed_by before any review) is a different, more definite fact
// than an id that's set but didn't resolve.
export function resolveProfileDisplayName(params: {
  profileId: string | null;
  displayNameById: Map<string, string>;
  whenNull: string;
  whenMissing: string;
}): string {
  if (!params.profileId) {
    return params.whenNull;
  }
  return params.displayNameById.get(params.profileId) ?? params.whenMissing;
}
