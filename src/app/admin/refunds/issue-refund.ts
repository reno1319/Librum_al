import type Stripe from "stripe";
import type { createClient } from "@/lib/supabase/server";

// Deterministic, per-refund-request Stripe idempotency key for a
// request's FIRST Stripe refund attempt. Stripe's idempotency-key
// support (confirmed directly against the installed SDK, stripe@22.5.0
// -- RequestOptions.idempotencyKey?: string, accepted as the second
// argument to any resource call including refunds.create()) guarantees
// that every call made with this exact key for this exact refund request
// resolves to the SAME Refund object -- a double-click, a browser retry,
// a Next.js action retry, or two concurrent admin tabs hitting "Issue
// refund" for the same request, all for the SAME attempt, all collapse
// to one real Stripe refund operation, enforced by Stripe's own servers,
// not by anything Librum tracks locally. Scoped to the refund_requests
// row's id specifically (not the payment intent alone): migration 029's
// own partial unique index guarantees at most one 'requested'/'approved'
// row can exist per payment intent at a time, so this is already as
// precise as it needs to be.
//
// Retry/idempotency-retention audit (REFUND-1B Step 5, THIRD correction
// -- a second look at what the prior correction claimed). Re-checked
// against Stripe's own official idempotent-requests documentation
// (direct fetch to docs.stripe.com is blocked by this environment's
// network egress proxy; the exact sentences below were recovered via
// search-engine snippet extraction FROM that page, not paraphrased by a
// third party, so they're cited as close to verbatim as this environment
// allows):
//   "You can remove keys from the system automatically after they're at
//   least 24 hours old. We generate a new request if a key is reused
//   after the original is pruned." -- and separately, on replay
//   behavior: Stripe saves the resulting status code and body of the
//   FIRST request made for a given key, and every subsequent request
//   with that same key returns that same saved result, regardless of
//   whether the first one succeeded or failed.
//
// The prior version of this comment claimed "after 24h it executes
// fresh" as though 24h were a hard upper bound. That overstates what
// Stripe actually commits to: "at least 24 hours old" is a MINIMUM
// retention guarantee before a key becomes ELIGIBLE for pruning, not a
// promise that pruning happens AT exactly 24h -- Stripe names no upper
// bound on how much later than 24h an eligible key might actually be
// removed. Depending on prompt pruning to unblock a legitimate retry is
// therefore not a safe architectural claim, and an admin whose refund
// genuinely failed could be stuck indefinitely if this key were left as
// the only mechanism for retrying.
//
// The corrected design does not depend on key expiration AT ALL for
// legitimate retries. It uses the Stripe Refund objects that already
// exist -- refund.id, refund.status, and their relationship to the
// PaymentIntent -- rather than any new Librum-side state (no DB attempt
// counter, no migration): see determineRefundAttempt below, which lists
// Stripe's own live refunds for the PaymentIntent immediately before
// every attempt and derives which key to use FROM that live state. This
// key remains exactly what it always was: the identifier for a
// request's FIRST-ever Stripe refund attempt (used only when no prior
// refund exists yet for this PaymentIntent).
export function buildRefundIdempotencyKey(refundRequestId: string): string {
  return `refund-request-${refundRequestId}`;
}

// Deterministic idempotency key for a RETRY, chained off the specific
// Stripe Refund object that most recently reached a terminal failed/
// canceled state. Using the failed/canceled refund's own `id` (rather
// than, say, a wall-clock timestamp or a Librum-side counter) means the
// key for "the next attempt after refund X" is itself fully determined
// by Stripe's own data -- any two callers who independently observe the
// same latest-failed refund X (e.g. two concurrent admin tabs both
// retrying after the same failure) derive the exact same key and
// therefore collapse to one real Stripe operation, for the exact same
// reason buildRefundIdempotencyKey's base key does for a first attempt.
// A chain of repeated failures (R1 fails -> retry creates R2 off R1 ->
// R2 fails -> retry creates R3 off R2 -> ...) produces a distinct,
// deterministic key at every step, since each derived key is chained off
// a DIFFERENT refund id than the one before it.
export function buildRetryIdempotencyKey(
  refundRequestId: string,
  previousFailedRefundId: string,
): string {
  return `${buildRefundIdempotencyKey(refundRequestId)}-after-${previousFailedRefundId}`;
}

