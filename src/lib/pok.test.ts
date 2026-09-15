import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPokStaging, createPokClient, getPokConfig, logPokDiagnostic, pokAmountToMinor, validatePokCheckoutUrl, verifiedPokPayment, type PokOrder } from "./pok";

const orderId = "11111111-1111-4111-8111-111111111111";
const merchantId = "22222222-2222-4222-8222-222222222222";
const paymentId = "33333333-3333-4333-8333-333333333333";
const binding = { orderId, merchantId, reference: "book:intent", expectedMinor: 499, currency: "ALL" };
const paid: PokOrder = { id: orderId, merchant: { id: merchantId }, merchantCustomReference: binding.reference,
  currencyCode: "ALL", originalCurrencyCode: "ALL", finalAmount: 4.99, capturedAmount: 4.99,
  autoCapture: true, isCompleted: true, isCanceled: false, isRefunded: false, transactionId: paymentId,
  expiresAt: "2026-09-15T11:00:00Z" };
const staging = { POK_ENVIRONMENT: "staging", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging",
  NEXT_PUBLIC_SUPABASE_URL: "https://erhzpapqwyfjotliqdjo.supabase.co" };
afterEach(() => vi.unstubAllEnvs());

describe("POK isolation and amounts", () => {
  it("accepts only the isolated staging configuration", () => expect(() => assertPokStaging(staging)).not.toThrow());
  it.each([{}, { POK_ENVIRONMENT: "production" }, { VERCEL_ENV: "production" },
    { VERCEL_GIT_COMMIT_REF: "feat/pok-payments" }, { NEXT_PUBLIC_SUPABASE_URL: "https://pwkukotgpsegieshulpj.supabase.co" }])
    ("fails closed for %j", (change) => expect(() => assertPokStaging(Object.keys(change).length ? { ...staging, ...change } : change)).toThrow());
  it("accepts a documented non-UUID key id", () => {
    for (const [key, value] of Object.entries(staging)) vi.stubEnv(key, value);
    vi.stubEnv("POK_MERCHANT_ID", merchantId); vi.stubEnv("POK_KEY_ID", "sdk-key-id"); vi.stubEnv("POK_KEY_SECRET", "test-only");
    expect(getPokConfig().keyId).toBe("sdk-key-id");
  });
  it.each([[4.99, 499], [1, 100], [0.01, 1], [1200, 120000], [1.1, 110]])("converts %s exactly", (major, minor) => expect(pokAmountToMinor(major)).toBe(minor));
  it.each([0, -1, 0.001, 1.001, NaN, Infinity, 1e21, Number.MAX_SAFE_INTEGER])("rejects unsafe amount %s", (n) => expect(() => pokAmountToMinor(n)).toThrow());
  it.each(["pay-staging.pokpay.io", "isdk-web-staging.pokpay.io"])("accepts documented sandbox host %s", (host) => expect(validatePokCheckoutUrl(`https://${host}/sdk-orders/${orderId}`)).toContain(host));
  it.each(["https://pay.pokpay.io/x", "https://attacker-staging.pokpay.io/x", "https://pay-staging.pokpay.io.evil.com/x",
    "http://pay-staging.pokpay.io/x", "https://user:password@pay-staging.pokpay.io/x", "https://pay-staging.pokpay.io:444/x"])
    ("rejects untrusted redirect %s", (url) => expect(() => validatePokCheckoutUrl(url)).toThrow());
});

