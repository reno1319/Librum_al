import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPokStaging, createPokClient, getPokConfig, logPokCritical, logPokDiagnostic, pokAmountToMinor,
  pokFulfilmentBlockedCode, pokFulfilmentGapCode, POK_FULFILMENT_BLOCKED_CODE_PREFIX, POK_FULFILMENT_GAP_CODE_PREFIX,
  validatePokCheckoutUrl, verifiedPokPayment, type PokOrder } from "./pok";

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
  it("requires actual capture and exact binding", () => expect(verifiedPokPayment(paid, binding)).toEqual({ verified: true, paymentId, actualMinor: 499, currency: "ALL" }));
  it.each([{ id: paymentId }, { merchantCustomReference: "other" }, { merchant: undefined }, { merchant: { id: paymentId } }])
    ("rejects foreign proof %j", (change) => expect(() => verifiedPokPayment({ ...paid, ...change }, binding)).toThrow("BINDING"));

  // POK-FULFILMENT-1: the SAME shapes are still rejected. What changed is
  // that each rejection now says which KIND it is, because the two kinds
  // deserve different HTTP answers -- a field that may arrive on the next
  // retrieval is worth asking about again; a contradiction never is.
  //
  // These two tables together are the whole set that used to return null
  // or throw. Nothing has moved from either of them into the accept path.
  it.each([
    { change: { isCanceled: undefined }, gap: "cancellation_state_absent" },
    { change: { transactionId: null }, gap: "transaction_id_absent" },
    { change: { autoCapture: undefined }, gap: "auto_capture_absent" },
    { change: { capturedAmount: undefined }, gap: "captured_amount_absent" },
  ] as const)("reports a transient GAP, never entitlement, for $gap", ({ change, gap }) => {
    expect(verifiedPokPayment({ ...paid, ...change }, binding)).toEqual({ verified: false, kind: "gap", gap });
  });
  it.each([
    { change: { isCompleted: false }, cause: "not_completed" },
    { change: { isRefunded: true }, cause: "refunded" },
    { change: { isCanceled: true }, cause: "cancellation_reported" },
    { change: { autoCapture: false }, cause: "auto_capture_disabled" },
    // capturedAmount 0 on a COMPLETED order: pokAmountToMinor rejects a
    // non-positive amount, which used to THROW POK_INVALID_AMOUNT and
    // become an unbounded 503. A completed order that captured nothing is
    // a contradiction, not a pending payment.
    { change: { capturedAmount: 0 }, cause: "captured_amount_unconvertible" },
    { change: { capturedAmount: 4.98 }, cause: "captured_amount_mismatch" },
    { change: { finalAmount: 0 }, cause: "final_amount_unconvertible" },
    // capturedAmount still matches the frozen price; it is finalAmount
    // that disagrees with it, which is a different fact and a different
    // cause.
    { change: { finalAmount: 5 }, cause: "final_amount_mismatch" },
    { change: { currencyCode: "EUR" }, cause: "currency_mismatch" },
    { change: { originalCurrencyCode: "EUR" }, cause: "original_currency_mismatch" },
    { change: { originalCurrencyCode: undefined }, cause: "original_currency_mismatch" },
  ] as const)("reports a TERMINAL block, never entitlement, for $cause", ({ change, cause }) => {
    expect(verifiedPokPayment({ ...paid, ...change }, binding)).toEqual({ verified: false, kind: "blocked", cause });
  });

  // The acceptance conjunction, asserted as a PROPERTY rather than as a
  // list: for each of the eight facts the accept path depends on,
  // substituting any value other than the one it requires must leave
  // `verified` false. This is what "the bar does not move by one field"
  // means operationally -- a future edit that relaxes any single
  // condition fails here even if it invents a new verdict shape.
  const unsafe: Record<string, unknown[]> = {
    isCompleted: [false, undefined],
    // NOT undefined. isRefunded is a REQUIRED boolean in pokOrderSchema,
    // and this conjunction reads it exactly as it always has -- an absent
    // value is falsy and passes. That is deliberately unchanged: the
    // acceptance bar does not move by one field in either direction. The
    // shape is refused before it ever reaches here, by
    // classifyProviderAttempt's rule 4 (`isRefunded !== false` ->
    // BLOCKED_RECONCILE), which pok-checkout.test.ts asserts directly.
    isRefunded: [true],
    isCanceled: [true, undefined],
    transactionId: [null, ""],
    autoCapture: [false, undefined],
    capturedAmount: [undefined, 0, 4.98, 5, -1],
    finalAmount: [0, 5, 4.98],
    currencyCode: ["EUR", "USD", ""],
    originalCurrencyCode: ["EUR", "USD", undefined],
  };
  it("accepts nothing but the exact eight-fact conjunction", () => {
    for (const [field, values] of Object.entries(unsafe)) {
      for (const value of values) {
        const verdict = verifiedPokPayment({ ...paid, [field]: value } as PokOrder, binding);
        expect({ field, value, verified: verdict.verified }).toEqual({ field, value, verified: false });
      }
    }
    // ...and the untouched fixture still verifies, so the loop above is
    // not passing because everything is rejected.
    expect(verifiedPokPayment(paid, binding).verified).toBe(true);
  });

  // No GAP path may throw. A throw out of this function becomes a 503 in
  // the webhook route, and a 503 for a transient gap is precisely the
  // unbounded retry this repair exists to bound. Asserted against the
  // REAL function, never through a mock.
  it("never throws on any gap or block path", () => {
    for (const [field, values] of Object.entries(unsafe)) {
      for (const value of values) {
        expect(() => verifiedPokPayment({ ...paid, [field]: value } as PokOrder, binding)).not.toThrow();
      }
    }
  });

  // The two prefixes must stay disjoint: the database trigger keys the
  // retry marker on the literal `fulfilment_gap_` prefix, so a terminal
  // code that happened to match it would start a retry clock for a state
  // no retry resolves.
  it("keeps the gap and blocked code vocabularies disjoint", () => {
    const gaps = ["transaction_id_absent", "captured_amount_absent", "auto_capture_absent", "cancellation_state_absent"] as const;
    const blocked = ["order_binding_mismatch", "final_amount_unconvertible", "final_amount_mismatch",
      "currency_mismatch", "original_currency_mismatch", "completed_and_reversed", "refunded",
      "cancellation_contradicted", "payment_evidence_on_open_order", "auto_capture_disabled",
      "not_completed", "cancellation_reported", "captured_amount_unconvertible",
      "captured_amount_mismatch", "active_other_session", "book_or_reader_deleted",
      "disputed_lost", "finalization_without_entitlement"] as const;
    for (const gap of gaps) expect(pokFulfilmentGapCode(gap).startsWith(POK_FULFILMENT_GAP_CODE_PREFIX)).toBe(true);
    for (const cause of blocked) {
      expect(pokFulfilmentBlockedCode(cause).startsWith(POK_FULFILMENT_BLOCKED_CODE_PREFIX)).toBe(true);
      expect(pokFulfilmentBlockedCode(cause).startsWith(POK_FULFILMENT_GAP_CODE_PREFIX)).toBe(false);
    }
    // 'creation_unconfirmed' is the only last_error_code every release
    // before this one writes. A database carrying the migration while the
    // old application is still deployed must never stamp the marker.
    expect("creation_unconfirmed".startsWith(POK_FULFILMENT_GAP_CODE_PREFIX)).toBe(false);
  });
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

