import type { RefundRequestStatus } from "@/lib/types";

export const REFUND_REASON_MAX_LENGTH = 2000;
export const REFUND_ELIGIBILITY_WINDOW_DAYS = 14;

export const GENERIC_REFUND_ERROR_MESSAGE = "Something went wrong. Please try again.";

// The exact string request_refund()/cancel_refund_request() raise via
// `raise exception '...'` in migration 029 -- PostgREST surfaces that
// text verbatim as error.message on the RPC response. auth.uid() being
// null there only happens if the reader's session has actually expired
// between page load and form submission (the page itself already
// redirects unauthenticated visitors before rendering), so it's handled
// as a special case (redirect to login) by the caller, not through the
// generic mapping below.
export const RPC_NOT_AUTHENTICATED_MESSAGE = "not authenticated";

// Every other exception message the two RPCs can raise, mapped to
// reader-facing copy. Deliberately NOT a passthrough of error.message:
// anything not in this list (an unexpected constraint violation, a
// connection error, a Postgres internal error) falls through to
// GENERIC_REFUND_ERROR_MESSAGE instead of ever reaching the reader,
// since those can contain table/column/constraint names or other
// implementation detail that shouldn't be shown.
const KNOWN_RPC_ERROR_MESSAGES: Record<string, string> = {
  "no matching purchase found for this payment intent":
    "We couldn't find a purchase matching this transaction.",
  "this purchase has already been refunded": "This purchase has already been refunded.",
  "this purchase is outside the refund request window":
    "This purchase is no longer eligible for a refund request — requests must be made within 14 days of purchase.",
  "a refund request for this purchase is already open":
    "You already have an open refund request for this purchase.",
  "unable to determine a refundable amount for this payment intent":
    "We couldn't determine a refundable amount for this purchase. Please contact support.",
  "no cancellable refund request found for this id":
    "This refund request can no longer be cancelled.",
  "stripe_payment_intent_id is required":
    "Something went wrong identifying this purchase. Please refresh and try again.",
};

export function mapRefundRpcError(error: { message?: string | null } | null | undefined): string {
  const message = error?.message?.trim();
  if (!message) {
    return GENERIC_REFUND_ERROR_MESSAGE;
  }
  return KNOWN_RPC_ERROR_MESSAGES[message] ?? GENERIC_REFUND_ERROR_MESSAGE;
}

export type RefundReasonValidation =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

