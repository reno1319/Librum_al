import { describe, expect, it, vi } from "vitest";
import { startPokCheckout, fulfillPokCheckout, POK_CHECKOUT_CANNOT_RESUME, type FrozenPokIntent, type PokMapping, type PokRepository } from "./pok-checkout";
import type { PokOrder } from "./pok";

const id = "11111111-1111-4111-8111-111111111111";
const merchantId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const paymentId = "44444444-4444-4444-8444-444444444444";
const now = Date.parse("2026-09-15T10:00:00Z");
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
  const order: PokOrder = { id: orderId, merchant: { id: merchantId }, merchantCustomReference: `book:${id}`, currencyCode: "ALL", originalCurrencyCode: "ALL",
    finalAmount: 4.99, capturedAmount: 4.99, autoCapture: true, isCompleted: false, isRefunded: false, isCanceled: false, transactionId: null, _self: { confirmUrl: url },
    expiresAt: "2026-09-15T10:30:00Z" };
  const orders = { createOrder: vi.fn(async () => order), retrieveOrder: vi.fn(async (): Promise<PokOrder> => ({ ...order, isCompleted: true, transactionId: paymentId })) };
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
  it("reuses a ready mapping without another payable order", async () => {
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
  it("keeps claim after failed diagnostic write", async () => {
    const { repo, orders } = setup(); orders.createOrder.mockRejectedValue(new Error("timeout")); repo.reconcile.mockRejectedValue(new Error("db"));
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow();
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(); expect(orders.createOrder).toHaveBeenCalledTimes(1);
  });
});
describe("POK checkout-link reuse safety", () => {
  it("blocks reuse once the POK order has expired even though the Librum intent is still valid", async () => {
    const { repo, orders, order, ready } = setup(); ready();
    // Librum's own intent (expires_at 10:30) is still valid at `now` (10:00);
    // the POK order itself (capped at 30 min by startPokCheckout) already expired.
    orders.retrieveOrder.mockResolvedValue({ ...order, expiresAt: "2026-09-15T09:59:59Z" });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled();
    expect(repo.ready).not.toHaveBeenCalled(); expect(repo.reconcile).not.toHaveBeenCalled();
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
    orders.retrieveOrder.mockResolvedValue({ ...order, isCompleted: true, transactionId: paymentId });
    await expect(startPokCheckout(input, repo, orders, now)).rejects.toThrow(POK_CHECKOUT_CANNOT_RESUME);
    expect(orders.createOrder).not.toHaveBeenCalled(); expect(repo.finalize).not.toHaveBeenCalled();
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