describe("POK authenticated payment proof", () => {
  it("requires actual capture and exact binding", () => expect(verifiedPokPayment(paid, binding)).toEqual({ paymentId, actualMinor: 499, currency: "ALL" }));
  it.each([{ id: paymentId }, { merchantCustomReference: "other" }, { merchant: undefined }, { merchant: { id: paymentId } }])
    ("rejects foreign proof %j", (change) => expect(() => verifiedPokPayment({ ...paid, ...change }, binding)).toThrow("BINDING"));
  it.each([{ isCompleted: false }, { isCanceled: true }, { isCanceled: undefined }, { isRefunded: true },
    { transactionId: null }, { autoCapture: false }, { capturedAmount: undefined }])
    ("never fulfills an unproven payment %j", (change) => expect(verifiedPokPayment({ ...paid, ...change }, binding)).toBeNull());
  it.each([{ capturedAmount: 4.98 }, { finalAmount: 5 }, { currencyCode: "EUR" }, { originalCurrencyCode: "EUR" }, { originalCurrencyCode: undefined }])
    ("rejects amount/FX mismatch %j", (change) => expect(() => verifiedPokPayment({ ...paid, ...change }, binding)).toThrow());
});

describe("POK transport", () => {
  const config = { merchantId, keyId: "test-key", keySecret: "do-not-log-this" };
  const json = (data: unknown) => Response.json({ statusCode: 200, data });
  it("retrieves through authenticated staging API with no cache or redirect following", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" })).mockResolvedValueOnce(json({ sdkOrder: paid }));
    expect(await createPokClient(config, fetcher).retrieveOrder(orderId)).toEqual(paid);
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://api-staging.pokpay.io/auth/sdk/login", expect.objectContaining({ method: "POST", cache: "no-store", redirect: "error" }));
    expect(fetcher).toHaveBeenNthCalledWith(2, `https://api-staging.pokpay.io/merchants/${merchantId}/sdk-orders/${orderId}?loadTransaction=true`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer bearer" }), method: "GET" }));
  });
  it("does not retry ambiguous requests or expose response details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(config.keySecret));
    await expect(createPokClient(config, fetcher).retrieveOrder(orderId)).rejects.toThrow("POK_REQUEST_FAILED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([Response.json({ statusCode: 400, data: {} }), Response.json({ data: {} }), Response.json({}, { status: 500 })])
    ("rejects malformed/error envelopes", async (response) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(createPokClient(config, fetcher).retrieveOrder(orderId)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  it("rejects a malformed order", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" })).mockResolvedValueOnce(json({ sdkOrder: { ...paid, id: "bad" } }));
    await expect(createPokClient(config, fetcher).retrieveOrder(orderId)).rejects.toThrow();
  });

  // Shape retrieved from POK's own published order-creation example
  // (payments.doc.pokpay.io collection 17029398, checked 2026-09-15), with
  // its two template placeholders ({{sdkOrderId}}, {{confirmUrl}}) replaced
  // by offline-only stand-in values -- explicitly NOT real provider output,
  // and no network call of any kind was made to obtain or verify this.
  // Field-for-field as published: no `merchant`, `autoCapture`, `isCanceled`
  // or `capturedAmount` at all (all optional in our schema); `products`,
  // `originalAmount`, `appliedExchangeRate`, `createdAt`, `redirectUrl`,
  // `failRedirectUrl`, `selectedBranchId`, `description` are present in
  // the example but declared nowhere in our schema -- Zod's default
  // (non-strict) object parsing accepts and ignores them.
  const officialExampleOrder = {
    id: "44444444-4444-4444-8444-444444444444", // was "{{sdkOrderId}}"
    amount: 100, currencyCode: "ALL",
    products: [{ name: "testProduct", quantity: 1, price: 100 }],
    originalCurrencyCode: "ALL", originalAmount: 110, appliedExchangeRate: 1,
    shippingCost: 10, finalAmount: 110,
    createdAt: "2022-12-28T13:40:10.625Z", expiresAt: "2022-12-29T13:40:10.625Z",
    redirectUrl: null, failRedirectUrl: null,
    _self: { confirmUrl: "https://pay-staging.pokpay.io/sdk-orders/44444444-4444-4444-8444-444444444444", confirmDeeplink: "" }, // was "{{confirmUrl}}"
    description: "testSdk", isCompleted: false, isRefunded: false,
    merchantCustomReference: null, selectedBranchId: null, transactionId: null,
  };
  it("parses POK's own published order-creation example shape without any schema change", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(json({ sdkOrder: officialExampleOrder }));
    const order = await createPokClient(config, fetcher).retrieveOrder(officialExampleOrder.id);
    expect(order.id).toBe(officialExampleOrder.id);
    expect(order.merchant).toBeUndefined();
    expect(order.isCompleted).toBe(false);
  });
  it("classifies a documented-but-missing field as invalid_response_shape, not a generic failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-sibling destructure to drop one field
    const { isCompleted, ...missingIsCompleted } = officialExampleOrder;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(json({ sdkOrder: missingIsCompleted }));
    const createBody = { amount: 1, currencyCode: "ALL", autoCapture: true, shippingCost: 0,
      merchantCustomReference: "book:test", description: "test", webhookUrl: "https://librum.example/webhook",
      redirectUrl: "https://librum.example/return", failRedirectUrl: "https://librum.example/canceled",
      expiresAfterMinutes: 30 } as const;
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_INVALID_ORDER_SHAPE");
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "create_order", code: "invalid_response_shape" });
    consoleError.mockRestore();
  });
});

