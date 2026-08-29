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
  bio: string | null;
  avatar_path: string | null;
  created_at: string;
};

export type BookStatus = "draft" | "published";

export type Book = {
  id: string;
  author_id: string;
  title: string;
  description: string;
  preview_text: string;
  keywords: string;
  isbn: string | null;
  genre: string | null;
  series_id: string | null;
  series_position: number | null;
  price_cents: number;
  cover_path: string | null;
  file_path: string | null;
  status: BookStatus;
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
  | "staff.manage";

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
