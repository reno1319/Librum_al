import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startPokCheckout, fulfillPokCheckout, probeProviderAttempt, classifyProviderAttempt,
  POK_CHECKOUT_CANNOT_RESUME, POK_CHECKOUT_MAINTENANCE_ACTIVE, POK_CHECKOUT_IN_PROGRESS,
  POK_CHECKOUT_AMBIGUOUS, POK_CHECKOUT_ATTEMPT_RETIRED, POK_EXPIRY_SAFETY_MARGIN_MS,
  type FrozenPokIntent, type PokMapping, type PokRepository, type PokRetireOutcome,
  type PokClaimOutcome,
} from "./pok-checkout";
import type { PokOrder } from "./pok";

// This test file's diagnostics coverage is scoped to the three stages
// pok-checkout.ts itself adds logging for (response_validation,
// checkout_url, ready_write) -- login/create_order/retrieve_order/
// invalid_response_shape are logged inside createPokClient itself and are
// covered in pok.test.ts against a real (mocked-fetch) client, not the
// plain PokOrders mocks used throughout this file.
function spyOnConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

const id = "11111111-1111-4111-8111-111111111111";
const merchantId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const paymentId = "44444444-4444-4444-8444-444444444444";
const now = Date.parse("2026-09-15T10:00:00Z");
// File-wide, not just one describe block: the classifier reads the clock
// AFTER the provider round trip (not an injected/passed value), so ANY
// test whose call graph can reach the reuse branch is clock-dependent on
// whatever the real wall clock happens to be unless pinned here. Applying
// this to every test in the file, not only the ones that obviously
// exercise that branch, is deliberate -- e.g. the concurrent-double-click
// creation test below can have its second call land in the reuse branch
// depending on microtask interleaving, and that must not become a
// real-time-dependent flake.
beforeEach(() => vi.useFakeTimers({ now: new Date(now) }));
afterEach(() => vi.useRealTimers());
const input = { intentId: id, readerId: "reader", merchantId, title: "Test", origin: "https://librum.example" };
const callback = { intentId: id, token: "callback", merchantId };
const url = `https://pay-staging.pokpay.io/sdk-orders/${orderId}`;
function setup(change: Partial<FrozenPokIntent> = {}) {
  const intent: FrozenPokIntent = { id, book_id: "book", reader_id: "reader", regime: "librum_ledger_v1", currency: "ALL", price_cents_at_checkout: 499,
    expires_at: "2026-09-15T10:30:00Z", stripe_checkout_session_id: null, ...change };
  let mapping: PokMapping | null = null;
  let retireOutcome: PokRetireOutcome = "retired_and_superseded";
  const repo = {
    intent: vi.fn(async () => intent), mapping: vi.fn(async () => mapping),
    // STALE-CHECKOUT-1: the claim is a typed RPC OUTCOME now, not a
    // boolean. The mock mirrors the real SQL exactly on the point that
    // matters -- the intent_id primary key is what makes a second claim
    // lose -- and it returns the granted window FROM the "database", the
    // same way claim_pok_book_checkout_order computes it, so no test can
    // pass by inventing a window the application made up itself.
    claim: vi.fn(async (row: { intentId: string; reference: string; webhookToken: string; claimId: string; requestedWindowMinutes: number }): Promise<PokClaimOutcome> => {
      if (mapping) return { outcome: "already_claimed" as const };
      mapping = { intent_id: row.intentId, merchant_custom_reference: row.reference, provider_order_id: null,
        checkout_url: null, webhook_token: row.webhookToken, creation_claim_id: row.claimId, state: "creating",
        provider_window_ends_at: new Date(now + row.requestedWindowMinutes * 60_000).toISOString() };
      return { outcome: "claimed" as const, grantedWindowMinutes: row.requestedWindowMinutes };
    }),
    // The precise CAS of the real repository: it matches the same claim
    // in state 'creating' and accepts an already-recorded IDENTICAL id,
    // which is exactly what makes the bounded retry safe.
    recordProviderOrder: vi.fn(async (_id: string, claimId: string, providerId: string) => {
      if (!mapping || mapping.creation_claim_id !== claimId || mapping.state !== "creating" ||
          (mapping.provider_order_id !== null && mapping.provider_order_id !== providerId)) {
        throw new Error("POK_ORDER_PERSISTENCE_FAILED");
      }
      mapping = { ...mapping, provider_order_id: providerId };
    }),
    ready: vi.fn(async (_id: string, _claim: string, checkout: string) => { mapping = { ...mapping!, state: "ready", checkout_url: checkout }; }),
    reconcile: vi.fn(async () => { if (mapping) mapping = { ...mapping, state: "needs_reconciliation" }; }),
    retire: vi.fn(async () => {
      if (retireOutcome === "retired_and_superseded" && mapping) mapping = { ...mapping, state: "retired" };
      return retireOutcome;
    }),
    recordEvent: vi.fn(async () => ({ id: "event", received_at: "2026-09-15T10:05:00Z" })),
    finalize: vi.fn(async () => "eligible_fulfilled"),
  } satisfies PokRepository;
  // Deliberately a CONSISTENT unpaid shape: capturedAmount explicitly `0`
  // (not absent -- classifyProviderAttempt treats a missing value as
  // ambiguous and blocks it; see pok-checkout.ts's own comment on why
  // this exact shape is a documented ASSUMPTION about the sandbox's real
  // response, not a confirmed contract), no transactionId,
  // isCompleted/isRefunded/isCanceled all explicitly false. A fixture
  // claiming "unpaid" while also reporting captured funds is exactly the
  // contradiction the classifier exists to reject -- tests that need a
  // paid order build one explicitly below instead of relying on this
  // fixture to be internally inconsistent.
  const order: PokOrder = { id: orderId, merchant: { id: merchantId }, merchantCustomReference: `book:${id}`, currencyCode: "ALL", originalCurrencyCode: "ALL",
    finalAmount: 4.99, capturedAmount: 0, autoCapture: true, isCompleted: false, isRefunded: false, isCanceled: false, transactionId: null, _self: { confirmUrl: url },
    expiresAt: "2026-09-15T10:30:00Z" };
  const orders = { createOrder: vi.fn(async () => order), retrieveOrder: vi.fn(async (): Promise<PokOrder> => ({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: 4.99 })) };
  function ready() {
    mapping = { intent_id: id, merchant_custom_reference: `book:${id}`, provider_order_id: orderId, checkout_url: url,
      webhook_token: callback.token, creation_claim_id: "claim", state: "ready",
      provider_window_ends_at: "2026-09-15T10:30:00Z" };
  }
  function blocked(state: PokMapping["state"] = "needs_reconciliation") {
    mapping = { intent_id: id, merchant_custom_reference: `book:${id}`, provider_order_id: null, checkout_url: null,
      webhook_token: "prior", creation_claim_id: "prior-claim", state,
      provider_window_ends_at: "2026-09-15T10:30:00Z" };
  }
  function retired() {
    ready();
    mapping = { ...mapping!, state: "retired" };
  }
  function setRetireOutcome(outcome: PokRetireOutcome) { retireOutcome = outcome; }
  function currentMapping() { return mapping; }
  return { repo, orders, order, ready, blocked, retired, setRetireOutcome, currentMapping };
}
describe("POK durable creation", () => {
  it("uses frozen server amount and serializes concurrent double clicks", async () => {
    const { repo, orders } = setup();
    const results = await Promise.allSettled([startPokCheckout(input, repo, orders, now), startPokCheckout(input, repo, orders, now)]);
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    expect(orders.createOrder).toHaveBeenCalledTimes(1);
    expect(orders.createOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 4.99, currencyCode: "ALL", autoCapture: true, shippingCost: 0 }));
    expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("asks POK for exactly the window SQL granted, never a locally invented one", async () => {
    const { repo, orders } = setup();
    // SQL's claim is the single clock: the granted window comes back FROM
    // the claim and that number -- not Math.min(remaining, 30) recomputed
    // in JavaScript, which would be 30 here -- must be what reaches
    // createOrder. The real insert still happens, so the rest of the
    // creation path is exercised normally.
    const realClaim = repo.claim.getMockImplementation()!;
    repo.claim.mockImplementation(async (row) => {
      const result = await realClaim(row);
      return result.outcome === "claimed" ? { outcome: "claimed", grantedWindowMinutes: 7 } : result;
    });
    await startPokCheckout(input, repo, orders, now);
    expect(orders.createOrder).toHaveBeenCalledWith(expect.objectContaining({ expiresAfterMinutes: 7 }));
  });
  it("records the provider order id BEFORE returning any URL, and returns a checkout_url result", async () => {
    const { repo, orders } = setup();
    const result = await startPokCheckout(input, repo, orders, now);
    expect(result).toEqual({ kind: "checkout_url", url });
    expect(repo.recordProviderOrder).toHaveBeenCalledWith(id, expect.any(String), orderId);
    // Persistence of the id strictly precedes the ready write that makes
    // the URL readable, which is the invariant "never hand back a URL for
    // an order we cannot name".
    expect(repo.recordProviderOrder.mock.invocationCallOrder[0])
      .toBeLessThan(repo.ready.mock.invocationCallOrder[0]);
  });
  it("retries the order-id persistence write, logs each retry, and succeeds without a second provider order", async () => {
    const consoleError = spyOnConsoleError();
    const { repo, orders } = setup();
    const real = repo.recordProviderOrder.getMockImplementation()!;
    repo.recordProviderOrder
      .mockRejectedValueOnce(new Error("db"))
      .mockImplementationOnce(real);
    const sleep = vi.fn(async () => undefined);
    const result = await startPokCheckout(input, repo, orders, now, sleep);
    expect(result).toEqual({ kind: "checkout_url", url });
    expect(orders.createOrder).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(200);
    expect(consoleError).toHaveBeenCalledWith("pok_critical", expect.objectContaining({
      code: "provider_order_persistence_retry", intentId: id, providerOrderId: orderId, attempt: 1,
    }));
    consoleError.mockRestore();
  });
  it("logs orphan_provider_order, reconciles, and never returns a URL when every persistence attempt fails", async () => {
    const consoleError = spyOnConsoleError();
    const { repo, orders } = setup();
    repo.recordProviderOrder.mockRejectedValue(new Error("db"));
    const sleep = vi.fn(async () => undefined);
    await expect(startPokCheckout(input, repo, orders, now, sleep)).rejects.toThrow("RECONCILIATION");
    // Three attempts in total: two backoffs, then the orphan log.
    expect(repo.recordProviderOrder).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[200], [600]]);
    expect(consoleError).toHaveBeenCalledWith("pok_critical", expect.objectContaining({
      code: "orphan_provider_order", intentId: id, providerOrderId: orderId,
    }));
    expect(repo.ready).not.toHaveBeenCalled();
    expect(repo.reconcile).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
  it("never logs the checkout URL, the webhook token or credentials in a critical diagnostic", async () => {
    const consoleError = spyOnConsoleError();
    const { repo, orders } = setup();
    repo.recordProviderOrder.mockRejectedValue(new Error("db"));
    await expect(startPokCheckout(input, repo, orders, now, async () => undefined)).rejects.toThrow("RECONCILIATION");
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain("pay-staging.pokpay.io");
    expect(logged).not.toContain("sdk-orders");
    expect(logged).toContain("orphan_provider_order");
    consoleError.mockRestore();
  });
  it("reuses a ready mapping without another payable order (see 'POK checkout-link reuse safety' for the full validation matrix)", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue(order); // active, unpaid, unexpired
    expect(await startPokCheckout(input, repo, orders, now)).toEqual({ kind: "checkout_url", url });
    expect(orders.retrieveOrder).toHaveBeenCalledWith(orderId);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("never retries after an ambiguous external failure", async () => {
    const { repo, orders } = setup(); orders.createOrder.mockRejectedValue(new Error("timeout"));
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).toHaveBeenCalledTimes(1); expect(repo.reconcile).toHaveBeenCalledTimes(1);
  });
  it.each([{ currency: "USD" }, { regime: "legacy_stripe_connect_v1" }, { reader_id: "other" },
    { expires_at: "invalid" }, { expires_at: "2026-09-15T09:59:00Z" }, { price_cents_at_checkout: 0 },
    { stripe_checkout_session_id: "cs_existing" }])("rejects unsuitable frozen intent %j", async (change) => {
    const { repo, orders } = setup(change);
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(); expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it.each([
    "intent_not_found", "intent_not_claimable", "intent_expired", "intent_stripe_bound", "reference_mismatch",
  ] as const)("creates no provider order when the claim RPC answers %s", async (outcome) => {
    const { repo, orders } = setup();
    repo.claim.mockResolvedValue({ outcome });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.recordProviderOrder).not.toHaveBeenCalled();
  });
  it.each([{ finalAmount: 5 }, { currencyCode: "USD" }, { originalCurrencyCode: "EUR" }, { autoCapture: false },
    { merchantCustomReference: "other" }, { isCompleted: true },
    { _self: { confirmUrl: `https://pay-staging.pokpay.io/sdk-orders/${paymentId}` } },
    { _self: { confirmUrl: "https://evil.example" } }])("quarantines mismatched creation %j", async (change) => {
    const { repo, orders, order } = setup(); orders.createOrder.mockResolvedValue({ ...order, ...change });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(repo.ready).not.toHaveBeenCalled(); expect(repo.reconcile).toHaveBeenCalled();
  });
  it("keeps the recorded provider order id when validation fails after persistence", async () => {
    const { repo, orders, order, currentMapping } = setup();
    // The economic mismatch is detected AFTER the id was written. The
    // whole point of writing it first is that the orphan stays nameable,
    // so reconcile() must not undo it.
    orders.createOrder.mockResolvedValue({ ...order, finalAmount: 5 });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(repo.recordProviderOrder).toHaveBeenCalledWith(id, expect.any(String), orderId);
    expect(currentMapping()).toMatchObject({ provider_order_id: orderId, state: "needs_reconciliation" });
  });
  it("logs an allowlisted response_validation diagnostic for a returned-order binding mismatch, never the raw message", async () => {
    const consoleError = spyOnConsoleError();
    const { repo, orders, order } = setup();
    orders.createOrder.mockResolvedValue({ ...order, currencyCode: "USD" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "response_validation", code: "binding_mismatch" });
    consoleError.mockRestore();
  });
  it("logs response_validation, reconciles exactly once, and never saves ready state when the returned order's amount fails conversion (e.g. finalAmount: 0)", async () => {
    const consoleError = spyOnConsoleError();
    const { repo, orders, order } = setup();
    // pokAmountToMinor(0) throws POK_INVALID_AMOUNT WHILE the mismatch-check
    // condition is still being evaluated -- before the condition's own
    // explicit throw is ever reached. That throw must be caught by the
    // same response_validation try/catch as the explicit mismatch, not
    // skip it and fall straight through to the outer catch's generic,
    // unlogged reconciliation.
    orders.createOrder.mockResolvedValue({ ...order, finalAmount: 0 });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "response_validation", code: "invalid_amount" });
    expect(repo.reconcile).toHaveBeenCalledTimes(1);
    expect(repo.ready).not.toHaveBeenCalled();
    expect(orders.createOrder).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
  it("logs an allowlisted checkout_url diagnostic when the confirmUrl is untrusted, never the raw URL", async () => {
    const consoleError = spyOnConsoleError();
    const { repo, orders, order } = setup();
    orders.createOrder.mockResolvedValue({ ...order, _self: { confirmUrl: "https://evil.example" } });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "checkout_url", code: "untrusted_checkout_url" });
    const loggedPayload = JSON.stringify(consoleError.mock.calls);
    expect(loggedPayload).not.toContain("evil.example");
    consoleError.mockRestore();
  });
  it("preserves the claim, reconciles, and logs an allowlisted ready_write diagnostic when the durable save fails", async () => {
    const consoleError = spyOnConsoleError();
    const { repo, orders } = setup();
    repo.ready.mockRejectedValue(new Error("POK_LINK_FAILED"));
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(repo.reconcile).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "ready_write", code: "ready_write_failed" });
    consoleError.mockRestore();
  });
  it("never calls the provider again when a mapping is already needs_reconciliation-blocked", async () => {
    const { repo, orders, blocked } = setup();
    // An already-blocked, ID-LESS mapping from a prior ambiguous attempt.
    // repo.claim's own mock loses whenever `mapping` is already set,
    // exactly matching the real primary-key semantics.
    blocked();
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
    // The already-blocked row's own state is left exactly as it was --
    // this path never touches it again, and only SQL may retire an
    // id-less attempt once the locally-requested window elapses.
    expect(repo.reconcile).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("reports an id-less CREATING mapping as in-progress rather than as reconciliation", async () => {
    const { repo, orders, blocked } = setup();
    blocked("creating");
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_IN_PROGRESS);
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("keeps claim after failed diagnostic write", async () => {
    const { repo, orders } = setup(); orders.createOrder.mockRejectedValue(new Error("timeout")); repo.reconcile.mockRejectedValue(new Error("db"));
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow();
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(); expect(orders.createOrder).toHaveBeenCalledTimes(1);
  });
});
describe("POK checkout-link reuse safety", () => {
  it("reproduces and blocks: completed order with transactionId but no capturedAmount was previously ALLOWED", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // Exactly the reviewer's first repro: isCompleted=true, transactionId
    // present, capturedAmount MISSING. verifiedPokPayment(...) === null
    // here (proof incomplete), which the original code wrongly read as
    // "safe, still unpaid". A completed, non-refunded order is now routed
    // to FULFILMENT rather than to a checkout link -- fulfilment
    // re-verifies the captured amount itself and reports 'pending'
    // because the proof is incomplete. What must never happen, and does
    // not, is handing back a payable URL.
    orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: undefined });
    expect(await startPokCheckout(input, repo, orders, now)).toEqual({ kind: "fulfilment_pending", bookId: "book" });
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.finalize).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("reproduces and blocks: unpaid order silently bound to a different currency was previously ALLOWED", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // Reviewer's second repro: still unpaid (isCompleted false), but
    // currencyCode/originalCurrencyCode changed to USD. verifiedPokPayment
    // never checks currency for an unpaid order, so the old code let this
    // through untouched.
    orders.retrieveOrder.mockResolvedValue({ ...order, currencyCode: "USD", originalCurrencyCode: "USD" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("reproduces and blocks: unpaid order silently repriced was previously ALLOWED", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // Reviewer's third repro: still unpaid, but finalAmount changed from
    // 4.99 to 999. Same root cause as the currency case.
    orders.retrieveOrder.mockResolvedValue({ ...order, finalAmount: 999 });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });

  it("allows reuse of an active, correctly bound, correctly priced, unexpired checkout with an explicit zero captured amount", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    expect(order.capturedAmount).toBe(0); // the fixture IS the explicit-zero case under test
    orders.retrieveOrder.mockResolvedValue(order);
    expect(await startPokCheckout(input, repo, orders, now)).toEqual({ kind: "checkout_url", url });
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it.each([
    { label: "wrong order id", change: { id: "99999999-9999-4999-8999-999999999999" } },
    { label: "wrong merchant id", change: { merchant: { id: "99999999-9999-4999-8999-999999999999" } } },
    { label: "wrong reference", change: { merchantCustomReference: "book:someone-else" } },
    { label: "repriced (999 instead of 4.99)", change: { finalAmount: 999 } },
    { label: "current currency changed to USD", change: { currencyCode: "USD" } },
    { label: "original currency changed to USD (FX)", change: { originalCurrencyCode: "USD" } },
  ])("blocks reuse for reconciliation on $label", async ({ change }) => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, ...change });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
    // A mismatched binding is never evidence that the attempt is dead.
    expect(repo.retire).not.toHaveBeenCalled();
  });

  it("RETIRES rather than permanently blocking once the POK order has expired, and never mints the replacement itself", async () => {
    const { repo, orders, order, ready, currentMapping } = setup(); ready();
    // Librum's own intent (expires_at 10:30) is still valid at `now` (10:00);
    // the POK order itself already expired past the safety margin. This is
    // the 23-hour lockout this whole repair exists to remove: the attempt
    // is provably dead, so it is retired and the intent superseded
    // ATOMICALLY in SQL, and the caller is told it may mint exactly one
    // replacement. startPokCheckout itself creates no second order.
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "2026-09-15T09:50:00Z" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_ATTEMPT_RETIRED);
    expect(repo.retire).toHaveBeenCalledWith({
      intentId: id, expectedClaimId: "claim", expectedProviderOrderId: orderId,
      expectedState: "ready", retiredReason: "provider_attempt_expired",
    });
    expect(currentMapping()).toMatchObject({ state: "retired" });
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("does NOT retire an order inside the expiry safety margin", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // Expired by the provider's own clock, but less than the margin ago.
    // Retiring here is exactly the race the margin exists to prevent: a
    // hosted-page submission already in flight when expiresAt passed.
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: new Date(now - POK_EXPIRY_SAFETY_MARGIN_MS + 1_000).toISOString() });
    expect(await startPokCheckout(input, repo, orders, now)).toEqual({ kind: "checkout_url", url });
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("blocks as AMBIGUOUS, never retires, on an unparseable expiry", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // The honest failure direction: an order id exists, so only POK's own
    // expiry may retire it, and an unparseable one proves nothing at any
    // age. Falling back to Librum's locally-requested window here would
    // retire an attempt whose URL the reader is holding.
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "not-a-date" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_AMBIGUOUS);
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("blocks reuse when the order expires WHILE the retrieval request is in flight", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // The order is still unexpired at the moment startPokCheckout is
    // invoked (`now` = 10:00:00, expiresAt = 10:00:30) -- but the provider
    // round-trip itself takes long enough that, by the time it resolves,
    // the order has already crossed its expiry plus the safety margin.
    // Only a fresh post-retrieval clock read catches this; the stale
    // pre-call `now` would not.
    orders.retrieveOrder.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-09-15T10:05:00Z"));
      return { ...order, expiresAt: "2026-09-15T10:00:30Z" };
    });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_ATTEMPT_RETIRED);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it("retires a canceled order with no payment evidence", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isCanceled: true });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_ATTEMPT_RETIRED);
    expect(repo.retire).toHaveBeenCalledWith(expect.objectContaining({ retiredReason: "provider_attempt_canceled" }));
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it.each([
    { label: "transaction id present", change: { transactionId: paymentId } },
    { label: "positive captured amount", change: { capturedAmount: 4.99 } },
  ])("never retires a canceled order contradicted by payment evidence: $label", async ({ change }) => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isCanceled: true, ...change });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("blocks a refunded order for reconciliation and never retires it", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isRefunded: true });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("routes an already-paid order to FULFILMENT rather than offering checkout again or retiring it", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: 4.99 });
    expect(await startPokCheckout(input, repo, orders, now)).toEqual({ kind: "fulfilled", bookId: "book" });
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
    expect(repo.finalize).toHaveBeenCalled();
  });
  it.each([
    // Missing capture evidence blocks as ambiguous -- no documented
    // provider guarantee establishes that an absent capturedAmount means
    // "zero" on an order POK still calls open (see pok-checkout.ts).
    { label: "captured amount missing (undefined) on an unpaid order", change: { capturedAmount: undefined } },
    // isCanceled and autoCapture are both optional() in pokOrderSchema,
    // so undefined is a real wire value, and neither can prove the order
    // is still open and still set to capture -- the same reasoning that
    // makes an absent isRefunded block. Absence blocks a RESUME here;
    // what it must never do is block a retirement, which the classifier
    // tests below pin down directly.
    { label: "missing isCanceled", change: { isCanceled: undefined } },
    { label: "missing autoCapture", change: { autoCapture: undefined } },
  ])("blocks as AMBIGUOUS, never retiring, on unprovable status: $label", async ({ change }) => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, ...change });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_AMBIGUOUS);
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it.each([
    { label: "positive captured amount on an unpaid order", change: { capturedAmount: 4.99 } },
    { label: "transaction id present on an unpaid order", change: { transactionId: paymentId } },
    { label: "autoCapture false", change: { autoCapture: false } },
  ])("blocks for reconciliation on a contradictory status field: $label", async ({ change }) => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, ...change });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("never resumes or retires when the provider order is unreachable", async () => {
    const { repo, orders, ready } = setup(); ready();
    orders.retrieveOrder.mockRejectedValue(new Error("timeout"));
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_AMBIGUOUS);
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it("never resumes when the retrieved order doesn't match this mapping's own binding", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, merchantCustomReference: "book:someone-else" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("concurrent retries against an active unpaid checkout never create a duplicate payable order", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue(order);
    const results = await Promise.all([startPokCheckout(input, repo, orders, now), startPokCheckout(input, repo, orders, now)]);
    expect(results).toEqual([{ kind: "checkout_url", url }, { kind: "checkout_url", url }]);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("concurrent retries against an expired checkout never create a duplicate payable order", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "2026-09-15T09:50:00Z" });
    const results = await Promise.allSettled([startPokCheckout(input, repo, orders, now), startPokCheckout(input, repo, orders, now)]);
    expect(results.every(r => r.status === "rejected")).toBe(true);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
});

