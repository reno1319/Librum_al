import { randomUUID } from "node:crypto";
import { pokAmountToMinor, validatePokCheckoutUrl, verifiedPokPayment } from "./pok";
import type { PokOrder, PokCreateOrder } from "./pok";

// Surfaced to the caller (buyBook) so it can give the reader an honest
// message instead of the generic "could not start checkout" -- thrown only
// when resuming an existing checkout would be unsafe (the provider order is
// expired, canceled/refunded, or already paid). Never thrown for ordinary
// transient/ambiguous failures, which stay POK_CHECKOUT_REQUIRES_RECONCILIATION.
export const POK_CHECKOUT_CANNOT_RESUME = "POK_CHECKOUT_CANNOT_RESUME";

// Checkout-REUSE safety is a DIFFERENT question than fulfillment
// verification, and deliberately does not call verifiedPokPayment (below,
// unchanged) at all. verifiedPokPayment only ever needs to answer "has this
// been definitively PAID?", and safely says "no" (null/pending) whenever
// proof is incomplete -- that is correct for fulfillment, where "not
// proven paid" is a fine reason to keep waiting. It is NOT safe evidence
// that an order is "definitely still open and unpaid" -- an order that is
// actually isCompleted:true but missing capturedAmount (a malformed or
// partial response) also makes verifiedPokPayment return null, which a
// reuse check must never read as "safe to hand back out".
//
// So reuse safety instead requires POSITIVE, explicit, self-consistent
// evidence of an open order, and blocks on anything else -- completed,
// canceled, refunded, or merely ambiguous alike. POK's docs
// (payments.doc.pokpay.io, unreachable from this network; independently
// checked via the generated OpenAPI client at
// github.com/pokpay-ltd/php-sdk/blob/main/docs/Model/SdkOrder.md) never
// state what an ABSENT capturedAmount/transactionId means on an order POK
// still calls open -- there is no documented guarantee that omission means
// "zero"/"none", and this has NOT been confirmed against a real sandbox
// retrieval (see POK_STAGING.md's own open item on exactly this response
// shape). So an absent field is never read as proof of anything, missing
// OR positive/present are both treated as blocking ambiguity, and only an
// EXPLICIT, literal zero/null counts as unambiguous "still open" evidence
// -- see the capturedAmount-specific comment below for why that one field
// gets its own, more careful check.
function assertReusableUnpaidOrder(
  order: PokOrder,
  binding: { orderId: string; reference: string; merchantId: string; expectedMinor: number; currency: string },
): void {
  // Identity: this MUST be the exact order created for this mapping.
  // Checked independently of verifiedPokPayment's own binding check --
  // reuse safety can never depend on a helper whose contract is "verify a
  // PAYMENT", not "confirm this is the right, still-open order".
  if (order.id !== binding.orderId || order.merchantCustomReference !== binding.reference ||
      order.merchant?.id !== binding.merchantId) {
    throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
  }
  // Economics: verified UNCONDITIONALLY, not only once a payment is
  // confirmed -- an order silently bound to the wrong amount, or a
  // different/converted currency, is never safe to hand back out, paid or
  // not. No FX is implemented, so originalCurrencyCode must match exactly
  // too, not merely currencyCode.
  let finalMinor: number;
  try {
    finalMinor = pokAmountToMinor(order.finalAmount);
  } catch {
    throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
  }
  if (finalMinor !== binding.expectedMinor || order.currencyCode !== binding.currency ||
      order.originalCurrencyCode !== binding.currency) {
    throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
  }
  // Completion is an unconditional, first-checked block: a completed order
  // can never slip through just because its capture/transaction proof also
  // happens to be missing or malformed -- that exact shape was the bug
  // this replaces.
  if (order.isCompleted !== false) {
    throw new Error(POK_CHECKOUT_CANNOT_RESUME);
  }
  // isRefunded/isCanceled must be explicitly false, mirroring
  // verifiedPokPayment's own strictness for the same fields -- a missing
  // value is "no evidence of cancellation", not "evidence of none".
  if (order.isRefunded !== false || order.isCanceled !== false) {
    throw new Error(POK_CHECKOUT_CANNOT_RESUME);
  }
  // A transaction id, or autoCapture reading anything but this order's own
  // known-good `true`, on an order that ISN'T "completed" is contradictory,
  // not reassuring -- payment-in-progress or an otherwise ambiguous state.
  // POK's docs never document that combination as meaning "still safely
  // unpaid", so it blocks.
  if (order.transactionId !== null || order.autoCapture !== true) {
    throw new Error(POK_CHECKOUT_CANNOT_RESUME);
  }
  // capturedAmount specifically: POK's docs never state what an ABSENT
  // capturedAmount means on an order still called open -- there is no
  // documented guarantee it means "zero", and this has NOT been confirmed
  // against a real sandbox retrieval (POK_STAGING.md's own open item is
  // exactly this response shape). So missing blocks as ambiguous, exactly
  // like a positive value blocks as evidence of an actual capture -- ONLY
  // an explicit, literal `0` is unambiguous "nothing captured" evidence,
  // and even then only alongside every other check in this function
  // already having passed. This is a documented ASSUMPTION about the
  // sandbox's response shape, not a confirmed contract; a future sandbox
  // run may show a genuinely open order omits the field entirely, in
  // which case this correctly (if conservatively) never resumes it until
  // that shape is confirmed and this comment is updated to match.
  if (order.capturedAmount !== 0) {
    throw new Error(POK_CHECKOUT_CANNOT_RESUME);
  }
  // Expiry is evaluated against the clock AFTER the provider round-trip
  // that fetched `order`, not a timestamp captured before it -- a POK
  // order can cross its own expiry during that network call, and this
  // must never let a stale pre-call clock read call it still valid.
  const expiresAt = Date.parse(order.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error(POK_CHECKOUT_CANNOT_RESUME);
  }
}

