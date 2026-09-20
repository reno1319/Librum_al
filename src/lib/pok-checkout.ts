import { randomUUID } from "node:crypto";
import {
  pokAmountToMinor,
  validatePokCheckoutUrl,
  verifiedPokPayment,
  logPokDiagnostic,
  logPokCritical,
  uuid,
} from "./pok";
import type { PokOrder, PokCreateOrder } from "./pok";
import { resolveMaintenanceMode } from "./maintenance-mode";

// ALL-CUTOVER APP-A: the sentinel startPokCheckout() throws when its own
// defense-in-depth maintenance check (see that function's own comment)
// fires. A narrow, dedicated Error message -- the same existing
// contract shape as POK_CHECKOUT_CANNOT_RESUME/POK_INVALID_FROZEN_INTENT
// below -- never an HTTP response, since this is a plain library
// module, not a Route Handler. buyBook() (the only production caller)
// maps this back to its own top-of-function redirectForMaintenance()
// redirect, so the caller-visible outcome is identical regardless of
// which of the two layers actually caught the maintenance window.
export const POK_CHECKOUT_MAINTENANCE_ACTIVE = "POK_CHECKOUT_MAINTENANCE_ACTIVE";

// Surfaced to the caller (buyBook) so it can give the reader an honest
// message instead of the generic "could not start checkout" -- thrown only
// when resuming an existing checkout would be unsafe AND the reason is
// terminal: the provider order is refunded, or completed-and-refunded, or
// otherwise contradicts itself. Never thrown for a merely ambiguous or
// transient state, which is POK_CHECKOUT_AMBIGUOUS below.
export const POK_CHECKOUT_CANNOT_RESUME = "POK_CHECKOUT_CANNOT_RESUME";

// STALE-CHECKOUT-1: another request for this same intent is mid-creation
// (a double click, a second tab, or a server retry). Exactly one provider
// order exists and the loser of the claim race waits rather than creating
// a second payable order.
export const POK_CHECKOUT_IN_PROGRESS = "POK_CHECKOUT_IN_PROGRESS";

// STALE-CHECKOUT-1: the provider's own answer did not let us prove the
// attempt is either payable or dead. Fail closed: never resume, never
// retire. The reader waits out the window, which is minutes rather than
// the 23 hours this whole repair exists to remove.
export const POK_CHECKOUT_AMBIGUOUS = "POK_CHECKOUT_AMBIGUOUS";

// STALE-CHECKOUT-1: the attempt was provably dead, it has been retired
// and its intent superseded atomically, so the caller may mint exactly
// one replacement. This is the ONLY signal that permits one.
export const POK_CHECKOUT_ATTEMPT_RETIRED = "POK_CHECKOUT_ATTEMPT_RETIRED";

// STALE-CHECKOUT-1: POK publishes no clock-skew, grace, or
// "expiry is enforced at capture" statement anywhere in this
// repository's evidence (POK_STAGING.md), so there is no documented
// value to prefer. Two minutes covers ordinary NTP skew across Postgres,
// Vercel and POK plus a hosted-page submission already in flight when
// expiresAt passes. It is a named constant precisely so a sandbox-
// confirmed value can replace it in exactly one place.
//
// It is an ACTIVATION GATE, not decoration: controlled staging checkout
// stays closed until a sandbox run confirms POK does not accept a
// payment after the reported expiresAt plus this margin. That test is
// what bounds the one genuinely new risk this repair introduces -- a
// reader holding a replacement intent while the retired attempt is still
// somehow payable, which has no remedy without POK refunds.
export const POK_EXPIRY_SAFETY_MARGIN_MS = 120_000;

