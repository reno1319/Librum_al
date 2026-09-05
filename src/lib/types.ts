// 'admin' (see migration 028) is a durable, server-enforced
// marketplace-operator role -- never selectable by a user. It exists on
// Profile.role because a profile row can legitimately have it, but no
// user-facing flow (signup, profile editing) may ever produce it -- see
// SignupRole below and requireAdmin() in src/lib/auth.ts.
export type Role = "author" | "reader" | "admin";

// The subset of Role a user may ever choose for themselves at signup.
// Deliberately narrower than Role so a future edit to the signup form
// that tried to widen its allowed values to include "admin" fails to
// typecheck, rather than silently compiling -- one more layer alongside
// the runtime allowlist in src/app/auth/actions.ts, the database CHECK
// constraint, and handle_new_user()'s own whitelist (migration 028).
export type SignupRole = Extract<Role, "author" | "reader">;

export type Profile = {
  id: string;
  role: Role;
  display_name: string;
  // LIBRUM 2.0 AUTHOR-1A: reader-facing author name / pen name. Null
  // means "not set yet" -- resolve through resolvePublicAuthorName()
  // (src/lib/author-name.ts), never read directly on a public surface.
  public_author_name: string | null;
  bio: string | null;
  avatar_path: string | null;
  created_at: string;
};

export type BookStatus = "draft" | "published";