// reason is optional on the RPC side (request_refund's p_reason accepts
// null) -- this only ever rejects a reason that's too long, matching
// refund_requests.reason's own `char_length(reason) <= 2000` CHECK
// constraint, so a submission that would fail server-side gets a
// friendly client-side message instead of a raw constraint error.
export function validateRefundReason(raw: FormDataEntryValue | null): RefundReasonValidation {
  if (raw == null) {
    return { ok: true, value: null };
  }
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > REFUND_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `Please keep your reason under ${REFUND_REASON_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

export type PurchaseForGrouping = {
  book_id: string;
  amount_cents: number;
  created_at: string;
  refunded_at: string | null;
  stripe_payment_intent_id: string | null;
};

// The frozen per-item shape create_bundle_checkout_snapshot() writes
// into bundle_checkout_snapshots.items (migration 025) and
// fulfillBundleSnapshot() reads back (src/app/api/webhooks/stripe/
// route.ts's parseSnapshotItems) -- book_id/title/price_cents_at_checkout
// keys, snake_case, exactly as jsonb_build_object wrote them.
export type BundleSnapshotItem = {
  bookId: string;
  title: string;
  priceCentsAtCheckout: number;
};

// What the Library query fetches from bundle_checkout_snapshots for the
// reader's own fulfilled rows (see migration 030's reader SELECT
// policy). items arrives as raw jsonb (`unknown`) -- parsed defensively
// below, same posture as the webhook's own parseSnapshotItems, but
// lenient rather than fail-loud: this is a display path, not a write
// path, so a malformed/unexpected entry is silently skipped rather than
// blocking the whole page.
export type BundleSnapshotForGrouping = {
  id: string;
  stripe_payment_intent_id: string | null;
  total_amount_cents: number | null;
  fulfilled_at: string | null;
  refunded_at: string | null;
  items: unknown;
};

export function parseBundleSnapshotItems(raw: unknown): BundleSnapshotItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: BundleSnapshotItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const bookId = record.book_id;
    const title = record.title;
    const priceCentsAtCheckout = record.price_cents_at_checkout;
    if (typeof bookId !== "string" || bookId.length === 0) continue;
    if (typeof title !== "string") continue;
    if (typeof priceCentsAtCheckout !== "number" || !Number.isFinite(priceCentsAtCheckout)) {
      continue;
    }
    items.push({ bookId, title, priceCentsAtCheckout });
  }
  return items;
}

export type TransactionGroup<T extends PurchaseForGrouping> = {
  key: string;
  stripePaymentIntentId: string | null;
  purchases: T[];
  // True whenever a fulfilled bundle_checkout_snapshots row matched
  // this payment intent -- drives whether the UI shows this as a bundle
  // transaction even when zero (or fewer than the bundle's full item
  // count) purchases rows exist for it.
  hasSnapshot: boolean;
  // The full count of books this checkout covered. Equals
  // purchases.length when there's no snapshot; equals the snapshot's
  // own frozen item count when there is one -- which can be greater
  // than purchases.length whenever some of the bundle's books were
  // already owned through a different transaction and so produced no
  // purchases row here (fulfillBundleSnapshot's "active_other_session"
  // classification).
  bookCount: number;
  // Snapshot items with no matching purchases row in THIS group --
  // i.e. books this checkout covered but did not newly grant, because
  // the reader already owned them via some other transaction. Informational
  // only: never rendered with a download control, and never implies this
  // transaction granted or currently governs ownership of these books --
  // their real ownership/download state lives entirely on their own,
  // separate purchases row (which renders in its own group elsewhere on
  // this page).
  unpurchasedSnapshotItems: BundleSnapshotItem[];
  // Authoritative display total. A matching snapshot's total_amount_cents
  // (the real Stripe-charged amount for this PaymentIntent) is preferred
  // whenever present -- summing only this group's purchases rows would
  // silently understate the charge whenever any bundle item was already
  // owned elsewhere (see unpurchasedSnapshotItems above). Falls back to
  // summing this group's own non-refunded purchases rows only when there
  // is no snapshot at all.
  totalAmountCents: number;
  // Mirrors deriveTransactionRefundState's own priority for "was this
  // transaction actually refunded": purchases.refunded_at when purchases
  // rows exist, OR bundle_checkout_snapshots.refunded_at -- both are set
  // unconditionally and independently by the webhook's charge.refunded
  // handler for exactly this reason (a zero-purchase-rows snapshot has
  // no purchases.refunded_at to ever observe).
  transactionRefunded: boolean;
  // The date request_refund()'s own 14-day check would actually use:
  // earliest purchases.created_at when purchases rows exist for this
  // transaction, else bundle_checkout_snapshots.fulfilled_at -- the
  // exact same fallback order the RPC itself applies.
  eligibilityBasisDate: string;
  // Most recent activity date for this transaction, used only to order
  // groups on the page (newest first) the same way the ungrouped
  // purchases list always has been.
  mostRecentDate: string;
};

type RawTransactionGroup<T extends PurchaseForGrouping> = {
  key: string;
  stripePaymentIntentId: string | null;
  purchases: T[];
  snapshot: BundleSnapshotForGrouping | null;
};

function finalizeTransactionGroup<T extends PurchaseForGrouping>(
  group: RawTransactionGroup<T>,
): TransactionGroup<T> {
  const purchasedBookIds = new Set(group.purchases.map((p) => p.book_id));
  const snapshotItems = group.snapshot ? parseBundleSnapshotItems(group.snapshot.items) : [];
  const unpurchasedSnapshotItems = snapshotItems.filter(
    (item) => !purchasedBookIds.has(item.bookId),
  );

  const nonRefundedPurchasesTotal = group.purchases
    .filter((p) => !p.refunded_at)
    .reduce((sum, p) => sum + p.amount_cents, 0);
  const totalAmountCents = group.snapshot?.total_amount_cents ?? nonRefundedPurchasesTotal;

  const transactionRefunded =
    group.purchases.some((p) => Boolean(p.refunded_at)) || Boolean(group.snapshot?.refunded_at);

  const purchaseDates = group.purchases.map((p) => p.created_at);
  const eligibilityBasisDate =
    purchaseDates.length > 0
      ? purchaseDates.reduce((earliest, date) => (date < earliest ? date : earliest))
      : (group.snapshot?.fulfilled_at ?? "");
  const mostRecentDate =
    purchaseDates.length > 0
      ? purchaseDates.reduce((latest, date) => (date > latest ? date : latest))
      : (group.snapshot?.fulfilled_at ?? "");

  return {
    key: group.key,
    stripePaymentIntentId: group.stripePaymentIntentId,
    purchases: group.purchases,
    hasSnapshot: group.snapshot !== null,
    bookCount:
      snapshotItems.length > 0 ? snapshotItems.length : group.purchases.length,
    unpurchasedSnapshotItems,
    totalAmountCents,
    transactionRefunded,
    eligibilityBasisDate,
    mostRecentDate,
  };
}

// Groups purchase rows AND fulfilled bundle checkout snapshots by
// Stripe PaymentIntent into one entry per actual paid transaction. A
// refund request is always for the WHOLE transaction, never an
// individual book (request_refund() in migration 029 takes only a
// payment-intent id, not a book or purchase id) -- and, critically, a
// transaction's true shape can only be fully known from its snapshot
// when one exists: purchases rows alone can under-represent it (see
// bookCount/unpurchasedSnapshotItems/totalAmountCents above).
//
// - Purchases rows sharing one payment intent (an ordinary fully-
//   eligible bundle checkout) merge into one group, same as before this
//   correction.
// - A payment intent with BOTH purchases rows and a matching snapshot
//   (the partial-eligibility case: some bundle items were already owned
//   elsewhere) merges into one group whose total/book count come from
//   the snapshot, not just the purchases subset.
// - A payment intent with a fulfilled snapshot but NO purchases rows at
//   all (the zero-eligible-item case) still produces exactly one group
//   -- this is the entire point of this correction: that transaction is
//   otherwise completely invisible in the Library.
// - Rows with no stripe_payment_intent_id (free acquisitions -- see
//   acquireFreeBook() in src/app/books/[id]/actions.ts, which sets it to
//   null) never had a real Stripe transaction to refund, so each gets
//   its own untouched, ungrouped entry, exactly as before.
// - A snapshot with no stripe_payment_intent_id (a genuinely free/$0
//   bundle -- Stripe never issues a PaymentIntent for a $0 Checkout
//   Session) has nothing refundable and is skipped entirely; it can
//   never be matched to a group.
export function groupPurchasesByTransaction<T extends PurchaseForGrouping>(
  purchases: T[],
  snapshots: BundleSnapshotForGrouping[] = [],
): TransactionGroup<T>[] {
  const raw = new Map<string, RawTransactionGroup<T>>();
  let freeAcquisitionIndex = 0;

  for (const purchase of purchases) {
    const key = purchase.stripe_payment_intent_id ?? `__free_${freeAcquisitionIndex++}`;
    const existing = raw.get(key);
    if (existing) {
      existing.purchases.push(purchase);
    } else {
      raw.set(key, {
        key,
        stripePaymentIntentId: purchase.stripe_payment_intent_id,
        purchases: [purchase],
        snapshot: null,
      });
    }
  }

  for (const snapshot of snapshots) {
    const paymentIntentId = snapshot.stripe_payment_intent_id;
    if (!paymentIntentId) continue;
    const existing = raw.get(paymentIntentId);
    if (existing) {
      existing.snapshot = snapshot;
    } else {
      raw.set(paymentIntentId, {
        key: paymentIntentId,
        stripePaymentIntentId: paymentIntentId,
        purchases: [],
        snapshot,
      });
    }
  }

  return Array.from(raw.values())
    .map((group) => finalizeTransactionGroup(group))
    .sort((a, b) => (a.mostRecentDate < b.mostRecentDate ? 1 : -1));
}

// "Total spent" for the reader's Library page, derived from the same
// deduplicated transaction model groupPurchasesByTransaction produces --
// never re-summed independently from raw purchases rows, which would
// either double-count a normal bundle (once via its purchases rows,
// again via its snapshot) or omit a zero-purchase snapshot transaction
// entirely (the original gap this whole correction exists to close).
//
// One monetary transaction per stripe_payment_intent_id: group.
// totalAmountCents is already the authoritative per-transaction amount
// (snapshot total when one exists, else the purchases-derived subtotal
// -- see TransactionGroup's own documentation), so summing it once per
// group is correct by construction, with no risk of double-counting a
// transaction that happens to have both purchases rows and a snapshot.
//
// Excludes two categories entirely, matching the pre-existing "Total
// spent" semantics this replaces (which filtered out purchases.
// refunded_at rows) extended consistently to the transaction level:
// - stripePaymentIntentId === null: a free acquisition never had a real
//   Stripe transaction, so it isn't a monetary transaction at all (it
//   would contribute exactly 0 either way, since amount_cents is always
//   0 for one -- excluded explicitly anyway, for correctness of intent
//   rather than as a numeric no-op).
// - transactionRefunded: this system is full-transaction-only (see the
//   approved Phase REFUND-1B decisions -- there is no partial-refund
//   concept anywhere in this design, and the webhook's charge.refunded
//   handler always marks every purchases row sharing a payment intent,
//   plus that payment intent's own snapshot row if any, refunded
//   together in the same event), so "refunded" is always all-or-nothing
//   per transaction -- there is no partial-refund case to invent
//   semantics for here.
export function calculateTotalSpentCents<T extends PurchaseForGrouping>(
  groups: TransactionGroup<T>[],
): number {
  return groups
    .filter((group) => group.stripePaymentIntentId !== null && !group.transactionRefunded)
    .reduce((sum, group) => sum + group.totalAmountCents, 0);
}

export type TransactionRefundUiState = {
  statusLabel: RefundRequestStatus | null;
  showRequestButton: boolean;
  showCancelButton: boolean;
};

// Pure status -> action mapping, kept separate from rendering so it can
// be exhaustively unit tested. transactionRefunded (TransactionGroup's
// own field -- purchases.refunded_at when purchases rows exist, else
// bundle_checkout_snapshots.refunded_at for a zero-purchase-rows
// snapshot transaction; see groupPurchasesByTransaction) takes priority
// over the refund_requests row's own status: a direct Stripe Dashboard
// refund with no prior request (a legitimate terminal state -- see
// refund_requests.reviewed_at's own comment in migration 029) would
// otherwise show no status at all.
//
// requested -> only cancellable action (review_refund_request /
// cancel_refund_request are the only two ways off "requested", and this
// phase only ever wires up the latter). approved -> no reader action;
// awaiting the (not-yet-built) refund execution step. rejected/
// cancelled -> terminal for that request, but request_refund() itself
// still permits a fresh request against the same payment intent once
// the prior one is no longer 'requested'/'approved' (see the migration's
// own open-request check), so the UI offers "Request refund" again
// rather than dead-ending the reader.
export function deriveTransactionRefundState(params: {
  transactionRefunded: boolean;
  latestRequestStatus: RefundRequestStatus | null;
}): TransactionRefundUiState {
  const { transactionRefunded, latestRequestStatus } = params;

  if (transactionRefunded || latestRequestStatus === "refunded") {
    return { statusLabel: "refunded", showRequestButton: false, showCancelButton: false };
  }

  if (latestRequestStatus === "requested") {
    return { statusLabel: "requested", showRequestButton: false, showCancelButton: true };
  }

  if (latestRequestStatus === "approved") {
    return { statusLabel: "approved", showRequestButton: false, showCancelButton: false };
  }

  if (latestRequestStatus === "rejected") {
    return { statusLabel: "rejected", showRequestButton: true, showCancelButton: false };
  }

  if (latestRequestStatus === "cancelled") {
    return { statusLabel: "cancelled", showRequestButton: true, showCancelButton: false };
  }

  return { statusLabel: null, showRequestButton: true, showCancelButton: false };
}

// Presentational-only hint, mirroring request_refund()'s own 14-day
// check (`v_earliest_created_at < now() - interval '14 days'`, falling
// back to bundle_checkout_snapshots.fulfilled_at when there are no
// purchases rows -- see TransactionGroup.eligibilityBasisDate) so the UI
// can avoid showing a "Request refund" button that would just fail --
// but this is advisory only. The RPC re-checks the real window itself
// from the database's own clock and purchase/snapshot rows every time;
// nothing here is trusted as the actual eligibility decision.
export function isWithinRefundEligibilityWindow(
  basisDate: string,
  now: Date = new Date(),
): boolean {
  const basisMs = Date.parse(basisDate);
  if (!Number.isFinite(basisMs)) {
    return false;
  }
  const windowMs = REFUND_ELIGIBILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() - basisMs < windowMs;
}