// STALE-CHECKOUT-1: replaces assertReusableUnpaidOrder, which could not
// distinguish "expired" from "ambiguous" -- both threw the same sentinel,
// and its capturedAmount check ran BEFORE its expiry check, so an expired
// order was reported as ambiguity whenever capturedAmount was absent.
// That conflation is what made the lockout permanent: nothing could ever
// conclude "this attempt is dead, retire it".
//
// The outcomes are deliberately five, not two:
//   FULFIL            -- money arrived; route to fulfilment, NEVER retire
//   BLOCKED_RECONCILE -- terminal and not fulfillable here (refunded, or
//                        self-contradictory); a human must look
//   BLOCKED_AMBIGUOUS -- cannot prove either way; wait, change nothing
//   RETIRE_SAFE       -- provably dead and unpaid; may be retired, with
//                        the mapping-side reason this evidence supports
//   RESUMABLE         -- provably open and unpaid; hand the URL back
//
// Note what this function does NOT read: provider_window_ends_at. It only
// ever runs on an attempt that HAS a provider order id, so the window
// Librum itself requested has no business deciding anything here -- POK's
// own expiresAt is the authority. The locally-requested window justifies
// retirement in exactly one place, an ID-LESS attempt, and that decision
// lives in SQL.
export type ProviderAttemptClass =
  | { outcome: "FULFIL" }
  | { outcome: "BLOCKED_RECONCILE" }
  | { outcome: "BLOCKED_AMBIGUOUS" }
  | { outcome: "RETIRE_SAFE"; reason: "provider_attempt_expired" | "provider_attempt_canceled" }
  | { outcome: "RESUMABLE" };