export type Book = {
  id: string;
  author_id: string;
  title: string;
  // LIBRUM 2.0 PUBLISHING-UX-1 PART B (migration 044): subtitle,
  // publisher, edition, and original_publication_date are all
  // author-editable, optional, bibliographic metadata -- see
  // migration 044's own comment for exact semantics/constraints.
  subtitle: string | null;
  description: string;
  preview_text: string;
  keywords: string;
  isbn: string | null;
  // A LanguageCode (src/lib/languages.ts) when set, but typed as a
  // plain string here -- same "a row already in the table is a fact
  // that happened" precedent AuditEventRow.action and
  // FinanceCheckoutExceptionRow.reconciliation_reason already
  // establish -- a future addition to LANGUAGES should never require a
  // type change here, and books.language itself carries no DB CHECK
  // (see migration 044's own comment for why).
  language: string | null;
  publisher: string | null;
  edition: string | null;
  // A `date` column -- serializes as a plain "YYYY-MM-DD" string via
  // supabase-js, same as every other date/timestamp field on this type.
  original_publication_date: string | null;
  genre: string | null;
  series_id: string | null;
  series_position: number | null;
  price_cents: number;
  cover_path: string | null;
  file_path: string | null;
  status: BookStatus;
  // System-authoritative: the moment this book first genuinely
  // transitioned from draft to published, set exactly once by
  // performPublish() (src/app/(public)/dashboard/books/actions.ts).
  // Never author-editable, never re-set by an unpublish/republish
  // cycle. null for a book that has never been published.
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Review = {
  id: string;
  book_id: string;
  reader_id: string;
  rating: number;
  body: string;
  created_at: string;
};

export type Series = {
  id: string;
  author_id: string;
  title: string;
  created_at: string;
};

export type Contributor = {
  id: string;
  book_id: string;
  name: string;
  role: string;
  created_at: string;
};

export type Bundle = {
  id: string;
  author_id: string;
  title: string;
  description: string;
  price_cents: number;
  status: BookStatus;
  created_at: string;
  updated_at: string;
};

export type AuthorFollow = {
  id: string;
  follower_id: string;
  author_id: string;
  created_at: string;
};

export type DiscountCode = {
  id: string;
  author_id: string;
  book_id: string;
  code: string;
  percent_off: number | null;
  amount_off_cents: number | null;
  active: boolean;
  expires_at: string | null;
  created_at: string;
};

// Mirrors refund_requests.status's CHECK constraint (migration 029).
// 'refunded' is only ever reached via the service-role/webhook path --
// no client-facing code in this app can produce it.
export type RefundRequestStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "refunded"
  | "cancelled";

export type RefundRequest = {
  id: string;
  stripe_payment_intent_id: string;
  status: RefundRequestStatus;
  reason: string | null;
  requested_at: string;
};

// Mirrors book_reports.status's CHECK constraint (migration 009,
// unchanged by LAUNCH-FIX-1B MOD-1's migration 039 -- only new columns
// were added, not a new status value).
export type BookReportStatus = "open" | "resolved" | "dismissed";

// Mirrors staff_members.role's CHECK constraint (migration 040, ADMIN-1A).
// A staff role is persisted; permissions are not -- see Permission below
// and src/lib/staff-permissions.ts for the canonical role->permission
// matrix. Distinct from Role above: a profile's Role ('author' | 'reader'
// | 'admin') describes what kind of platform USER someone is, while
// StaffRole describes an entirely separate internal operator grant a
// profile may additionally hold, recorded in staff_members, not profiles.
export type StaffRole = "owner" | "admin" | "editor" | "moderator" | "support";

// Explicit permission identifiers, not vague role checks -- every
// staff-gated authorization decision in this app (TypeScript and SQL
// alike) is expressed in terms of one of these, never a bare role name.
// Kept intentionally small: only permissions with a concrete use in
// current or near-term (ADMIN-1B) admin work exist here -- see the
// ADMIN-1A design brief's own "do not create dozens of speculative
// permissions" instruction.
export type Permission =
  | "admin.access"
  | "reports.view"
  | "reports.resolve"
  | "refunds.view"
  | "refunds.resolve"
  | "staff.view"
  | "staff.manage"
  | "audit.view"
  | "finance.view"
  // LIBRUM 2.0 BLOG-1B: blog.view (read any post, including drafts) and
  // blog.manage (create/edit/publish/unpublish/delete, always through
  // the SECURITY DEFINER RPCs in migration 047 -- see that migration's
  // own header for why blog_posts carries no direct table-level write
  // grant for either permission to act through instead).
  | "blog.view"
  | "blog.manage";

// Mirrors list_staff_members()'s exact return shape (migration 041,
// ADMIN-1B Part B) -- the ONLY place a staff member's email is ever
// exposed to application code, resolved server-side by that single
// joined SECURITY DEFINER query (staff_members + profiles + auth.users)
// rather than any per-row auth.admin lookup. Server-side only: nothing
// in this app ever queries auth.users directly from a browser client.
export type StaffListRow = {
  user_id: string;
  display_name: string;
  email: string;
  role: StaffRole;
  created_at: string;
};

// ADMIN-1C Part B: the closed vocabulary migration 042's
// list_admin_audit_events() RPC validates its p_action/p_target_type
// filters against (supabase/migrations/042_admin_audit_visibility.sql).
// Deliberately separate from AuditEventRow.action/target_type below,
// which stay plain `string`: a row already IN the table is a fact that
// happened, and must render even if a future migration's vocabulary has
// moved on since -- these two types exist for the places that need to
// validate or label a KNOWN value (filter UI, ACTION_LABELS), not for
// narrowing what a raw DB row is allowed to contain.
// ADMIN-1C Part B PRE-FINALIZE CORRECTION: 'refund.review_rejected', not
// the first draft's 'refund.review_denied' -- matches
// refund_requests.status's own actual value ('rejected', migration 029's
// CHECK constraint) exactly, the same discipline report.dismissed
// already follows (book_reports.status's own 'dismissed' value, not a
// softer synonym).
export type AuditAction =
  | "staff.added"
  | "staff.role_changed"
  | "staff.removed"
  | "report.resolved"
  | "report.dismissed"
  | "refund.review_approved"
  | "refund.review_rejected"
  | "refund.issuance_submitted";

export type AuditTargetType = "staff_members" | "book_reports" | "refund_requests";

// Mirrors list_admin_audit_events()'s exact return shape. actor_id/
// actor_display_name are both nullable -- admin_audit_log.actor_id is
// ON DELETE SET NULL (migration 041), and the RPC's own LEFT JOIN to
// profiles means a still-present actor_id whose profile row is gone
// resolves actor_display_name to null rather than dropping the row.
// metadata is intentionally untyped beyond Record<string, unknown> --
// its shape varies per action and is never rendered raw (see
// formatAuditDetails in audit-log-logic.ts), so there is no value in a
// discriminated-union metadata type here.
export type AuditEventRow = {
  id: string;
  actor_id: string | null;
  actor_display_name: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

// ADMIN-1D Part B: the closed vocabulary
// refund_reconciliation_rows()/list_refund_reconciliation_states()
// (supabase/migrations/043_finance_reconciliation_reads.sql) computes
// and validates its p_operational_state filter against. Deliberately
// NOT the same set as RefundRequestStatus above -- this is a derived
// operational classification (refund_requests.status combined with the
// LATEST refund_issuance_attempts row for that request), not a raw
// column value. Critically, 'approved_attempt_stale_initiated' and
// 'approved_attempt_unknown' are both DISTINCT from "Stripe was never
// called" -- the refund-issuance durability ordering (a durable
// 'initiated' row commits BEFORE stripe.refunds.create() ever runs)
// means a stale 'initiated' row can equally mean the call never started,
// is still running past all plausible bounds, or even succeeded on
// Stripe's side before the local completion write landed. Nothing in
// this codebase may ever treat 'approved_attempt_stale_initiated' as
// "safe, nothing happened yet" -- see that migration's own Part 2
// comment for the full reasoning.
export type RefundOperationalState =
  | "requested"
  | "rejected"
  | "refunded"
  | "cancelled"
  | "approved_unattempted"
  | "approved_attempt_initiated"
  | "approved_attempt_stale_initiated"
  | "approved_attempt_unknown"
  | "approved_attempt_failed"
  | "approved_attempt_submitted";

// Mirrors list_refund_reconciliation_states()'s exact return shape.
// reader_id/reader_display_name and latest_attempt_* are all nullable --
// reader_id is ON DELETE SET NULL (migration 038), and a request with
// operational_state 'requested'/'rejected'/'cancelled', or 'approved_
// unattempted', legitimately has no refund_issuance_attempts row at all
// yet. stripe_refund_id/stripe_status are populated only once the
// latest attempt has actually reached Stripe (status 'submitted') --
// null for every earlier state, never fabricated.
export type FinanceRefundReconciliationRow = {
  refund_request_id: string;
  reader_id: string | null;
  reader_display_name: string | null;
  amount_cents: number;
  refund_request_status: RefundRequestStatus;
  requested_at: string;
  reviewed_at: string | null;
  latest_attempt_id: string | null;
  latest_attempt_status: string | null;
  latest_attempt_created_at: string | null;
  latest_attempt_updated_at: string | null;
  stripe_refund_id: string | null;
  stripe_status: string | null;
  operational_state: RefundOperationalState;
  needs_attention: boolean;
};

// Mirrors list_finance_disputes()'s exact return shape.
// transfer_reversal_failure_message is DELIBERATELY never part of this
// type -- that column can hold a raw, unbounded Stripe SDK error string
// (see failTransferReversalAttempt() in
// src/app/api/webhooks/stripe/route.ts), and the RPC itself never
// returns it. transfer_reversal_failure_code IS included -- Stripe's own
// short, bounded error-code taxonomy, safe to surface. status/reason are
// plain strings, not narrowed unions -- payment_disputes.status carries
// no CHECK constraint (Stripe's own vocabulary is open-ended, migration
// 035), so a row already in the table must always render even if it
// carries a value this file's own "known terminal statuses" allow-list
// (used only for the needs_attention computation, entirely inside SQL)
// hasn't seen before.
export type FinanceDisputeRow = {
  id: string;
  stripe_dispute_id: string;
  stripe_payment_intent_id: string;
  reader_id: string | null;
  reader_display_name: string | null;
  status: string;
  reason: string;
  amount_cents: number;
  created_at: string;
  updated_at: string;
  transfer_reversal_status: string;
  stripe_transfer_reversal_id: string | null;
  transfer_reversal_attempt_count: number;
  transfer_reversal_attempted_at: string | null;
  transfer_reversal_succeeded_at: string | null;
  transfer_reversal_failure_code: string | null;
  needs_attention: boolean;
};

// Mirrors list_finance_checkout_exceptions()'s exact return shape --
// single-book checkout reconciliation only (book_checkout_intents). See
// that RPC's own migration comment for why no bundle equivalent exists:
// bundle_checkout_snapshots has no completed_at-equivalent column, so
// "Stripe confirmed payment but Librum failed to fulfill" cannot be
// safely distinguished from "the reader never paid" for a bundle
// checkout with the current schema. reconciliation_reason is always
// non-null for every row this RPC returns (the underlying CHECK
// constraint guarantees it whenever completed_at is set and fulfilled_at
// is null) -- typed as a plain string here anyway, matching
// AuditEventRow.action/target_type's own "a row already in the table is
// a fact that happened" precedent, so a future migration widening the
// reconciliation_reason vocabulary never requires a type change here.
export type FinanceCheckoutExceptionRow = {
  intent_id: string;
  book_id: string | null;
  book_title: string;
  reader_id: string | null;
  reader_display_name: string | null;
  price_cents_at_checkout: number;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  completed_at: string;
  reconciliation_reason: string;
  created_at: string;
};

// Mirrors list_finance_refund_entitlement_mismatches()'s exact return
// shape. Each of the three mismatch_type values is a SAFE-DIRECTION-ONLY
// signal (an EXISTS-based positive finding, never inferred from an
// absence of rows) -- see that RPC's own migration comment for exactly
// why the absence direction is unsafe (a repurchase of the same book
// silently overwrites that book's purchases row's own
// stripe_payment_intent_id, so "zero matching purchases rows" does not
// reliably mean anything by itself).
export type RefundEntitlementMismatchType =
  | "refunded_request_active_purchase"
  | "refunded_request_active_bundle_snapshot"
  | "purchase_refunded_request_unresolved";

export type FinanceRefundEntitlementMismatchRow = {
  mismatch_type: RefundEntitlementMismatchType;
  refund_request_id: string | null;
  purchase_id: string | null;
  bundle_checkout_snapshot_id: string | null;
  reader_id: string | null;
  reader_display_name: string | null;
  stripe_payment_intent_id: string;
  amount_cents: number;
};

// Mirrors get_finance_summary_counts()'s exact return shape -- counts
// only, deliberately no monetary aggregate (see that RPC's own migration
// comment: no SUM(amount_cents) anywhere, since none of these counts
// have a concrete operational use for a dollar total).
export type FinanceSummaryCounts = {
  refund_needs_attention_count: number;
  dispute_needs_attention_count: number;
  checkout_exception_count: number;
  refund_entitlement_mismatch_count: number;
};
