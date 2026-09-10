// PHASE-1C correction pass 2, items 2, 4, 7: the complete, exact-ID-
// traversal reset disposition matrix. Pure data + pure functions only
// -- no Supabase import, no I/O. The orchestrator (reset.mts) is what
// actually executes these against a real client; this module is what
// makes the MATRIX ITSELF (ordering, protected-table list, traversal
// shape) independently testable without any database.
//
// "delete", "cascade", "preserve", and "hard_stop" match exactly the
// four dispositions required by the design review: "delete using exact
// resolved fixture IDs," "removed through a specifically identified
// cascade," "preserve," "preflight hard-stop."
export type Disposition = "delete" | "cascade" | "preserve" | "hard_stop";

export type TableDisposition = {
  table: string;
  resetToBaseline: Disposition;
  teardown: Disposition;
  // Human-readable description of the exact ID traversal used to find
  // fixture-linked rows in this table -- never a title/email substring/
  // path-prefix/other fuzzy match. Absent for "cascade" (removed as a
  // side effect of a parent's own "delete") and "preserve" (never
  // queried by ID at all, e.g. payout_minimum_policy which has no
  // author/reader column whatsoever).
  traversal?: string;
  note?: string;
  // PHASE-1C review round 3, item 3 / round 4, item 4: some "hard_stop"
  // tables have `revoke all ... from anon, authenticated, service_role`
  // in schema.sql (confirmed directly: author_payout_destinations
  // schema.sql:8503, payout_destination_snapshots:8558,
  // payout_reversal:8638) -- the service-role Data API this design's
  // client authenticates as has ZERO direct-table privilege on them, so
  // an ordinary REST count query cannot even be attempted (it would
  // fail with a permission error, not return a trustworthy zero). A
  // round-3 human-attestation-boolean workaround was REJECTED by
  // round-4 review ("must actually obtain the required counts") --
  // corrected to a real, narrowly scoped, SECURITY DEFINER, count-only
  // RPC instead: `public.staging_fixture_protected_table_counts(uuid)`
  // (migration 057), which discloses nothing but a row count per table,
  // is EXECUTE-granted ONLY to service_role (never public/anon/
  // authenticated), and has a fixed, empty search_path. Marked true
  // here purely as documentation of WHICH tables are counted via that
  // RPC instead of a direct `.from(table).select(..., {count})` call --
  // reset.mts's preflight treats every protectedTables() entry
  // uniformly; only live-deps.mts's query implementation differs by
  // table. Never weakens the table's own grants.
  queriedViaRpc?: boolean;
};