// STALE-CHECKOUT-1: the classifier is the single decision point for
// "payable, dead, paid, or unprovable", so it is tested directly as well
// as through startPokCheckout -- the sentinel-level tests above cannot
// distinguish RETIRE_SAFE's two reasons, and the reason is what gets
// written into retired_reason.
describe("classifyProviderAttempt", () => {
  const binding = { orderId, reference: `book:${id}`, merchantId, expectedMinor: 499, currency: "ALL" };
  const base: PokOrder = { id: orderId, merchant: { id: merchantId }, merchantCustomReference: `book:${id}`,
    currencyCode: "ALL", originalCurrencyCode: "ALL", finalAmount: 4.99, capturedAmount: 0, autoCapture: true,
    isCompleted: false, isRefunded: false, isCanceled: false, transactionId: null, _self: { confirmUrl: url },
    expiresAt: "2026-09-15T10:30:00Z" };
  it.each([
    { label: "open and provably unpaid", change: {}, expected: { outcome: "RESUMABLE" } },
    { label: "completed, not refunded", change: { isCompleted: true, transactionId: paymentId, capturedAmount: 4.99 }, expected: { outcome: "FULFIL" } },
    { label: "refunded", change: { isRefunded: true }, expected: { outcome: "BLOCKED_RECONCILE" } },
    { label: "completed AND refunded", change: { isCompleted: true, isRefunded: true }, expected: { outcome: "BLOCKED_RECONCILE" } },
    { label: "canceled, clean", change: { isCanceled: true }, expected: { outcome: "RETIRE_SAFE", reason: "provider_attempt_canceled" } },
    { label: "expired past the margin", change: { expiresAt: "2026-09-15T09:50:00Z" }, expected: { outcome: "RETIRE_SAFE", reason: "provider_attempt_expired" } },
    { label: "unparseable expiry", change: { expiresAt: "nope" }, expected: { outcome: "BLOCKED_AMBIGUOUS" } },
    { label: "absent capture evidence", change: { capturedAmount: undefined }, expected: { outcome: "BLOCKED_AMBIGUOUS" } },
    { label: "absent isCanceled", change: { isCanceled: undefined }, expected: { outcome: "BLOCKED_AMBIGUOUS" } },
    { label: "absent isRefunded", change: { isRefunded: undefined as unknown as boolean }, expected: { outcome: "BLOCKED_RECONCILE" } },
  ])("classifies $label", ({ change, expected }) => {
    expect(classifyProviderAttempt({ ...base, ...change }, binding, now)).toEqual(expected);
  });
  // ---- The autoCapture ordering, forced by the independent audit ----
  //
  // The rule these seven cases pin down: an ABSENT optional field may
  // stop a RESUME, and must never stop a RETIREMENT. The first version
  // of this classifier tested `autoCapture !== true` ahead of the expiry
  // rule, so an order expired twelve hours ago with autoCapture merely
  // missing was permanently un-retireable -- the exact lockout this
  // whole repair exists to remove, reintroduced through one optional
  // field. Each case below fails if that ordering ever comes back.
  const expiredLongAgo = "2026-09-14T22:00:00Z"; // ~12 hours before `now`
  it("retires an order expired 12 hours ago even though autoCapture is ABSENT", () => {
    expect(classifyProviderAttempt({ ...base, autoCapture: undefined, expiresAt: expiredLongAgo }, binding, now))
      .toEqual({ outcome: "RETIRE_SAFE", reason: "provider_attempt_expired" });
  });
  it("never RESUMES an unexpired order whose autoCapture is ABSENT", () => {
    // The other half of the same rule: absence is not permission to hand
    // a payable URL back.
    expect(classifyProviderAttempt({ ...base, autoCapture: undefined }, binding, now))
      .toEqual({ outcome: "BLOCKED_AMBIGUOUS" });
  });
  it("blocks an expired order whose autoCapture is explicitly FALSE, rather than retiring it", () => {
    // Explicitly false is a contradiction, not an absence, so it
    // legitimately outranks the expiry.
    expect(classifyProviderAttempt({ ...base, autoCapture: false, expiresAt: expiredLongAgo }, binding, now))
      .toEqual({ outcome: "BLOCKED_RECONCILE" });
  });
  it("resumes only when autoCapture is explicitly true, unexpired, with an explicit zero capture", () => {
    expect(classifyProviderAttempt({ ...base, autoCapture: true, capturedAmount: 0 }, binding, now))
      .toEqual({ outcome: "RESUMABLE" });
  });
  it("retires on a proven expiry with isCanceled ABSENT", () => {
    expect(classifyProviderAttempt({ ...base, isCanceled: undefined, expiresAt: expiredLongAgo }, binding, now))
      .toEqual({ outcome: "RETIRE_SAFE", reason: "provider_attempt_expired" });
  });
  it("retires on a proven expiry with capturedAmount ABSENT", () => {
    expect(classifyProviderAttempt({ ...base, capturedAmount: undefined, expiresAt: expiredLongAgo }, binding, now))
      .toEqual({ outcome: "RETIRE_SAFE", reason: "provider_attempt_expired" });
  });
  it.each([true, false, undefined])(
    "never retires on an UNPARSEABLE expiry, whatever autoCapture reads (%s)", (autoCapture) => {
    // No local clock may stand in for the provider's own statement. With
    // no parseable expiry there is no proof of death at any age, so the
    // only legal outcomes are ambiguity or contradiction -- never
    // RETIRE_SAFE.
    const verdict = classifyProviderAttempt({ ...base, autoCapture, expiresAt: "not-a-date" }, binding, now);
    expect(verdict.outcome).not.toBe("RETIRE_SAFE");
    expect(verdict.outcome).toBe(autoCapture === false ? "BLOCKED_RECONCILE" : "BLOCKED_AMBIGUOUS");
  });
  it("still blocks a CONTRADICTED expiry: evidence of payment outranks the expiry, absence does not", () => {
    // The two directions of the same ordering rule, side by side.
    expect(classifyProviderAttempt({ ...base, transactionId: paymentId, expiresAt: expiredLongAgo }, binding, now))
      .toEqual({ outcome: "BLOCKED_RECONCILE" });
    expect(classifyProviderAttempt({ ...base, capturedAmount: 4.99, expiresAt: expiredLongAgo }, binding, now))
      .toEqual({ outcome: "BLOCKED_RECONCILE" });
  });

  it("lets a proven expiry outrank an absent isCanceled, so a missing field can never make the lockout permanent", () => {
    // Ordering is the whole point: if the isCanceled check ran before the
    // expiry check, this attempt would be un-retireable forever -- exactly
    // the defect this repair removes.
    expect(classifyProviderAttempt({ ...base, isCanceled: undefined, expiresAt: "2026-09-15T09:50:00Z" }, binding, now))
      .toEqual({ outcome: "RETIRE_SAFE", reason: "provider_attempt_expired" });
  });
  it("refuses to retire a refunded order even once it has expired", () => {
    expect(classifyProviderAttempt({ ...base, isRefunded: true, expiresAt: "2026-09-15T09:50:00Z" }, binding, now))
      .toEqual({ outcome: "BLOCKED_RECONCILE" });
  });
});