export type RefundAttemptPlan =
  | { kind: "blocked" }
  | { kind: "ready"; idempotencyKey: string };

type StripeClient = Pick<Stripe, "refunds">;

// Stripe's own per-page maximum (PaginationParams.limit: 1-100, default
// 10) -- passed as BOTH the page size to .list() and the total cap to
// .autoPagingToArray() below, so a single page already covers Librum's
// realistic case (a small handful of refund attempts per transaction, at
// most) without needing more than one round trip. If the live count ever
// reaches this cap, determineRefundAttempt treats that as "cannot prove
// the full set was inspected" and fails closed -- see below.
const REFUND_LIST_INSPECTION_CAP = 100;

// Pre-flight check run immediately before every Stripe refund attempt --
// lists Stripe's own LIVE refunds for this PaymentIntent (never a cached
// or previously-fetched view) and decides, from that live state alone,
// whether a new refunds.create() call should even be attempted, and with
// which idempotency key. This is the mechanism that satisfies "a
// terminal failed/canceled Refund must permit an intentional later
// retry" WITHOUT depending on Stripe's own key-pruning timing at all
// (see buildRefundIdempotencyKey's own audit above for why that would be
// unsafe to rely on).
//
// REFUND-1B Step 5, FOURTH correction: an earlier version of this
// function based its decision on only the LATEST refund by `created`.
// That was a real defect -- a transaction can have MULTIPLE refunds
// (e.g. R1 an out-of-band succeeded partial refund, R2 a later failed
// one; or R1 still pending, R2 already failed/canceled), and inspecting
// only the latest could miss an earlier succeeded or in-flight refund
// entirely, wrongly permitting a new Stripe operation. This version
// evaluates the WHOLE relevant refund set on every call, not merely its
// most recent member:
//   1. ANY succeeded refund anywhere in the set (full or partial -- see
//      below for why "partial" is deliberately not distinguished) blocks
//      a new attempt.
//   2. ANY pending/requires_action refund anywhere in the set blocks a
//      new attempt.
//   3. Only once EVERY refund in the set is terminal failed/canceled
//      does a retry proceed, chained off the latest one of those.
//
// Pagination: .list() is called with the maximum page size Stripe
// allows (REFUND_LIST_INSPECTION_CAP = 100), and .autoPagingToArray()
// (a real method on the installed SDK's ApiListPromise, confirmed in
// node_modules/stripe/cjs/lib.d.ts) is given the same total cap -- this
// is the SDK's own documented mechanism for walking every page of a
// list up to that count, not something this function reimplements. If
// the live result reaches that cap, this function cannot prove it saw
// every refund on the PaymentIntent (a scenario Librum's own
// no-partial-refund product design never produces on its own, but not
// one to silently assume away) -- it fails closed rather than risk
// missing a succeeded or in-flight refund past the cap. See the
// REFUND_LIST_INSPECTION_CAP branch below.
//
// Ordering for the retry-key derivation specifically: RefundResource.
// list()'s own doc comment confirms Stripe already returns refunds
// "with the most recent refunds appearing first," but this sorts
// explicitly by each refund's own `created` timestamp anyway, with a
// deterministic (non-locale-aware) string comparison on `id` as a
// tie-break for equal timestamps -- so two independent callers
// inspecting the identical live refund set always agree on which one is
// "latest" and therefore always derive the identical retry key, without
// depending on an unstated pagination/ordering assumption or on
// wall-clock precision.
//
// Deliberately does NOT try to distinguish a FULL succeeded refund from
// a PARTIAL one (which would require an extra Stripe Charge lookup to
// compare against the charge's own amount): Librum has no partial-refund
// product concept anywhere, so ANY succeeded refund found on this
// PaymentIntent -- whether it happens to be the full amount or, only
// reachable via an out-of-band manual Dashboard action, a merely partial
// one -- is treated the same way: refuse to originate a new Stripe
// operation. The webhook (processRefundLifecycleEvent /
// isChargeFullyRefundedBySucceededRefunds) is the only thing that ever
// decides whether Librum's own DB gets finalized, and it already will
// not finalize on a merely-partial succeeded refund -- so this
// deliberately conservative pre-flight can never silently misrepresent a
// partial refund as a completed one; it only ever prevents this admin
// action from adding a SECOND Stripe operation on top of an already-
// atypical (for Librum) refund history. That state, if it ever arises,
// needs a human to resolve it directly (e.g. in the Stripe Dashboard),
// not another automatic refund attempt from here.
//
// A refund carrying a status this function doesn't recognize (installed
// SDK types Refund.status as a plain `string | null`, not a closed
// union, precisely because Stripe can introduce new values) is treated
// the same as pending/in-flight -- fail closed rather than assume an
// unrecognized status is safe to retry over.
//
// This pre-flight is a UX/correctness optimization, not the actual
// safety mechanism -- even if two concurrent calls' pre-flight reads
// happened to race, the derived key each one computes is deterministic
// given what it actually observed, and Stripe's own idempotency-key
// collision handling is what ultimately guarantees at most one real
// Stripe operation for a given key.
export async function determineRefundAttempt(
  stripeClient: StripeClient,
  paymentIntentId: string,
  refundRequestId: string,
): Promise<RefundAttemptPlan> {
  const refunds = await stripeClient.refunds
    .list({ payment_intent: paymentIntentId, limit: REFUND_LIST_INSPECTION_CAP })
    .autoPagingToArray({ limit: REFUND_LIST_INSPECTION_CAP });

  if (refunds.length >= REFUND_LIST_INSPECTION_CAP) {
    console.warn(
      "Admin refund issuance: refund count for this PaymentIntent may exceed the inspection cap -- blocking rather than risk an incomplete safety check",
      { refundRequestId, paymentIntentId, inspectedCount: refunds.length },
    );
    return { kind: "blocked" };
  }

  if (refunds.length === 0) {
    return { kind: "ready", idempotencyKey: buildRefundIdempotencyKey(refundRequestId) };
  }

  if (refunds.some((refund) => refund.status === "succeeded")) {
    return { kind: "blocked" };
  }

  if (refunds.some((refund) => refund.status === "pending" || refund.status === "requires_action")) {
    return { kind: "blocked" };
  }

  if (!refunds.every((refund) => refund.status === "failed" || refund.status === "canceled")) {
    return { kind: "blocked" };
  }

  const latestFailedOrCanceled = [...refunds].sort((a, b) => {
    if (b.created !== a.created) return b.created - a.created;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  })[0];

  return {
    kind: "ready",
    idempotencyKey: buildRetryIdempotencyKey(refundRequestId, latestFailedOrCanceled.id),
  };
}