export function classifyProviderAttempt(
  order: PokOrder,
  binding: { orderId: string; reference: string; merchantId: string; expectedMinor: number; currency: string },
  now: number,
): ProviderAttemptClass {
  // 1. Identity: this MUST be the exact order created for this mapping.
  // Checked independently of verifiedPokPayment, whose contract is
  // "verify a PAYMENT", not "confirm this is the right order".
  if (order.id !== binding.orderId || order.merchantCustomReference !== binding.reference ||
      order.merchant?.id !== binding.merchantId) {
    return { outcome: "BLOCKED_RECONCILE" };
  }
  // 2. Economics: verified UNCONDITIONALLY, not only once a payment is
  // confirmed. An order silently bound to the wrong amount, or a
  // different/converted currency, is never safe to act on, paid or not.
  // No FX is implemented, so originalCurrencyCode must match exactly too.
  let finalMinor: number;
  try {
    finalMinor = pokAmountToMinor(order.finalAmount);
  } catch {
    return { outcome: "BLOCKED_RECONCILE" };
  }
  if (finalMinor !== binding.expectedMinor || order.currencyCode !== binding.currency ||
      order.originalCurrencyCode !== binding.currency) {
    return { outcome: "BLOCKED_RECONCILE" };
  }
  // 3. A self-contradiction is never resolved in either direction.
  if (order.isCompleted === true && (order.isRefunded === true || order.isCanceled === true)) {
    return { outcome: "BLOCKED_RECONCILE" };
  }
  // 4. Refunded is a RECONCILIATION fact, never entitlement and never
  // retirement: money moved and came back. `!== false` rather than
  // `=== true` so a loosened schema cannot turn an absent field into
  // "evidence of none".
  //
  // This ordering is the actual fix to a live defect, not a tidy-up:
  // verifiedPokPayment already rejects every refunded representation,
  // but it returns null, which fulfillPokCheckout mapped to "pending"
  // and the webhook route turns into a 503 -- a RETRY signal for a state
  // that can never resolve. A refunded order would have been retried
  // forever.
  if (order.isRefunded !== false) {
    return { outcome: "BLOCKED_RECONCILE" };
  }
  // 5. Completed and not refunded: money arrived. Fulfilment re-verifies
  // the actual CAPTURED amount; this is only the routing decision.
  if (order.isCompleted === true) {
    return { outcome: "FULFIL" };
  }
  // 6. An explicit cancellation is terminal by the provider's own
  // statement, so it needs no expiry margin -- but only with no
  // transaction or capture evidence contradicting it.
  if (order.isCanceled === true) {
    if (order.transactionId === null && !(typeof order.capturedAmount === "number" && order.capturedAmount > 0)) {
      return { outcome: "RETIRE_SAFE", reason: "provider_attempt_canceled" };
    }
    return { outcome: "BLOCKED_RECONCILE" };
  }
  // 7. CONTRADICTION, not mere absence. A transaction id, a positive
  // capture, or autoCapture explicitly reading `false` on an order that
  // is not "completed" are each a statement by the provider that
  // disagrees with itself, and none of them is safe to act on in any
  // direction.
  //
  // `autoCapture === false`, deliberately NOT `!== true`. The
  // difference is the whole point of this rule's position: autoCapture
  // is `optional()` in pokOrderSchema, so an ABSENT value is a real
  // wire shape, and `!== true` would classify that absence as a
  // contradiction here -- ahead of the expiry rule below, which would
  // then never be reached. An attempt expired twelve hours ago would be
  // permanently un-retireable because one optional field was missing.
  // That is precisely the lockout this repair exists to remove,
  // reintroduced through a different field.
  //
  // Absence is not evidence of contradiction. It is handled AFTER the
  // expiry rule, as ambiguity, in rule 10.
  if (order.transactionId !== null || order.autoCapture === false ||
      (typeof order.capturedAmount === "number" && order.capturedAmount > 0)) {
    return { outcome: "BLOCKED_RECONCILE" };
  }
  // 8. An UNPARSEABLE authoritative expiry is ambiguity, at ANY age, and
  // never retirement. Falling back to our own locally-requested window
  // here would retire an order whose checkout URL the reader is holding,
  // on the strength of a number POK never agreed to.
  //
  // The honest consequence, stated rather than hidden: if POK
  // persistently returns an unparseable expiresAt, an attempt with an
  // order id can never be retired and that reader stays blocked until
  // the intent's own 23-hour expiry -- the original bug, confined to
  // that one response-shape defect. That is the correct direction to
  // fail in, and it is why the sandbox must confirm a parseable
  // expiresAt on open, cancelled and expired orders before activation.
  //
  // A MISSING expiresAt never reaches here at all: it is required in
  // pokOrderSchema, so retrieveOrder's Zod parse throws
  // POK_INVALID_ORDER_SHAPE first.
  const expiresAt = Date.parse(order.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return { outcome: "BLOCKED_AMBIGUOUS" };
  }
  // 9. A PROVEN expiry retires, and it outranks every merely absent
  // field below it. Everything that could contradict "dead and unpaid"
  // has already been excluded above: completion (rule 5), refund (rule
  // 4), a transaction id, a positive capture and an explicit
  // autoCapture=false (rule 7). What remains beneath this line is only
  // absence, and absence must never outrank the provider's own
  // authoritative statement that the order has expired.
  //
  // Expiry is evaluated against a clock read AFTER the provider round
  // trip that fetched `order`, never a timestamp captured before it -- an
  // order can cross its own expiry during that network call.
  if (expiresAt + POK_EXPIRY_SAFETY_MARGIN_MS <= now) {
    return { outcome: "RETIRE_SAFE", reason: "provider_attempt_expired" };
  }

  // ---- Below this line the order is OPEN and unexpired. ----
  //
  // Handing a checkout URL back is an invitation to pay, so the bar is
  // now the opposite of the one above: not "can we prove it is dead"
  // but "can we prove it is alive and untouched". Every optional field
  // must be positively present and correct, and anything absent is
  // ambiguity rather than permission.
  // 10. An ABSENT isCanceled or autoCapture cannot prove the order is
  // still open and still set to capture. All three of isRefunded,
  // isCanceled and autoCapture are `optional()` in pokOrderSchema, so
  // undefined is a real wire value rather than a type-system artifact,
  // and none of them may be read as "evidence of none" on the path
  // toward handing a payable URL back.
  //
  // The position of this rule is load-bearing, and it is the correction
  // the audit forced: these checks belong BELOW the expiry rule, never
  // above it. A missing optional field must be able to stop a RESUME
  // without also being able to stop a RETIREMENT -- otherwise one
  // omitted field makes the lockout permanent again.
  if (order.isCanceled !== false || order.autoCapture !== true) {
    return { outcome: "BLOCKED_AMBIGUOUS" };
  }
  // 11. POK's docs never state what an ABSENT capturedAmount means on an
  // order still called open, and this has not been confirmed against a
  // real sandbox retrieval (POK_STAGING.md's own open item). So ONLY an
  // explicit, literal 0 is unambiguous "nothing captured" evidence.
  if (order.capturedAmount === 0) {
    return { outcome: "RESUMABLE" };
  }
  // 12. Open, unexpired, but we cannot prove nothing was captured.
  return { outcome: "BLOCKED_AMBIGUOUS" };
}