// Ordered top-to-bottom exactly as reset.mts must execute deletes --
// every RESTRICT-dependent child table appears strictly before the
// parent it would otherwise block. Traversals reference the resolved
// fixture author id (FID), reader id (RID), the 5 fixture book ids
// (BOOK_IDS), the fixture series id (SERIES_ID), and the fixture bundle
// id (BUNDLE_ID) -- all resolved/known before any DELETE is issued (see
// preflight in reset.mts).
export const DISPOSITION_MATRIX: readonly TableDisposition[] = [
  {
    table: "refund_request_items",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE book_id = ANY(BOOK_IDS)",
    note: "RESTRICT on books.id -- must be deleted before `books`.",
  },
  {
    table: "bundle_checkout_reader_holds",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE reader_id = RID",
    note: "RESTRICT on profiles.id -- must be deleted before any Auth-user delete (teardown).",
  },
  {
    table: "bundle_checkout_reservations",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE book_id = ANY(BOOK_IDS)",
  },
  {
    table: "book_checkout_intents",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE reader_id = RID OR book_id = ANY(BOOK_IDS)",
  },
  {
    table: "refund_requests",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE reader_id = RID",
    note: "Contingent on the `purchases` partition check clearing first (see classifyPurchase).",
  },
  {
    table: "reviews",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE reader_id = RID OR book_id = ANY(BOOK_IDS)",
  },
  {
    table: "wishlist_items",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE reader_id = RID OR book_id = ANY(BOOK_IDS)",
  },
  {
    table: "author_follows",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE follower_id = RID OR author_id = FID",
  },
  {
    table: "book_reports",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE book_id = ANY(BOOK_IDS) OR reporter_id = RID",
  },
  {
    table: "purchases",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "see classifyPurchase() -- partitioned, never a blanket delete",
    note: "RESTRICT on books.id -- must be deleted before `books`. Only synthetic-prefix and $0/no-payments rows are deleted; anything else is a preflight hard-stop (see classifyPurchase).",
  },
  {
    table: "bundle_checkout_snapshots",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE bundle_id = BUNDLE_ID OR author_id = FID OR reader_id = RID",
    note: "Commercial/audit evidence per its own schema.sql comment -- never silently deleted.",
  },
  {
    table: "discount_codes",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE author_id = FID",
  },
  { table: "book_contributors", resetToBaseline: "cascade", teardown: "cascade", note: "cascades from `books` delete" },
  { table: "book_views", resetToBaseline: "cascade", teardown: "cascade", note: "cascades from `books` delete" },
  { table: "bundle_books", resetToBaseline: "cascade", teardown: "cascade", note: "cascades from `bundles`/`books` delete" },
  { table: "bundles", resetToBaseline: "delete", teardown: "delete", traversal: "WHERE author_id = FID" },
  {
    table: "books",
    resetToBaseline: "delete",
    teardown: "delete",
    traversal: "WHERE author_id = FID",
    note: "Only after `purchases`/`refund_request_items` are cleared (RESTRICT).",
  },
  { table: "series", resetToBaseline: "delete", teardown: "delete", traversal: "WHERE author_id = FID" },

  // ---- Protected financial / payout / audit / staff / blog tables ----
  // All "hard_stop": checked in PREFLIGHT (before ANY mutation), never
  // silently deleted. This design never legitimately populates any of
  // these for a fixture account; a non-zero count is an anomaly to
  // escalate, not routine data to clean up.
  { table: "payments", resetToBaseline: "hard_stop", teardown: "hard_stop", traversal: "WHERE buyer_id = RID" },
  {
    table: "author_payouts",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE author_id = FID",
  },
  {
    table: "author_ledger_entries",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE author_id = FID",
  },
  {
    table: "author_payout_settings",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE author_id = FID",
  },
  {
    table: "author_payout_destinations",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE author_id = FID",
    queriedViaRpc: true,
    note: "revoke all ... from anon, authenticated, service_role (schema.sql:8503) -- unreachable via a direct REST count. Counted via public.staging_fixture_protected_table_counts(FID) instead (migration 057). See queriedViaRpc.",
  },
  {
    table: "payout_destination_snapshots",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE payout_id IN (SELECT id FROM author_payouts WHERE author_id = FID)",
    queriedViaRpc: true,
    note: "revoke all ... from anon, authenticated, service_role (schema.sql:8558) -- unreachable via a direct REST count. Also structurally immutable: a trigger unconditionally rejects UPDATE/DELETE on this table (schema.sql:8569) regardless. Counted via public.staging_fixture_protected_table_counts(FID) instead (migration 057). See queriedViaRpc.",
  },
  {
    table: "payout_reversal",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE payout_id IN (SELECT id FROM author_payouts WHERE author_id = FID)",
    queriedViaRpc: true,
    note: "revoke all ... from anon, authenticated, service_role (schema.sql:8638) -- unreachable via a direct REST count. Counted via public.staging_fixture_protected_table_counts(FID) instead (migration 057). See queriedViaRpc.",
  },
  {
    table: "payment_refunds",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal:
      "WHERE purchase_id IN (SELECT id FROM purchases WHERE reader_id = RID OR book_id = ANY(fixtureAuthorBookIds))",
    note: "Both halves of the OR are required -- a purchase of a fixture-author's book BY SOME OTHER READER would be missed by a reader_id-only check (PHASE-1C review round 3, item 3).",
  },
  {
    table: "payment_disputes",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal:
      "WHERE stripe_payment_intent_id IN (SELECT stripe_payment_intent_id FROM purchases WHERE (reader_id = RID OR book_id = ANY(fixtureAuthorBookIds)) AND stripe_payment_intent_id IS NOT NULL)",
    note: "No real FK exists (keyed only by text stripe_payment_intent_id) -- joined through the fixture-linked purchases' OWN real stripe_payment_intent_id values, not hardcoded to our synthetic constant (PHASE-1C review round 3, item 3: a hardcoded-zero check cannot detect a real dispute against a real purchase).",
  },
  { table: "payout_minimum_policy", resetToBaseline: "preserve", teardown: "preserve", note: "Global, currency-keyed only -- no author/reader column exists at all; never fixture-scoped." },
  {
    table: "blog_posts",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE created_by = FID",
  },
  {
    table: "staff_members",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal: "WHERE user_id = FID OR user_id = RID",
  },
  {
    table: "admin_audit_log",
    resetToBaseline: "preserve",
    teardown: "preserve",
    traversal: "WHERE actor_id = FID OR actor_id = RID (informational count only)",
    note: "SET NULL, not RESTRICT -- audit-integrity intent is to survive actor deletion, never deleted by this design.",
  },
  // PHASE-1C mandatory correction, item 6: refund_issuance_attempts.
  // refund_request_id is `references public.refund_requests(id) on
  // delete restrict` (schema.sql:3704) -- a RESTRICT relationship the
  // original matrix missed entirely (it only accounted for
  // actor_id's SET NULL). Since `refund_requests` is itself a "delete"
  // disposition table above, deleting a fixture-linked refund_requests
  // row while a refund_issuance_attempts row still references it would
  // hard-fail mid-mutation. Corrected to a preflight hard-stop instead
  // -- a real issuance attempt against a fixture account also implies
  // real Stripe refund activity occurred, which is exactly the kind of
  // unexpected financial evidence this design escalates rather than
  // silently deletes.
  {
    table: "refund_issuance_attempts",
    resetToBaseline: "hard_stop",
    teardown: "hard_stop",
    traversal:
      "WHERE refund_request_id IN (SELECT id FROM refund_requests WHERE reader_id = RID)",
    note: "refund_request_id is RESTRICT on refund_requests.id (schema.sql:3704) -- deleting refund_requests while this is non-zero would otherwise hard-fail mid-mutation.",
  },

  // ---- Identity tables ----
  {
    table: "profiles",
    resetToBaseline: "preserve",
    teardown: "cascade",
    note: "reset-to-baseline: converged via UPDATE, never deleted directly. teardown: removed via cascade from the auth.users delete (last step).",
  },
  {
    table: "auth.users",
    resetToBaseline: "preserve",
    teardown: "delete",
    note: "reset-to-baseline NEVER touches Auth users. teardown deletes both, last, only after every table above has cleared preflight and every non-protected row has been deleted.",
  },
] as const;