describe("logPokDiagnostic", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => consoleError.mockRestore());

  it.each([
    { message: "POK_REQUEST_FAILED", expected: { code: "network_failure" } },
    { message: "POK_INVALID_RESPONSE", expected: { code: "invalid_envelope" } },
    { message: "POK_INVALID_ORDER_SHAPE", expected: { code: "invalid_response_shape" } },
    { message: "POK_CREATED_ORDER_MISMATCH", expected: { code: "binding_mismatch" } },
    { message: "POK_UNTRUSTED_CHECKOUT_URL", expected: { code: "untrusted_checkout_url" } },
    { message: "POK_LINK_FAILED", expected: { code: "ready_write_failed" } },
    { message: "POK_INVALID_AMOUNT", expected: { code: "invalid_amount" } },
  ])("maps $message to an allowlisted code", ({ message, expected }) => {
    logPokDiagnostic("create_order", new Error(message));
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "create_order", ...expected });
  });

  // Regression: the sentinel-to-code lookup used to be a plain object
  // literal, so an exception message that happens to name one of
  // Object.prototype's OWN inherited properties (constructor, toString,
  // hasOwnProperty, __proto__) resolved through the prototype chain to
  // that property's real value -- a function, not `undefined` -- instead
  // of falling through to "unknown". A Map has no such prototype chain of
  // string keys to leak through. Same guarantee must hold for the empty
  // string, which is falsy but still a valid (if unrecognized) message.
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", ""])(
    "never resolves the inherited-property-shaped or empty message %j to anything but the allowlisted 'unknown' code",
    (message) => {
      logPokDiagnostic("login", new Error(message));
      expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "login", code: "unknown" });
    },
  );

  it("extracts only the 3-digit HTTP status from POK_HTTP_xxx, nothing else", () => {
    logPokDiagnostic("retrieve_order", new Error("POK_HTTP_503"));
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "retrieve_order", code: "http_error", httpStatus: 503 });
  });

  it("falls back to 'unknown' for any unrecognized error, never logging its own text", () => {
    logPokDiagnostic("login", new Error("some future error this code has never seen before"));
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "login", code: "unknown" });
  });

  it("never leaks a secret-shaped exception message into the log", () => {
    logPokDiagnostic("login", new Error("keySecret=sk_live_do_not_log_this_1234567890"));
    const loggedPayload = JSON.stringify(consoleError.mock.calls);
    expect(loggedPayload).not.toContain("sk_live_do_not_log_this_1234567890");
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "login", code: "unknown" });
  });

  it("never throws even if console.error itself throws", () => {
    consoleError.mockImplementation(() => { throw new Error("logging transport down"); });
    expect(() => logPokDiagnostic("ready_write", new Error("POK_LINK_FAILED"))).not.toThrow();
  });

  it("never throws for a non-Error thrown value", () => {
    expect(() => logPokDiagnostic("checkout_url", "a plain string, not an Error")).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "checkout_url", code: "unknown" });
  });
});