// Never shown with any Stripe-specific detail -- Stripe error messages
// can be arbitrarily technical (and are logged in full server-side via
// console.error below, for an operator to actually diagnose), so the
// browser only ever sees this fixed, safe string regardless of what
// Stripe actually rejected the request for. This also already covers
// the specific case of the underlying charge somehow having become
// fully refunded elsewhere before this call: `stripe.refunds.create()`
// itself raises an error "when called on an already-refunded charge, or
// when trying to refund more money than is left on a charge" (Stripe's
// own doc comment, node_modules/stripe/cjs/resources/Refunds.d.ts) --
// no separate detection logic is needed here, Stripe's API refuses the
// double-refund on its own and this function's existing try/catch
// already turns that refusal into a safe, non-corrupting failure.
//
// Says "try again" -- and this is now actually accurate, unlike an
// earlier version of this comment assumed: determineRefundAttempt runs a
// fresh Stripe lookup immediately before every attempt, so a subsequent
// click after a genuine failed/canceled result derives a real new
// idempotency key (buildRetryIdempotencyKey) and genuinely retries,
// rather than replaying a stale cached response. The Dashboard is still
// offered as a fallback for whatever this generic message can't
// communicate (e.g. persistent failures needing manual investigation).
export const STRIPE_REFUND_ERROR_MESSAGE =
  "Stripe couldn't process this refund. You can try again, or check the Stripe Dashboard for details.";