export type PokMapping = {
  intent_id: string; merchant_custom_reference: string; provider_order_id: string | null;
  checkout_url: string | null; webhook_token: string; creation_claim_id: string;
  state: "creating" | "ready" | "needs_reconciliation" | "retired";
  provider_window_ends_at: string | null;
};
export type FrozenPokIntent = {
  id: string; book_id: string; reader_id: string; regime: string; currency: string;
  price_cents_at_checkout: number; expires_at: string; stripe_checkout_session_id: string | null;
};

// STALE-CHECKOUT-1: the claim is now an RPC outcome, not a JavaScript
// reading of SQLSTATE 23505. The old code treated ANY unique violation --
// including a webhook_token or merchant_custom_reference collision -- as
// "already claimed", which would have silently handed a reader someone
// else's attempt path. SQL names the primary key as the ONLY legitimate
// conflict target; anything else propagates as a real error.
export type PokClaimOutcome =
  | { outcome: "claimed"; grantedWindowMinutes: number }
  | { outcome: "already_claimed" }
  | { outcome: "intent_not_found" }
  | { outcome: "intent_not_claimable" }
  | { outcome: "intent_expired" }
  | { outcome: "intent_stripe_bound" }
  | { outcome: "reference_mismatch" };

export type PokRetireOutcome =
  | "retired_and_superseded" | "already_completed" | "already_fulfilled"
  | "mapping_changed" | "not_retireable" | "not_found" | "reader_or_book_deleted"
  | "invalid_retired_reason" | "reason_not_coherent";

export interface PokRepository {
  intent(id: string): Promise<FrozenPokIntent | null>;
  mapping(id: string): Promise<PokMapping | null>;
  claim(row: {
    intentId: string; reference: string; webhookToken: string; claimId: string;
    requestedWindowMinutes: number;
  }): Promise<PokClaimOutcome>;
  recordProviderOrder(id: string, claimId: string, orderId: string): Promise<void>;
  ready(id: string, claimId: string, url: string): Promise<void>;
  reconcile(id: string, claimId: string): Promise<void>;
  retire(args: {
    intentId: string; expectedClaimId: string; expectedProviderOrderId: string | null;
    expectedState: string; retiredReason: string;
  }): Promise<PokRetireOutcome>;
  recordEvent(paymentId: string): Promise<{ id: string; received_at: string }>;
  finalize(args: { eventId: string; intentId: string; paymentId: string; minor: number; currency: string; paidAt: string }): Promise<string>;
}
export interface PokOrders {
  createOrder(body: PokCreateOrder): Promise<PokOrder>;
  retrieveOrder(id: string): Promise<PokOrder>;
}
function validateIntent(intent: FrozenPokIntent | null): asserts intent is FrozenPokIntent {
  if (!intent || intent.regime !== "librum_ledger_v1" || intent.currency !== "ALL" ||
      !Number.isSafeInteger(intent.price_cents_at_checkout) || intent.price_cents_at_checkout <= 0) {
    throw new Error("POK_INVALID_FROZEN_INTENT");
  }
}

// STALE-CHECKOUT-1: bounded, idempotent persistence of the provider order
// id, issued IMMEDIATELY after createOrder returns and BEFORE any further
// validation or URL check.
//
// The residual this narrows -- and does not close, which is stated rather
// than claimed solved: if POK creates the order, returns its id, and every
// write of that id fails, Librum holds no durable record of that order.
// What bounds the harm is that the reader is never handed a URL (every
// failure throws before the return), and POK's hosted page is reachable
// only by an order id we never disclosed, so the orphan expires unpaid.
// The mapping row still exists -- the claim precedes the provider call --
// and carries provider_window_ends_at, so the intent is still retireable
// and the lockout is still bounded.
//
// A database OUTBOX cannot substitute here and is deliberately not
// proposed: it would be written to the same database whose write just
// failed.
//
// The update is idempotent by construction (it re-matches the same
// claim and accepts an already-recorded identical id), so retrying is
// safe. Three attempts, 200 ms then 600 ms, under one second in total --
// well inside a server action's budget.
const RECORD_ORDER_BACKOFF_MS = [200, 600] as const;