// LOCAL-ONLY: covers the not-yet-committed create_order 400-rejection
// diagnostic addition in pok.ts (POK_CREATE_ORDER_FIELDS,
// POK_VALIDATION_TYPE_TO_CATEGORY, readBoundedRejectionText,
// classifyPokRejectionBody, logPokRejectionDiagnostic). Every fetch
// response here is fabricated; no network call of any kind is made.
describe("POK create_order 400 rejection diagnostics (local-only)", () => {
  const config = { merchantId, keyId: "test-key", keySecret: "do-not-log-this" };
  const json = (data: unknown) => Response.json({ statusCode: 200, data });
  const createBody = { amount: 1, currencyCode: "ALL", autoCapture: true, shippingCost: 0,
    merchantCustomReference: "book:test", description: "test", webhookUrl: "https://librum.example/webhook",
    redirectUrl: "https://librum.example/return", failRedirectUrl: "https://librum.example/canceled",
    expiresAfterMinutes: 30 } as const;
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => consoleError.mockRestore());

  function loggedText(): string {
    return JSON.stringify(consoleError.mock.calls);
  }

  // Every field this adapter actually sends must be recognizable -- a
  // compile-time `satisfies` can't express "allowlist is a superset of
  // PokCreateOrder's keys", so this is the runtime equivalent.
  it("field allowlist covers every PokCreateOrder key it sends, plus the documented-but-unsent 'deeplink'", async () => {
    for (const field of Object.keys(createBody)) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
        .mockResolvedValueOnce(Response.json({ errors: [{ key: field, type: "any.required" }] }, { status: 400 }));
      await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
      expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
        { stage: "create_order", httpStatus: 400, outcome: "errors_reported", errors: [{ field, category: "missing_required" }] });
    }
  });

  // The exact false positive ChatGPT reproduced: our OWN echoed request
  // (which happens to contain "amount") sitting alongside an EMPTY
  // errors array must never be read as a rejection of "amount".
  it("never misreads an echoed request/data object as a rejected field (the reported false positive)", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({ statusCode: 400, errors: [], request: { amount: 4.99 } }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
      { stage: "create_order", httpStatus: 400, outcome: "no_errors_reported", statusCode: 400 });
  });

  // POK's own published create-order 400 example (collection reference
  // already used elsewhere in this file): four errors, including
  // "deeplink" -- a field this adapter never sends but which is still
  // documented and therefore allowlisted. This is a PUBLISHED EXAMPLE,
  // not evidence of either actual incident's rejection reason.
  it("parses POK's own published multi-error 400 example without inventing or dropping entries", async () => {
    const publishedExample = {
      statusCode: 400, serverStatusCode: 400,
      errors: [
        { key: "autoCapture", type: "any.required" },
        { key: "webhookUrl", type: "string.uri" },
        { key: "redirectUrl", type: "string.uri" },
        { key: "deeplink", type: "string.uri" },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json(publishedExample, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic", {
      stage: "create_order", httpStatus: 400, outcome: "errors_reported", statusCode: 400, serverStatusCode: 400,
      errors: [
        { field: "autoCapture", category: "missing_required" },
        { field: "webhookUrl", category: "invalid_uri" },
        { field: "redirectUrl", category: "invalid_uri" },
        { field: "deeplink", category: "invalid_uri" },
      ],
    });
  });

  it("reduces an unrecognized field name AND an unrecognized type to 'unknown', never logging either's raw text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({ errors: [{ key: "totallyUnknownProviderField", type: "some.newType" }] }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
      { stage: "create_order", httpStatus: 400, outcome: "errors_reported", errors: [{ field: "unknown", category: "unknown" }] });
    expect(loggedText()).not.toContain("totallyUnknownProviderField");
    expect(loggedText()).not.toContain("some.newType");
  });

  it("reports a documented field as missing when POK's errors array names it even though our own request omits it", async () => {
    // "deeplink" is never part of createBody at all -- still recognized.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({ errors: [{ key: "deeplink", type: "any.required" }] }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
      { stage: "create_order", httpStatus: 400, outcome: "errors_reported", errors: [{ field: "deeplink", category: "missing_required" }] });
  });

  it("classifies a missing/non-array/empty errors field, or an entry with no string key, as no_errors_reported", async () => {
    // { key: "amount" } (no type at all) is deliberately NOT in this
    // list -- a string key alone is enough to retain an entry now (see
    // the dedicated missing/null/numeric-type tests below); only an
    // entry with NO string key at all falls through to here.
    for (const body of [{}, { errors: "not-an-array" }, { errors: [] }, { errors: [{}] }, { errors: [{ type: "any.required" }] }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
        .mockResolvedValueOnce(Response.json(body, { status: 400 }));
      await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
      expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
        expect.objectContaining({ stage: "create_order", httpStatus: 400, outcome: "no_errors_reported" }));
    }
  });

  it.each([
    { label: "absent type", entry: { key: "amount" } },
    { label: "null type", entry: { key: "amount", type: null } },
    { label: "numeric type", entry: { key: "amount", type: 123 } },
  ])("retains an entry with a string key and $label, mapping category to unknown rather than discarding it", async ({ entry }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({ errors: [entry] }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
      { stage: "create_order", httpStatus: 400, outcome: "errors_reported", errors: [{ field: "amount", category: "unknown" }] });
  });

  it("still resolves field to 'unknown' for an unrecognized key even when type is also absent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({ errors: [{ key: "totallyUnknownProviderField" }] }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
      { stage: "create_order", httpStatus: 400, outcome: "errors_reported", errors: [{ field: "unknown", category: "unknown" }] });
  });

  it("never logs a raw message or value accompanying an entry that has a key but no usable type", async () => {
    const leakySentence = "webhookUrl must be a valid https URL, got ftp://leak.example/token=SECRET123";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({ errors: [{ key: "webhookUrl", message: leakySentence }] }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
      { stage: "create_order", httpStatus: 400, outcome: "errors_reported", errors: [{ field: "webhookUrl", category: "unknown" }] });
    expect(loggedText()).not.toContain("leak.example");
    expect(loggedText()).not.toContain("SECRET123");
    expect(loggedText()).not.toContain(leakySentence);
  });

  it("classifies a non-JSON body as unparseable, without throwing anything other than the existing POK_HTTP_400", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(new Response("not json at all {{{", { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic", { stage: "create_order", httpStatus: 400, outcome: "unparseable" });
  });

  it("bounds retained error entries to a small fixed limit even when the body claims many more", async () => {
    const manyErrors = Array.from({ length: 50 }, () => ({ key: "amount", type: "any.required" }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({ errors: manyErrors }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    const call = consoleError.mock.calls.find((c: unknown[]) => c[0] === "pok_rejection_diagnostic");
    const logged = call?.[1] as { errors?: unknown[] } | undefined;
    expect(logged?.errors?.length).toBeLessThanOrEqual(10);
    expect(logged?.errors?.length).toBeGreaterThan(0);
  });

  it("never logs a secret or a callback token embedded anywhere in the rejection body, even while still identifying a rejected field", async () => {
    const secret = "sk_live_DO_NOT_LOG_1234567890";
    const callbackToken = "SECRET_CALLBACK_TOKEN_9999";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({
        message: `keySecret=${secret} rejected`,
        errors: [{ key: "webhookUrl", type: "string.uri", value: `https://reader.example/cb?token=${callbackToken}` }],
      }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic",
      { stage: "create_order", httpStatus: 400, outcome: "errors_reported", errors: [{ field: "webhookUrl", category: "invalid_uri" }] });
    const logged = loggedText();
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(callbackToken);
    expect(logged).not.toContain("reader.example");
  });

  it("bounds body bytes while reading -- an oversized body is treated as unparseable, never fully buffered or parsed", async () => {
    const oversized = JSON.stringify({ errors: [{ key: "amount", type: "any.required" }], padding: "x".repeat(20_000) });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(new Response(oversized, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic", { stage: "create_order", httpStatus: 400, outcome: "unparseable" });
  });

  it("still throws only POK_HTTP_400 and logs 'unparseable' (never the raw error) if reading the rejection body stream itself fails", async () => {
    const brokenBody = new ReadableStream({ start(controller) { controller.error(new Error("stream error, must never be logged")); } });
    const brokenResponse = new Response(brokenBody, { status: 400 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" })).mockResolvedValueOnce(brokenResponse);
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).toHaveBeenCalledWith("pok_rejection_diagnostic", { stage: "create_order", httpStatus: 400, outcome: "unparseable" });
    expect(loggedText()).not.toContain("stream error");
    // The pre-existing diagnostic for this same failure still fires, unchanged.
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "create_order", code: "http_error", httpStatus: 400 });
  });

  it("never adds a rejection-diagnostic line for login's own 400 -- only createOrder passes the allowlist", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ errors: [{ key: "keySecret", type: "any.required" }] }, { status: 400 }));
    await expect(createPokClient(config, fetcher).createOrder(createBody)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).not.toHaveBeenCalledWith("pok_rejection_diagnostic", expect.anything());
    expect(consoleError).toHaveBeenCalledWith("pok_diagnostic", { stage: "login", code: "http_error", httpStatus: 400 });
  });

  it("never adds a rejection-diagnostic line for retrieveOrder's own 400 either", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: "bearer" }))
      .mockResolvedValueOnce(Response.json({ errors: [{ key: "amount", type: "any.required" }] }, { status: 400 }));
    await expect(createPokClient(config, fetcher).retrieveOrder(orderId)).rejects.toThrow("POK_HTTP_400");
    expect(consoleError).not.toHaveBeenCalledWith("pok_rejection_diagnostic", expect.anything());
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