export function tablesWithDisposition(
  mode: "resetToBaseline" | "teardown",
  disposition: Disposition,
): readonly TableDisposition[] {
  return DISPOSITION_MATRIX.filter((t) => t[mode] === disposition);
}

export function protectedTables(mode: "resetToBaseline" | "teardown" = "resetToBaseline"): readonly string[] {
  return tablesWithDisposition(mode, "hard_stop").map((t) => t.table);
}

// PHASE-1C review round 4, item 4: the subset of protectedTables() that
// is counted via public.staging_fixture_protected_table_counts(uuid)
// (migration 057) rather than a direct REST count query -- see
// TableDisposition.queriedViaRpc. Every one of these is STILL checked
// automatically, in the same uniform preflight loop as every other
// protected table (reset.mts's preflight makes no distinction) -- only
// live-deps.mts's query implementation differs by table.
export function rpcOnlyProtectedTables(mode: "resetToBaseline" | "teardown" = "resetToBaseline"): readonly string[] {
  return DISPOSITION_MATRIX.filter((t) => t[mode] === "hard_stop" && t.queriedViaRpc === true).map((t) => t.table);
}

// The exact ordered list reset.mts must delete in -- "delete"
// dispositions only, in the array's own order (already RESTRICT-safe:
// every child appears before its parent, verified by
// dispositions.test.ts).
export function orderedDeleteTables(mode: "resetToBaseline" | "teardown" = "resetToBaseline"): readonly string[] {
  return tablesWithDisposition(mode, "delete").map((t) => t.table);
}