async function recordProviderOrderWithRetry(
  repo: PokRepository, intentId: string, claimId: string, orderId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RECORD_ORDER_BACKOFF_MS.length + 1; attempt += 1) {
    try {
      await repo.recordProviderOrder(intentId, claimId, orderId);
      return;
    } catch (err) {
      lastError = err;
      const backoff = RECORD_ORDER_BACKOFF_MS[attempt - 1];
      if (backoff === undefined) break;
      logPokCritical("provider_order_persistence_retry", {
        intentId, creationClaimId: claimId, providerOrderId: orderId, attempt,
      });
      await sleep(backoff);
    }
  }
  // Last line of defense: name the order we may now be unable to find.
  logPokCritical("orphan_provider_order", {
    intentId, creationClaimId: claimId, providerOrderId: orderId,
  });
  throw lastError instanceof Error ? lastError : new Error("POK_ORDER_PERSISTENCE_FAILED");
}

export type StartPokCheckoutResult =
  | { kind: "checkout_url"; url: string }
  | { kind: "fulfilled"; bookId: string }
  | { kind: "fulfilment_pending"; bookId: string }
  | { kind: "blocked"; bookId: string };

// STALE-CHECKOUT-1: the resolution of an attempt we could not decide
// locally. Returned by probeProviderAttempt, which is the ONLY path that
// may move a possibly-live attempt to terminal, and only after an
// authenticated provider retrieval.
export type ProviderAttemptResolution =
  | { kind: "retired" }
  | { kind: "resumable"; url: string | null }
  | { kind: "fulfilled"; bookId: string }
  | { kind: "fulfilment_pending"; bookId: string }
  | { kind: "blocked"; bookId: string }
  | { kind: "in_progress" }
  | { kind: "ambiguous" }
  | { kind: "needs_reconciliation" };

