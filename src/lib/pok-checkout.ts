import { randomUUID } from "node:crypto";
import { pokAmountToMinor, validatePokCheckoutUrl, verifiedPokPayment } from "./pok";
import type { PokOrder, PokCreateOrder } from "./pok";

// Surfaced to the caller (buyBook) so it can give the reader an honest
// message instead of the generic "could not start checkout" -- thrown only
// when resuming an existing checkout would be unsafe (the provider order is
// expired, canceled/refunded, or already paid). Never thrown for ordinary
// transient/ambiguous failures, which stay POK_CHECKOUT_REQUIRES_RECONCILIATION.
export const POK_CHECKOUT_CANNOT_RESUME = "POK_CHECKOUT_CANNOT_RESUME";

// A durable "ready" mapping row is only a cache of what POK told us at
// CREATION time. POK orders expire well before Librum's own 23h intent
// retention window (createOrder below caps expiresAfterMinutes at 30), so a
// returning reader can hit this path long after the cached checkout_url has
// gone stale at the provider -- or, more dangerously, after it was already
// paid. Never trust the cached row alone: re-check the order's CURRENT
// provider-side state before ever handing its checkout_url out again.
function assertReusableUnpaidOrder(
  order: PokOrder,
  binding: { orderId: string; reference: string; merchantId: string; expectedMinor: number; currency: string },
  now: number,
): void {
  let facts: ReturnType<typeof verifiedPokPayment>;
  try {
    facts = verifiedPokPayment(order, binding);
  } catch {
    // Retrieved an order that doesn't even match this mapping's own
    // identity -- never safe to trust in any direction.
    throw new Error("POK_CHECKOUT_REQUIRES_RECONCILIATION");
  }
  if (facts) {
    // Genuinely, verifiably paid already. Handing back a checkout URL now
    // would invite a second payment attempt on a book that may already be
    // entitled once the webhook/return callback (the only paths that ever
    // call finalize) catches up -- this function grants nothing itself.
    throw new Error(POK_CHECKOUT_CANNOT_RESUME);
  }
  // isCanceled/isRefunded are the only terminal-failure signals this
  // adapter's schema captures; POK's docs do not state that either
  // guarantees the order can never later be marked paid, so this is a
  // "never hand this back out" decision, not a claim that the order is
  // conclusively dead.
  if (order.isCanceled === true || order.isRefunded) {
    throw new Error(POK_CHECKOUT_CANNOT_RESUME);
  }
  const expiresAt = Date.parse(order.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
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
      }, now);
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
