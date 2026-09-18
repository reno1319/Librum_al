import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPokCheckout, fulfillPokCheckout, POK_CHECKOUT_CANNOT_RESUME, POK_CHECKOUT_MAINTENANCE_ACTIVE, type FrozenPokIntent, type PokMapping, type PokRepository } from "./pok-checkout";
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
// File-wide, not just one describe block: assertReusableUnpaidOrder reads
// Date.now() directly (not an injected/passed value), so ANY test whose
// call graph can reach the reuse branch is clock-dependent on whatever the
// real wall clock happens to be unless pinned here. Applying this to every
// test in the file, not only the ones that obviously exercise that branch,
// is deliberate -- e.g. the concurrent-double-click creation test below can
// have its second call land in the reuse branch depending on microtask
// interleaving, and that must not become a real-time-dependent flake.
beforeEach(() => vi.useFakeTimers({ now: new Date(now) }));
afterEach(() => vi.useRealTimers());
const input = { intentId: id, readerId: "reader", merchantId, title: "Test", origin: "https://librum.example" };
const callback = { intentId: id, token: "callback", merchantId };
const url = `https://pay-staging.pokpay.io/sdk-orders/${orderId}`;
function setup(change: Partial<FrozenPokIntent> = {}) {
  const intent: FrozenPokIntent = { id, book_id: "book", reader_id: "reader", regime: "librum_ledger_v1", currency: "ALL", price_cents_at_checkout: 499,
    expires_at: "2026-09-15T10:30:00Z", stripe_checkout_session_id: null, ...change };
  let mapping: PokMapping | null = null;
  const repo = {
    intent: vi.fn(async () => intent), mapping: vi.fn(async () => mapping),
    claim: vi.fn(async (row: PokMapping) => { if (mapping) return false; mapping = { ...row }; return true; }),
    ready: vi.fn(async (_id: string, _claim: string, providerId: string, checkout: string) => { mapping = { ...mapping!, state: "ready", provider_order_id: providerId, checkout_url: checkout }; }),
    reconcile: vi.fn(async () => { if (mapping) mapping.state = "needs_reconciliation"; }),
    recordEvent: vi.fn(async () => ({ id: "event", received_at: "2026-09-15T10:05:00Z" })),
    finalize: vi.fn(async () => "eligible_fulfilled"),
  } satisfies PokRepository;
  // Deliberately a CONSISTENT unpaid shape: capturedAmount explicitly `0`
  // (not absent -- assertReusableUnpaidOrder treats a missing value as
  // ambiguous and blocks it; see pok-checkout.ts's own comment on why
  // this exact shape is a documented ASSUMPTION about the sandbox's real
  // response, not a confirmed contract), no transactionId,
  // isCompleted/isRefunded/isCanceled all explicitly false. A fixture
  // claiming "unpaid" while also reporting captured funds is exactly the
  // contradiction assertReusableUnpaidOrder exists to reject -- tests
  // that need a paid order build one explicitly below instead of relying
  // on this fixture to be internally inconsistent.
  const order: PokOrder = { id: orderId, merchant: { id: merchantId }, merchantCustomReference: `book:${id}`, currencyCode: "ALL", originalCurrencyCode: "ALL",
    finalAmount: 4.99, capturedAmount: 0, autoCapture: true, isCompleted: false, isRefunded: false, isCanceled: false, transactionId: null, _self: { confirmUrl: url },
    expiresAt: "2026-09-15T10:30:00Z" };
  const orders = { createOrder: vi.fn(async () => order), retrieveOrder: vi.fn(async (): Promise<PokOrder> => ({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: 4.99 })) };
  function ready() { mapping = { intent_id: id, merchant_custom_reference: `book:${id}`, provider_order_id: orderId, checkout_url: url, webhook_token: callback.token, creation_claim_id: "claim", state: "ready" }; }
  return { repo, orders, order, ready };
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
  it("reuses a ready mapping without another payable order (see 'POK checkout-link reuse safety' for the full validation matrix)", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue(order); // active, unpaid, unexpired
    expect(await startPokCheckout(input, repo, orders, now)).toBe(url);
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
  it.each([{ finalAmount: 5 }, { currencyCode: "USD" }, { originalCurrencyCode: "EUR" }, { autoCapture: false },
    { merchantCustomReference: "other" }, { isCompleted: true },
    { _self: { confirmUrl: `https://pay-staging.pokpay.io/sdk-orders/${paymentId}` } },
    { _self: { confirmUrl: "https://evil.example" } }])("quarantines mismatched creation %j", async (change) => {
    const { repo, orders, order } = setup(); orders.createOrder.mockResolvedValue({ ...order, ...change });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(repo.ready).not.toHaveBeenCalled(); expect(repo.reconcile).toHaveBeenCalled();
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
    const { repo, orders } = setup();
    // Simulate an already-blocked mapping from a prior ambiguous attempt --
    // repo.claim's own mock returns false whenever `mapping` is already
    // set, exactly matching the real unique-insert semantics.
    await repo.claim({ intent_id: id, merchant_custom_reference: `book:${id}`, provider_order_id: null,
      checkout_url: null, webhook_token: "prior", creation_claim_id: "prior-claim", state: "needs_reconciliation" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
    // The already-blocked row's own reconciliation state is left exactly
    // as it was -- this path never touches it again.
    expect(repo.reconcile).not.toHaveBeenCalled();
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
    // here (proof incomplete), which the old code wrongly read as "safe,
    // still unpaid". A completed order must block regardless. Forces
    // capturedAmount to undefined explicitly, independent of the base
    // fixture's own (now required-to-be-0) default.
    orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: undefined });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled();
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
  });
  it("reproduces and blocks: unpaid order silently repriced was previously ALLOWED", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // Reviewer's third repro: still unpaid, but finalAmount changed from
    // 4.99 to 999. Same root cause as the currency case.
    orders.retrieveOrder.mockResolvedValue({ ...order, finalAmount: 999 });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it("allows reuse of an active, correctly bound, correctly priced, unexpired checkout with an explicit zero captured amount", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    expect(order.capturedAmount).toBe(0); // the fixture IS the explicit-zero case under test
    orders.retrieveOrder.mockResolvedValue(order);
    expect(await startPokCheckout(input, repo, orders, now)).toBe(url);
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
  });

  it("blocks reuse once the POK order has expired even though the Librum intent is still valid", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // Librum's own intent (expires_at 10:30) is still valid at `now` (10:00);
    // the POK order itself (capped at 30 min by startPokCheckout) already expired.
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "2026-09-15T09:59:59Z" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.ready).not.toHaveBeenCalled(); expect(repo.reconcile).not.toHaveBeenCalled();
  });
  it("blocks reuse on an unparseable expiry", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "not-a-date" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("blocks reuse when the order expires WHILE the retrieval request is in flight", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // The order is still unexpired at the moment startPokCheckout is
    // invoked (`now` = 10:00:00, expiresAt = 10:00:30) -- but the provider
    // round-trip itself takes long enough that, by the time it resolves,
    // the order has already crossed its expiry. Only a fresh post-retrieval
    // clock read catches this; the stale pre-call `now` would not.
    orders.retrieveOrder.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-09-15T10:01:00Z"));
      return { ...order, expiresAt: "2026-09-15T10:00:30Z" };
    });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it("blocks reuse of a canceled order", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isCanceled: true });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("blocks reuse of a refunded order", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isRefunded: true });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("blocks reuse of an already-paid order rather than offering checkout again", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId, capturedAmount: 4.99 });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled(); expect(repo.finalize).not.toHaveBeenCalled();
  });
  it.each([
    { label: "missing isCanceled", change: { isCanceled: undefined } },
    // Missing capture evidence blocks as ambiguous -- no documented
    // provider guarantee establishes that an absent capturedAmount means
    // "zero" on an order POK still calls open (see pok-checkout.ts).
    { label: "captured amount missing (undefined) on an unpaid order", change: { capturedAmount: undefined } },
    { label: "positive captured amount on an unpaid order", change: { capturedAmount: 4.99 } },
    { label: "transaction id present on an unpaid order", change: { transactionId: paymentId } },
    { label: "autoCapture missing", change: { autoCapture: undefined } },
    { label: "autoCapture false", change: { autoCapture: false } },
  ])("blocks reuse on missing/contradictory status field: $label", async ({ change }) => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, ...change });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("never resumes when the provider order is unreachable", async () => {
    const { repo, orders, ready } = setup(); ready();
    orders.retrieveOrder.mockRejectedValue(new Error("timeout"));
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow("RECONCILIATION");
    expect(orders.createOrder).not.toHaveBeenCalled();
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
    expect(results).toEqual([url, url]);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
  it("concurrent retries against an expired checkout never create a duplicate payable order", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "2026-09-15T09:59:59Z" });
    const results = await Promise.allSettled([startPokCheckout(input, repo, orders, now), startPokCheckout(input, repo, orders, now)]);
    expect(results.every(r => r.status === "rejected")).toBe(true);
    expect(orders.createOrder).not.toHaveBeenCalled();
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
  it.each([{ isCompleted: false }, { capturedAmount: undefined }, { isRefunded: true }])("pending/unproven %j creates no event or entitlement", async (change) => {
    const { repo, orders, order, ready } = setup(); ready(); orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId, ...change });
    expect((await fulfillPokCheckout(callback, repo, orders)).status).toBe("pending");
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
    expect(repo.ready).not.toHaveBeenCalled();
    expect(repo.reconcile).not.toHaveBeenCalled();
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(orders.retrieveOrder).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves the function's established creation behavior", async () => {
    vi.unstubAllEnvs();
    const { repo, orders } = setup();
    const url = await startPokCheckout(input, repo, orders, now);
    expect(typeof url).toBe("string");
    expect(orders.createOrder).toHaveBeenCalledOnce();
  });
});