// STALE-CHECKOUT-1: resolve an attempt the database refused to decide on
// its own (quote_status conflict_attempt_unresolved or
// blocked_expired_attempt_unresolved).
//
// It requires a recorded provider_order_id and an authenticated
// retrieval, and the ONLY outcome that permits a replacement intent is a
// retire_book_checkout_attempt returning retired_and_superseded. Every
// other outcome mutates nothing and creates no second payable order.
export async function probeProviderAttempt(input: {
  intentId: string; merchantId: string;
}, repo: PokRepository, orders: PokOrders, now = Date.now()): Promise<ProviderAttemptResolution> {
  const mapping = await repo.mapping(input.intentId);
  if (!mapping) {
    // No attempt was ever claimed. Nothing to probe and nothing to
    // retire -- writing "provider_attempt_retired" on an intent that
    // never had an attempt would be a false record.
    return { kind: "needs_reconciliation" };
  }
  if (mapping.state === "retired") {
    // Already terminal. The supersede is atomic with the retirement, so
    // the caller's next create call will simply mint.
    return { kind: "retired" };
  }
  if (!mapping.provider_order_id) {
    // Claimed but id-less. Only SQL may retire this, and only once the
    // locally-requested window has elapsed -- see
    // create_book_checkout_intent. Nothing here mutates it either way.
    //
    // The two id-less states are NOT reported as one. 'creating' really
    // is another request mid-flight (a double click, a second tab).
    // 'needs_reconciliation' is a prior attempt that already failed
    // ambiguously, and telling that reader "a request is in progress"
    // would be false -- there is none. It keeps the pre-existing
    // reconciliation answer, which is also the honest one: an order may
    // exist at POK under an id this mapping never recorded.
    return mapping.state === "creating"
      ? { kind: "in_progress" }
      : { kind: "needs_reconciliation" };
  }

  const intent = await repo.intent(input.intentId);
  validateIntent(intent);

  let order: PokOrder;
  try {
    order = await orders.retrieveOrder(mapping.provider_order_id);
  } catch {
    // Cannot confirm anything. Never resume blindly, never retire on an
    // unconfirmed provider state.
    return { kind: "ambiguous" };
  }

  const binding = {
    orderId: mapping.provider_order_id, reference: mapping.merchant_custom_reference,
    merchantId: input.merchantId, expectedMinor: intent.price_cents_at_checkout,
    currency: intent.currency,
  };
  // The clock is read AFTER the round trip, inside classify's caller, so
  // an order that crossed its expiry during the call is judged on the
  // current time rather than a stale pre-call read.
  const verdict = classifyProviderAttempt(order, binding, Date.now() > now ? Date.now() : now);

  switch (verdict.outcome) {
    case "FULFIL": {
      const result = await fulfillPokCheckout({
        intentId: input.intentId, token: mapping.webhook_token, merchantId: input.merchantId,
      }, repo, orders);
      if (result.status === "fulfilled") return { kind: "fulfilled", bookId: result.bookId };
      if (result.status === "blocked") return { kind: "blocked", bookId: result.bookId };
      return { kind: "fulfilment_pending", bookId: result.bookId };
    }
    case "RETIRE_SAFE": {
      const outcome = await repo.retire({
        intentId: input.intentId,
        expectedClaimId: mapping.creation_claim_id,
        expectedProviderOrderId: mapping.provider_order_id,
        expectedState: mapping.state,
        retiredReason: verdict.reason,
      });
      if (outcome === "retired_and_superseded") return { kind: "retired" };
      // The money-arrived outcomes route to ownership, never to a
      // replacement.
      if (outcome === "already_fulfilled" || outcome === "already_completed") {
        return { kind: "fulfilled", bookId: intent.book_id };
      }
      // Everything else fails closed with no new intent and no new order.
      return { kind: "needs_reconciliation" };
    }
    case "RESUMABLE": {
      if (mapping.state === "ready" && mapping.checkout_url) {
        return { kind: "resumable", url: validatePokCheckoutUrl(mapping.checkout_url, mapping.provider_order_id) };
      }
      // An order exists but no URL was ever stored, so there is nothing
      // to hand back and nothing safe to retire.
      return { kind: "resumable", url: null };
    }
    case "BLOCKED_AMBIGUOUS":
      return { kind: "ambiguous" };
    case "BLOCKED_RECONCILE":
    default:
      return { kind: "needs_reconciliation" };
  }
}