export type IssueRefundOutcome =
  | { kind: "not_found" }
  | { kind: "not_approved" }
  | { kind: "stripe_error"; message: string }
  | { kind: "submitted" };

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

type RefundRequestRow = {
  id: string;
  status: string;
  stripe_payment_intent_id: string;
};

// The core, framework-agnostic logic behind the "Issue refund" admin
// action -- extracted the same way fulfillBundleSnapshot/
// processChargeRefund were extracted from the Stripe webhook
// (src/app/api/webhooks/stripe/route.ts), for the same reason: direct
// testability with fake Supabase/Stripe clients, no Next.js request
// context required. Deliberately lives OUTSIDE actions.ts: that file is
// "use server", and every export from a "use server" file must be a
// valid Server Action (simple, serializable arguments) -- a function
// taking live Supabase/Stripe client objects as parameters is not that,
// and doesn't belong there.
//
// Re-fetches the request fresh from the database on every call --
// accepts nothing about amount, PaymentIntent, or status from the
// caller beyond the row's own id, matching the same "the caller
// supplies only a lookup key, everything else is re-derived" posture
// already used throughout this codebase (request_refund(),
// cancel_refund_request(), review_refund_request() in migration 029 all
// do the same). Only a request whose CURRENT status is exactly
// 'approved' proceeds -- a concurrent webhook or a second admin tab
// that already moved it to 'refunded' (or any other status) between
// page render and this call is caught here, not assumed away.
//
// Refunds the FULL remaining charge by omitting `amount` from
// RefundCreateParams entirely, rather than passing
// refund_requests.amount_cents: Stripe's own documented behavior for
// refunds.create() is to refund the entire remaining balance of the
// charge when no amount is given, which is authoritative for "what's
// actually left to refund" in a way a locally-stored cents figure can
// never fully guarantee (e.g. if some other, out-of-band partial refund
// already touched this same charge) -- letting Stripe determine "the
// whole transaction" itself is strictly safer than asserting an amount
// from Librum's own database.
//
// Uses `payment_intent`, not `charge`: every table in this schema
// (purchases, bundle_checkout_snapshots, refund_requests) stores
// stripe_payment_intent_id as the canonical transaction identifier, and
// the existing webhook (extractPaymentIntentId) already treats
// PaymentIntent as the transaction's identity throughout. Librum never
// stores or looks up a Charge id anywhere, and RefundCreateParams
// accepts payment_intent directly, so this needs no extra Stripe API
// round-trip to resolve a charge id first.
//
// Deliberately does NOT write anything to Supabase after Stripe accepts
// the refund. Successful API acceptance means only that Stripe has
// started/accepted the refund -- purchases.refunded_at,
// bundle_checkout_snapshots.refunded_at, and
// refund_requests.status/refunded_at remain the Stripe webhook's
// (src/app/api/webhooks/stripe/route.ts's processChargeRefund) sole
// responsibility, unchanged by this phase. This function's only
// Supabase call is the initial read.
export async function executeApprovedRefund(
  supabase: SupabaseClient,
  stripeClient: StripeClient,
  refundRequestId: string,
): Promise<IssueRefundOutcome> {
  const { data: request } = await supabase
    .from("refund_requests")
    .select("id, status, stripe_payment_intent_id")
    .eq("id", refundRequestId)
    .maybeSingle<RefundRequestRow>();

  if (!request) {
    return { kind: "not_found" };
  }

  if (request.status !== "approved") {
    return { kind: "not_approved" };
  }

  let plan: RefundAttemptPlan;
  try {
    plan = await determineRefundAttempt(
      stripeClient,
      request.stripe_payment_intent_id,
      request.id,
    );
  } catch (error) {
    // Fail closed: if Stripe's own live refund state can't be read,
    // there is no safe basis for deciding whether a new refund attempt
    // would be a legitimate retry or a dangerous duplicate -- never
    // guess, never fall back to the base key blindly.
    console.error("Admin refund issuance: failed to read Stripe's live refund state", {
      refundRequestId: request.id,
      paymentIntentId: request.stripe_payment_intent_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE };
  }

  if (plan.kind === "blocked") {
    // A refund already exists for this PaymentIntent that is pending,
    // requires_action, or succeeded -- originating a NEW Stripe refund
    // here would either duplicate an in-flight attempt or pile a second
    // operation onto a transaction that (by Librum's own full-
    // transaction-only policy) should never need one. No Stripe call is
    // made; the webhook remains the sole path that ever finalizes
    // Librum's own DB, exactly as if this click had genuinely submitted
    // something.
    console.warn("Admin refund issuance: blocked by an existing Stripe refund in a non-retryable state", {
      refundRequestId: request.id,
      paymentIntentId: request.stripe_payment_intent_id,
    });
    return { kind: "submitted" };
  }

  // LAUNCH-1 P1-1 correction: every checkout in this codebase (buyBook,
  // buyBundle) creates a Stripe Connect DESTINATION charge --
  // payment_intent_data.transfer_data.destination sends the author's
  // share (100% - PLATFORM_FEE_PERCENT, see src/lib/pricing.ts)
  // straight to their connected account at charge time, alongside
  // application_fee_amount retained by Librum. Confirmed directly
  // against the installed stripe@22.5.0 SDK's own doc comment on
  // RefundCreateParams.reverse_transfer (node_modules/stripe/cjs/
  // resources/Refunds.d.ts): "Boolean indicating whether the transfer
  // should be reversed when refunding this charge. The transfer will be
  // reversed proportionally to the amount being refunded... A transfer
  // can be reversed only by the application that created the charge."
  // Without this, refunding the reader does NOT claw back the author's
  // already-transferred share -- the author keeps it, and Librum's own
  // Stripe balance absorbs the full customer refund alone. reverse_transfer
  // is not a business-policy choice, it's a correctness requirement: an
  // author must not keep payment for a transaction Librum's own records
  // (refund_requests.status, purchases.refunded_at) now say was refunded.
  //
  // Deliberately does NOT set refund_application_fee: whether Librum's
  // own platform-fee share should also be returned on a refund is a
  // genuine, undecided business policy question -- no page, doc, or
  // comment anywhere in this codebase (Terms, Pricing, How It Works,
  // Help, README) states what happens to Librum's fee on a refund, only
  // what happens on a normal sale. Per instruction, this is left exactly
  // as an open decision for a human to make, not invented here.
  let refund: Stripe.Refund;
  try {
    refund = await stripeClient.refunds.create(
      { payment_intent: request.stripe_payment_intent_id, reverse_transfer: true },
      { idempotencyKey: plan.idempotencyKey },
    );
  } catch (error) {
    console.error("Admin refund issuance failed", {
      refundRequestId: request.id,
      paymentIntentId: request.stripe_payment_intent_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE };
  }

  // REFUND-1B Step 5 correction: refunds.create() resolving (not
  // throwing) only means Stripe accepted the request -- confirmed
  // against the installed SDK's own Refund.status type (`pending |
  // requires_action | succeeded | failed | canceled`), a resolved call
  // can still carry an already-terminal 'failed' or 'canceled' status.
  // Reporting that as "submitted... waiting for confirmation" would be
  // actively misleading, since there is nothing left to wait for. Every
  // other resolved status (pending, requires_action, succeeded) is
  // correctly reported as "submitted" -- the webhook
  // (processRefundLifecycleEvent) remains the sole authority for
  // actually finalizing Librum's own state in every case, including an
  // immediate 'succeeded' response here.
  if (refund.status === "failed" || refund.status === "canceled") {
    console.error("Admin refund issuance returned an immediate non-success status", {
      refundRequestId: request.id,
      paymentIntentId: request.stripe_payment_intent_id,
      refundId: refund.id,
      status: refund.status,
    });
    return { kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE };
  }

  return { kind: "submitted" };
}