export type PokMapping = {
  intent_id: string; merchant_custom_reference: string; provider_order_id: string | null;
  checkout_url: string | null; webhook_token: string; creation_claim_id: string;
  state: "creating" | "ready" | "needs_reconciliation";
};
export type FrozenPokIntent = {
  id: string; book_id: string; reader_id: string; regime: string; currency: string;
  price_cents_at_checkout: number; expires_at: string; stripe_checkout_session_id: string | null;
};
export interface PokRepository {
  intent(id: string): Promise<FrozenPokIntent | null>;
  mapping(id: string): Promise<PokMapping | null>;
  claim(row: PokMapping): Promise<boolean>;
  ready(id: string, claimId: string, orderId: string, url: string): Promise<void>;
  reconcile(id: string, claimId: string): Promise<void>;
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

export async function startPokCheckout(input: {
  intentId: string; readerId: string; title: string; origin: string; merchantId: string;
}, repo: PokRepository, orders: PokOrders, now = Date.now()) {
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
  const row: PokMapping = {
    intent_id: intent.id, merchant_custom_reference: `book:${intent.id}`,
    provider_order_id: null, checkout_url: null, webhook_token: randomUUID(),
    creation_claim_id: randomUUID(), state: "creating",
  };
  // Unique intent_id is the serialization point BEFORE any external call.
  if (!await repo.claim(row)) {
    const existing = await repo.mapping(intent.id);
    if (existing?.state === "ready" && existing.checkout_url && existing.provider_order_id) {
      const cachedUrl = validatePokCheckoutUrl(existing.checkout_url, existing.provider_order_id);
      let current: PokOrder;
      try {
        current = await orders.retrieveOrder(existing.provider_order_id);
      } catch {
        // Cannot confirm the cached order is still safe to hand out --
        // never resume blindly on an unconfirmed provider state.
        throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
      }
      assertReusableUnpaidOrder(current, {
        orderId: existing.provider_order_id, reference: existing.merchant_custom_reference,
        merchantId: input.merchantId, expectedMinor: intent.price_cents_at_checkout, currency: intent.currency,
      });
      return cachedUrl;
    }
    throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
  }
  try {
    const query = new URLSearchParams({ intent: intent.id, token: row.webhook_token });
    const order = await orders.createOrder({
      amount: intent.price_cents_at_checkout / 100, currencyCode: "ALL", autoCapture: true,
      shippingCost: 0, merchantCustomReference: row.merchant_custom_reference,
      description: input.title.slice(0, 200), expiresAfterMinutes: Math.min(remaining, 30),
      webhookUrl: `${origin.origin}/api/payments/pok/webhook?${query}`,
      redirectUrl: `${origin.origin}/payments/pok/return?${query}`,
      failRedirectUrl: `${origin.origin}/books/${intent.book_id}?canceled=true`,
    });
    if (order.merchantCustomReference !== row.merchant_custom_reference || order.currencyCode !== "ALL" ||
        (order.originalCurrencyCode !== undefined && order.originalCurrencyCode !== "ALL") || order.autoCapture === false ||
        pokAmountToMinor(order.finalAmount) !== intent.price_cents_at_checkout ||
        (order.merchant && order.merchant.id !== input.merchantId) || order.isCompleted || order.isRefunded || order.isCanceled === true) {
      throw new Error("POK_CREATED_ORDER_MISMATCH");
    }
    const url = validatePokCheckoutUrl(order._self?.confirmUrl ?? "", order.id);
    await repo.ready(intent.id, row.creation_claim_id, order.id, url);
    return url;
  } catch {
    // Keep the durable claim even if recording the diagnostic fails. Never
    // silently create another payable order after an ambiguous response.
    await repo.reconcile(intent.id, row.creation_claim_id).catch(() => undefined);
    throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
  }
}

export async function fulfillPokCheckout(input: {
  intentId: string; token: string; merchantId: string; readerId?: string;
}, repo: PokRepository, orders: PokOrders) {
  const mapping = await repo.mapping(input.intentId);
  if (!mapping || mapping.webhook_token !== input.token || mapping.state !== "ready" || !mapping.provider_order_id) {
    throw new Error("POK_INVALID_CALLBACK");
  }
  const intent = await repo.intent(input.intentId);
  validateIntent(intent);
  if (input.readerId !== undefined && input.readerId !== intent.reader_id) throw new Error("POK_FOREIGN_READER");
  const order = await orders.retrieveOrder(mapping.provider_order_id);
  const facts = verifiedPokPayment(order, {
    orderId: mapping.provider_order_id, reference: mapping.merchant_custom_reference,
    merchantId: input.merchantId, expectedMinor: intent.price_cents_at_checkout, currency: intent.currency,
  });
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
  if (["active_other_session", "blocked_book_or_reader_deleted", "blocked_disputed_lost"].includes(outcome)) {
    return { status: "blocked" as const, bookId: intent.book_id };
  }
  throw new Error("POK_UNKNOWN_FINALIZATION_OUTCOME");
}
