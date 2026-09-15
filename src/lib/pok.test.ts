import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPokStaging, createPokClient, getPokConfig, pokAmountToMinor, validatePokCheckoutUrl, verifiedPokPayment, type PokOrder } from "./pok";

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
});