export async function startPokCheckout(input: {
  intentId: string; readerId: string; title: string; origin: string; merchantId: string;
}, repo: PokRepository, orders: PokOrders, now = Date.now(),
   sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<StartPokCheckoutResult> {
  // ALL-CUTOVER APP-A: defense-in-depth -- buyBook() (the only
  // production caller) already gates before ever reaching this
  // function, but this is the actual provider-order-creation operation
  // itself, so it re-checks maintenance mode as its own first
  // statement, before repository access, intent creation/reuse, POK
  // configuration/authentication, or provider order creation.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    throw new Error(POK_CHECKOUT_MAINTENANCE_ACTIVE);
  }
  const intent = await repo.intent(input.intentId);
  validateIntent(intent);
  if (intent.stripe_checkout_session_id) throw new Error("POK_INTENT_ALREADY_BOUND_TO_STRIPE");
  const remaining = Math.floor((Date.parse(intent.expires_at) - now) / 60_000);
  if (intent.reader_id !== input.readerId || !Number.isFinite(remaining) || remaining < 1) {
    throw new Error("POK_EXPIRED_OR_FOREIGN_INTENT");
  }
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("POK_INVALID_SITE_ORIGIN");
  }
  const reference = `book:${intent.id}`;
  const webhookToken = randomUUID();
  const claimId = randomUUID();

  // The claim is the serialization point BEFORE any external call, and
  // it is still the intent_id PRIMARY KEY doing the work -- a correct,
  // durable invariant enforced by Postgres, not by timing: at most one
  // provider order per intent, ever. What changed is only that the
  // window is now computed and returned BY SQL, so Postgres' clock
  // governs both the stored window and the number POK is asked for,
  // instead of the application validating a number it made up itself.
  const claim = await repo.claim({
    intentId: intent.id, reference, webhookToken, claimId,
    requestedWindowMinutes: Math.min(remaining, 30),
  });

  if (claim.outcome === "already_claimed") {
    const resolution = await probeProviderAttempt(
      { intentId: intent.id, merchantId: input.merchantId }, repo, orders, now);
    switch (resolution.kind) {
      case "resumable":
        if (resolution.url) return { kind: "checkout_url", url: resolution.url };
        throw new Error(POK_CHECKOUT_IN_PROGRESS);
      case "retired":
        throw new Error(POK_CHECKOUT_ATTEMPT_RETIRED);
      case "fulfilled":
        return { kind: "fulfilled", bookId: resolution.bookId };
      case "fulfilment_pending":
        return { kind: "fulfilment_pending", bookId: resolution.bookId };
      case "blocked":
        return { kind: "blocked", bookId: resolution.bookId };
      case "in_progress":
        throw new Error(POK_CHECKOUT_IN_PROGRESS);
      case "ambiguous":
        throw new Error(POK_CHECKOUT_AMBIGUOUS);
      default:
        throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
    }
  }
  if (claim.outcome !== "claimed") {
    // intent_not_found / intent_not_claimable / intent_expired /
    // intent_stripe_bound / reference_mismatch: every one means this
    // intent may not carry a provider order at all. No order is created.
    throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
  }

  try {
    const query = new URLSearchParams({ intent: intent.id, token: webhookToken });
    const order = await orders.createOrder({
      amount: intent.price_cents_at_checkout / 100, currencyCode: "ALL", autoCapture: true,
      shippingCost: 0, merchantCustomReference: reference,
      description: input.title.slice(0, 200),
      // SQL's number, not ours -- see the claim comment above.
      expiresAfterMinutes: claim.grantedWindowMinutes,
      webhookUrl: `${origin.origin}/api/payments/pok/webhook?${query}`,
      redirectUrl: `${origin.origin}/payments/pok/return?${query}`,
      failRedirectUrl: `${origin.origin}/books/${intent.book_id}?canceled=true`,
    });

    // MINIMUM identity, in memory, before the first write: enough to be
    // sure this id belongs to this intent, and no more. Full economic
    // validation deliberately stays AFTER persistence, so a mismatch
    // still leaves us holding the order's id rather than orphaning it.
    try {
      uuid.parse(order.id);
      if (order.merchantCustomReference !== reference) {
        throw new Error("POK_CREATED_ORDER_MISMATCH");
      }
    } catch (err) {
      logPokDiagnostic("response_validation", err);
      throw err;
    }

    await recordProviderOrderWithRetry(repo, intent.id, claimId, order.id, sleep);

    // The whole validation -- not just the explicit mismatch throw below --
    // is inside this try: pokAmountToMinor(order.finalAmount) can itself
    // throw (POK_INVALID_AMOUNT) while the condition is still being
    // evaluated, before the mismatch throw is ever reached. Without
    // wrapping the amount conversion too, that failure would skip
    // response_validation logging entirely and fall straight through to
    // the outer catch's generic reconciliation, silently.
    try {
      if (order.currencyCode !== "ALL" ||
          (order.originalCurrencyCode !== undefined && order.originalCurrencyCode !== "ALL") || order.autoCapture === false ||
          pokAmountToMinor(order.finalAmount) !== intent.price_cents_at_checkout ||
          (order.merchant && order.merchant.id !== input.merchantId) || order.isCompleted || order.isRefunded || order.isCanceled === true) {
        throw new Error("POK_CREATED_ORDER_MISMATCH");
      }
    } catch (err) {
      logPokDiagnostic("response_validation", err);
      throw err;
    }
    let url: string;
    try {
      url = validatePokCheckoutUrl(order._self?.confirmUrl ?? "", order.id);
    } catch (err) {
      logPokDiagnostic("checkout_url", err);
      throw err;
    }
    try {
      await repo.ready(intent.id, claimId, url);
    } catch (err) {
      logPokDiagnostic("ready_write", err);
      throw err;
    }
    // The URL is returned ONLY after persistence succeeded. Structurally
    // true before this change too (every failure throws first); now an
    // explicit, tested invariant.
    return { kind: "checkout_url", url };
  } catch {
    // Keep the durable claim even if recording the diagnostic fails. Never
    // silently create another payable order after an ambiguous response.
    // reconcile() must never null provider_order_id -- it writes only
    // state and last_error_code -- so an id recorded above survives a
    // later validation failure and the orphan stays nameable.
    await repo.reconcile(intent.id, claimId).catch(() => undefined);
    throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
  }
}

