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