// PHASE-1C review round 3, item 2: which "delete"-disposition tables
// are RECREATED by reseeding (their postcondition after reset-to-
// baseline is "contains exactly the baseline rows," never "empty") vs.
// purely transient QA data (postcondition is "empty"). `bundle_books`
// is included even though its own disposition is "cascade" (not
// "delete") -- it's still recreated by seeding and still needs its own
// postcondition check.
export const BASELINE_RESEEDED_TABLES = [
  "series",
  "books",
  "book_contributors",
  "bundle_books",
  "bundles",
  "discount_codes",
  "purchases",
] as const;

export function transientOnlyDeleteTables(mode: "resetToBaseline" | "teardown" = "resetToBaseline"): readonly string[] {
  const baseline = new Set<string>(BASELINE_RESEEDED_TABLES);
  return orderedDeleteTables(mode).filter((t) => !baseline.has(t));
}

// ============================================================
// `purchases` classification (PHASE-1C mandatory correction, item 5):
// never a blanket delete, and never classified on a single field.
// Every purchase row fetched during preflight (WHERE reader_id = RID OR
// book_id = ANY(fixtureAuthorBookIds) -- fixtureAuthorBookIds is the
// FULL set of books discovered as owned by the fixture author during
// preflight, a superset of the 5 manifest ids that also covers any
// transient book Phase 2 QA created) is classified by its COMPLETE
// identity, never by amount or Stripe-id shape alone.
// ============================================================

export type FixturePurchaseRow = {
  id: string;
  readerId: string;
  bookId: string;
  amountCents: number;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  regime: string;
  // purchases.payment_id references payments(id) ON DELETE RESTRICT
  // (schema.sql:6364-6365) -- true when that column is non-null, i.e.
  // this purchase is linked to a real payments row.
  hasLinkedPaymentId: boolean;
};

export type ExpectedSyntheticPurchase = {
  id: string;
  readerId: string;
  bookId: string;
  amountCents: number;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string;
  regime: string;
};

export type PurchaseClassification =
  | { kind: "safe_delete_synthetic" }
  | { kind: "safe_delete_free_acquisition" }
  | { kind: "hard_stop_unexplained" };

export function classifyPurchase(
  row: FixturePurchaseRow,
  ctx: {
    fixtureReaderId: string;
    fixtureAuthorBookIds: readonly string[];
    expectedSynthetic: ExpectedSyntheticPurchase;
  },
): PurchaseClassification {
  // "A seeded synthetic purchase is safe only when ALL expected fixture
  // identity fields match" -- every field, not just the payment-intent
  // id.
  const isExpectedSynthetic =
    row.id === ctx.expectedSynthetic.id &&
    row.readerId === ctx.expectedSynthetic.readerId &&
    row.bookId === ctx.expectedSynthetic.bookId &&
    row.amountCents === ctx.expectedSynthetic.amountCents &&
    row.stripeCheckoutSessionId === ctx.expectedSynthetic.stripeCheckoutSessionId &&
    row.stripePaymentIntentId === ctx.expectedSynthetic.stripePaymentIntentId &&
    row.regime === ctx.expectedSynthetic.regime &&
    !row.hasLinkedPaymentId;
  if (isExpectedSynthetic) {
    return { kind: "safe_delete_synthetic" };
  }

  // "A free acquisition is safe only when reader_id is the fixture
  // reader, book_id belongs to a book owned by the fixture author
  // discovered during preflight, amount is zero, Stripe identifiers are
  // absent, and no payment/refund/ledger evidence exists."
  const isSafeFreeAcquisition =
    row.readerId === ctx.fixtureReaderId &&
    ctx.fixtureAuthorBookIds.includes(row.bookId) &&
    row.amountCents === 0 &&
    row.stripeCheckoutSessionId === null &&
    row.stripePaymentIntentId === null &&
    !row.hasLinkedPaymentId;
  if (isSafeFreeAcquisition) {
    return { kind: "safe_delete_free_acquisition" };
  }

  // Every other shape -- an unrelated reader, a purchase for a book not
  // owned by the fixture author, a non-zero amount without the exact
  // synthetic identity, a linked payments row, or any other mismatch --
  // is unexplained and must hard-stop, never be silently skipped.
  return { kind: "hard_stop_unexplained" };
}