// STALE-CHECKOUT-1: logPokCritical is a SEPARATE channel from
// logPokDiagnostic. Diagnostics map an exception through a closed
// vocabulary; this one carries identifiers a human needs in order to go
// find an order at POK. That makes what it may NOT carry the whole point
// of these tests: no checkout URL, no webhook token, no credentials.
describe("logPokCritical", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => consoleError.mockRestore());

  it.each([
    "orphan_provider_order", "fulfilment_on_retired_mapping", "provider_order_persistence_retry",
  ] as const)("logs %s under the pok_critical channel with its identifiers", (code) => {
    logPokCritical(code, {
      intentId: "11111111-1111-4111-8111-111111111111",
      creationClaimId: "22222222-2222-4222-8222-222222222222",
      providerOrderId: "33333333-3333-4333-8333-333333333333",
      mappingState: "retired", attempt: 2,
    });
    expect(consoleError).toHaveBeenCalledWith("pok_critical", {
      code,
      intentId: "11111111-1111-4111-8111-111111111111",
      creationClaimId: "22222222-2222-4222-8222-222222222222",
      providerOrderId: "33333333-3333-4333-8333-333333333333",
      mappingState: "retired", attempt: 2,
    });
  });

  // The detail object is rebuilt field by field rather than spread, so a
  // caller passing a WIDER object (one that happens to carry a token, a
  // URL or a secret alongside the identifiers) cannot widen the log.
  // This is the regression that guarantee exists for.
  it("never logs a field outside its own closed shape, however wide the caller's object is", () => {
    const widened = {
      intentId: "11111111-1111-4111-8111-111111111111",
      webhookToken: "tok_do_not_log_this",
      checkoutUrl: "https://pay-staging.pokpay.io/sdk-orders/33333333-3333-4333-8333-333333333333",
      keySecret: "sk_live_do_not_log_this_1234567890",
    };
    logPokCritical("orphan_provider_order", widened);
    const loggedPayload = JSON.stringify(consoleError.mock.calls);
    expect(loggedPayload).not.toContain("tok_do_not_log_this");
    expect(loggedPayload).not.toContain("sk_live_do_not_log_this_1234567890");
    expect(loggedPayload).not.toContain("pay-staging.pokpay.io");
    expect(loggedPayload).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("omits nothing and invents nothing when only the intent id is known", () => {
    logPokCritical("orphan_provider_order", { intentId: "11111111-1111-4111-8111-111111111111" });
    expect(consoleError).toHaveBeenCalledWith("pok_critical", {
      code: "orphan_provider_order", intentId: "11111111-1111-4111-8111-111111111111",
      creationClaimId: undefined, providerOrderId: undefined, mappingState: undefined, attempt: undefined,
    });
  });

  it("never throws even if console.error itself throws", () => {
    consoleError.mockImplementation(() => { throw new Error("logging transport down"); });
    expect(() => logPokCritical("orphan_provider_order", { intentId: "x" })).not.toThrow();
  });
});