describe("probeProviderAttempt", () => {
  const probeInput = { intentId: id, merchantId };
  it("reports an absent mapping as reconciliation, never as a retired attempt", async () => {
    const { repo, orders } = setup();
    expect(await probeProviderAttempt(probeInput, repo, orders, now)).toEqual({ kind: "needs_reconciliation" });
    expect(repo.retire).not.toHaveBeenCalled();
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
  });
  it("reports an already-retired mapping as retired without another provider call", async () => {
    const { repo, orders, retired } = setup(); retired();
    expect(await probeProviderAttempt(probeInput, repo, orders, now)).toEqual({ kind: "retired" });
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
  });
  it.each([
    { state: "creating" as const, expected: { kind: "in_progress" } },
    { state: "needs_reconciliation" as const, expected: { kind: "needs_reconciliation" } },
    { state: "ready" as const, expected: { kind: "needs_reconciliation" } },
  ])("never retires an id-less mapping in state $state", async ({ state, expected }) => {
    const { repo, orders, blocked } = setup(); blocked(state);
    expect(await probeProviderAttempt(probeInput, repo, orders, now)).toEqual(expected);
    expect(repo.retire).not.toHaveBeenCalled();
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
  });
  it.each([
    "mapping_changed", "not_retireable", "not_found", "reader_or_book_deleted",
    "invalid_retired_reason", "reason_not_coherent",
  ] as const)("never permits a replacement when the retire RPC answers %s", async (outcome) => {
    const { repo, orders, order, ready, setRetireOutcome } = setup(); ready();
    setRetireOutcome(outcome);
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "2026-09-15T09:50:00Z" });
    expect(await probeProviderAttempt(probeInput, repo, orders, now)).toEqual({ kind: "needs_reconciliation" });
  });
  it.each(["already_completed", "already_fulfilled"] as const)("routes a %s retire outcome to ownership, never to a replacement", async (outcome) => {
    const { repo, orders, order, ready, setRetireOutcome } = setup(); ready();
    setRetireOutcome(outcome);
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "2026-09-15T09:50:00Z" });
    expect(await probeProviderAttempt(probeInput, repo, orders, now)).toEqual({ kind: "fulfilled", bookId: "book" });
  });
  it("returns a resumable URL only from the stored mapping, validated against the stored order id", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue(order);
    expect(await probeProviderAttempt(probeInput, repo, orders, now)).toEqual({ kind: "resumable", url });
  });
  it("returns resumable with no URL when an order exists but none was ever stored", async () => {
    const { repo, orders, order, ready, currentMapping } = setup(); ready();
    const stored = currentMapping()!;
    repo.mapping.mockResolvedValue({ ...stored, state: "creating", checkout_url: null });
    orders.retrieveOrder.mockResolvedValue(order);
    expect(await probeProviderAttempt(probeInput, repo, orders, now)).toEqual({ kind: "resumable", url: null });
    expect(repo.retire).not.toHaveBeenCalled();
  });
});
describe("POK atomic fulfillment", () => {
  it("retries use the first verified observation timestamp", async () => {
    const { repo, orders, ready } = setup(); ready();
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("fulfilled");
    repo.finalize.mockResolvedValue("already_finalized");
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("fulfilled");
    expect(repo.finalize.mock.calls[0]).toEqual(repo.finalize.mock.calls[1]);
    expect(repo.finalize).toHaveBeenCalledWith(expect.objectContaining({ minor: 499, paymentId, currency: "ALL", paidAt: "2026-09-15T10:05:00Z" }));
  });
  it.each([{ token: "forged" }, { readerId: "foreign" }])("rejects forged/foreign callback %j", async (change) => {
    const { repo, orders, ready } = setup(); ready();
    await expect(fulfillPokCheckout({ ...callback, ...change }, repo, orders)).rejects.toThrow();
    expect(orders.retrieveOrder).not.toHaveBeenCalled(); expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("callback without durable ready mapping cannot fulfill", async () => {
    const { repo, orders } = setup(); await expect(fulfillPokCheckout(callback, repo, orders)).rejects.toThrow(); expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("rejects a callback on a mapping with no recorded provider order id", async () => {
    // The order id, not the mapping's state, is what a fulfilment is
    // bound to -- there is nothing to retrieve and nothing to verify
    // without it.
    const { repo, orders, blocked } = setup(); blocked("creating");
    await expect(fulfillPokCheckout({ ...callback, token: "prior" }, repo, orders)).rejects.toThrow("POK_INVALID_CALLBACK");
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
    expect(repo.finalize).not.toHaveBeenCalled();
  });
  // STALE-CHECKOUT-1: the state guard was `mapping.state !== "ready"`,
  // which silently DROPPED a verified late payment on a mapping that had
  // moved on. After this repair a retired mapping is an ORDINARY thing
  // for a late callback to land on, and money must still reach
  // fulfilment.
  it("fulfils a verified late payment on a RETIRED mapping and emits the critical diagnostic", async () => {
    const consoleError = spyOnConsoleError();
    const { repo, orders, retired } = setup(); retired();
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("fulfilled");
    expect(repo.finalize).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("pok_critical", expect.objectContaining({
      code: "fulfilment_on_retired_mapping", intentId: id, providerOrderId: orderId, mappingState: "retired",
    }));
    consoleError.mockRestore();
  });
  it("fulfils a verified late payment on a needs_reconciliation mapping", async () => {
    const { repo, orders, ready, currentMapping } = setup(); ready();
    repo.mapping.mockResolvedValue({ ...currentMapping()!, state: "needs_reconciliation" });
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("fulfilled");
    expect(repo.finalize).toHaveBeenCalled();
  });
  it("pending/unproven (completed, capture evidence absent) creates no event or entitlement", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: undefined });
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("pending");
    expect(repo.recordEvent).not.toHaveBeenCalled(); expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("an open order carrying a transaction id is BLOCKED, not pending: the two facts contradict each other", async () => {
    // Previously this shape reported 'pending' and the webhook route
    // turned that into a 503 retry loop over a state no retry can
    // resolve. It is a reconciliation fact.
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: false, transactionId: paymentId });
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("blocked");
    expect(repo.recordEvent).not.toHaveBeenCalled(); expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("a genuinely open, unpaid order is pending", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue(order);
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("pending");
    expect(repo.recordEvent).not.toHaveBeenCalled(); expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("reports a refunded order as BLOCKED, never as pending, so the webhook cannot retry it forever", async () => {
    // A 'pending' answer becomes a 503 in the webhook route -- a retry
    // signal for a state that can never resolve.
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: 4.99, isRefunded: true });
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("blocked");
    expect(repo.recordEvent).not.toHaveBeenCalled(); expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("authenticated mismatched amount cannot fulfill", async () => {
    const { repo, orders, order, ready } = setup(); ready(); orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: 5 });
    await expect(fulfillPokCheckout(callback, repo, orders)).rejects.toThrow(); expect(repo.finalize).not.toHaveBeenCalled();
  });
  it.each(["active_other_session", "blocked_book_or_reader_deleted", "blocked_disputed_lost"])("does not report success for DB outcome %s", async outcome => {
    const { repo, orders, ready } = setup(); ready(); repo.finalize.mockResolvedValue(outcome);
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("blocked");
  });
  it("unknown DB outcome is not treated as success", async () => {
    const { repo, orders, ready } = setup(); ready(); repo.finalize.mockResolvedValue("surprise");
    await expect(fulfillPokCheckout(callback, repo, orders)).rejects.toThrow("UNKNOWN");
  });
});

// APP A CORRECTION 2: startPokCheckout() is the actual provider-order-
// creation operation (V3 §3 / buyBook's own top-of-function gate is a
// separate, earlier layer) -- this proves its own defense-in-depth
// maintenance check rejects before repository access, intent creation/
// reuse, or any provider order call, and that maintenance-off preserves
// the function's already-tested normal behavior.
describe("startPokCheckout: maintenance-mode gate (APP A CORRECTION 2)", () => {
  beforeEach(() => vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active"));
  afterEach(() => vi.unstubAllEnvs());

  it("rejects with the dedicated sentinel before any repository or provider call", async () => {
    const { repo, orders } = setup();
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(
      POK_CHECKOUT_MAINTENANCE_ACTIVE,
    );
    expect(repo.intent).not.toHaveBeenCalled();
    expect(repo.mapping).not.toHaveBeenCalled();
    expect(repo.claim).not.toHaveBeenCalled();
    expect(repo.recordProviderOrder).not.toHaveBeenCalled();
    expect(repo.ready).not.toHaveBeenCalled();
    expect(repo.reconcile).not.toHaveBeenCalled();
    expect(repo.retire).not.toHaveBeenCalled();
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves the function's established creation behavior", async () => {
    vi.unstubAllEnvs();
    const { repo, orders } = setup();
    const result = await startPokCheckout(input, repo, orders, now);
    expect(result).toEqual({ kind: "checkout_url", url });
    expect(orders.createOrder).toHaveBeenCalledOnce();
  });
});

// The sentinel exists and is still exported, but nothing in the new
// classifier throws it: every state it used to cover now resolves to a
// more specific sentinel (RETIRED, AMBIGUOUS) or to reconciliation. It is
// asserted rather than quietly deleted because buyBook still maps it, and
// a stale mapping that can never fire is worth knowing about.
describe("POK_CHECKOUT_CANNOT_RESUME", () => {
  it("is no longer thrown by any reuse path", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    for (const change of [
      { expiresAt: "2026-09-15T09:50:00Z" }, { expiresAt: "not-a-date" }, { isCanceled: true },
      { isRefunded: true }, { capturedAmount: undefined }, { transactionId: paymentId },
    ]) {
      const fresh = setup(); fresh.ready();
      fresh.orders.retrieveOrder.mockResolvedValue({ ...order, ...change });
      const outcome = await startPokCheckout(input, fresh.repo, fresh.orders, now).catch((err: Error) => err.message);
      expect(outcome).not.toBe(POK_CHECKOUT_CANNOT_RESUME);
    }
    expect(repo.intent).not.toHaveBeenCalled();
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
});