export async function fulfillPokCheckout(input: {
  intentId: string; token: string; merchantId: string; readerId?: string;
}, repo: PokRepository, orders: PokOrders) {
  const mapping = await repo.mapping(input.intentId);
  // STALE-CHECKOUT-1: the state guard was `mapping.state !== "ready"`,
  // which silently DROPPED a real payment whenever the mapping had moved
  // on -- and after this repair a retired mapping is an ordinary,
  // expected thing for a late callback to land on. The security control
  // here is the unguessable webhook_token plus the order-id binding plus
  // the authenticated retrieval, never the mapping's state, so requiring
  // a recorded provider_order_id is exactly as strong and does not throw
  // money away. A verified late payment must always reach fulfilment or
  // reconciliation.
  if (!mapping || mapping.webhook_token !== input.token || !mapping.provider_order_id) {
    throw new Error("POK_INVALID_CALLBACK");
  }
  if (mapping.state === "retired") {
    // Reaching this line means the retirement classifier was wrong: we
    // declared an attempt dead and it then took money. It still fulfils,
    // and staging must surface that loudly.
    logPokCritical("fulfilment_on_retired_mapping", {
      intentId: input.intentId, creationClaimId: mapping.creation_claim_id,
      providerOrderId: mapping.provider_order_id, mappingState: mapping.state,
    });
  }
  const intent = await repo.intent(input.intentId);
  validateIntent(intent);
  if (input.readerId !== undefined && input.readerId !== intent.reader_id) throw new Error("POK_FOREIGN_READER");
  const order = await orders.retrieveOrder(mapping.provider_order_id);
  const binding = {
    orderId: mapping.provider_order_id, reference: mapping.merchant_custom_reference,
    merchantId: input.merchantId, expectedMinor: intent.price_cents_at_checkout,
    currency: intent.currency,
  };
  // The classifier is the single gate for both paths now. Its rule 4 is
  // what stops a refunded order being reported as "pending" and retried
  // forever by the webhook route's 503.
  const verdict = classifyProviderAttempt(order, binding, Date.now());
  if (verdict.outcome === "BLOCKED_RECONCILE") {
    return { status: "blocked" as const, bookId: intent.book_id };
  }
  if (verdict.outcome !== "FULFIL") {
    return { status: "pending" as const, bookId: intent.book_id };
  }
  const facts = verifiedPokPayment(order, binding);
  if (!facts) return { status: "pending" as const, bookId: intent.book_id };
  // POK does not document a payment-success timestamp in this response.
  // Use the durable FIRST verified observation (event.received_at), not a
  // freshly recomputed clock or order.createdAt. Stable across concurrent retries.
  const event = await repo.recordEvent(facts.paymentId);
  if (!Number.isFinite(Date.parse(event.received_at))) throw new Error("POK_INVALID_EVENT_TIMESTAMP");
  const outcome = await repo.finalize({
    eventId: event.id, intentId: intent.id, paymentId: facts.paymentId,
    minor: facts.actualMinor, currency: facts.currency, paidAt: event.received_at,
  });
  if (outcome === "eligible_fulfilled" || outcome === "already_finalized") {
    return { status: "fulfilled" as const, bookId: intent.book_id };
  }
  // A verified second payment that cannot fulfil is NEVER discarded: the
  // finalization RPC has already written completed_at plus a
  // reconciliation_reason, which the existing admin reconciliation query
  // surfaces. "blocked" is the honest answer, not "pending".
  if (["active_other_session", "blocked_book_or_reader_deleted", "blocked_disputed_lost"].includes(outcome)) {
    return { status: "blocked" as const, bookId: intent.book_id };
  }
  throw new Error("POK_UNKNOWN_FINALIZATION_OUTCOME");
}
