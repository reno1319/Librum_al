import { z } from "zod";

// Contract: https://payments.doc.pokpay.io/ (checked 2026-09-15).
// No production endpoint or client-selectable base URL exists in this adapter.
const BASE_URL = "https://api-staging.pokpay.io";
const STAGING_REF = "erhzpapqwyfjotliqdjo";
export const uuid = z.uuid();
const amount = z.number().finite().nonnegative();
export const pokOrderSchema = z.object({
  id: uuid,
  merchantCustomReference: z.string().nullable(),
  currencyCode: z.string(),
  originalCurrencyCode: z.string().optional(),
  finalAmount: amount,
  capturedAmount: amount.optional(),
  autoCapture: z.boolean().optional(),
  isCompleted: z.boolean(),
  isRefunded: z.boolean(),
  isCanceled: z.boolean().optional(),
  transactionId: uuid.nullable(),
  merchant: z.object({ id: uuid }).optional(),
  _self: z.object({ confirmUrl: z.string() }).optional(),
  // Required field on the SdkOrder model per POK's published OpenAPI spec
  // (payments.doc.pokpay.io is unreachable from this network; verified
  // instead via the generated client at
  // github.com/pokpay-ltd/php-sdk/blob/main/docs/Model/SdkOrder.md, which
  // declares `expiresAt: \DateTime`). Kept as a bare string and parsed
  // defensively at each use site (Date.parse), the same way this codebase
  // already treats Librum's own `expires_at` timestamps -- never assume a
  // specific wire format beyond "parseable by Date.parse".
  expiresAt: z.string(),
});
export type PokOrder = z.infer<typeof pokOrderSchema>;
export type PokConfig = { merchantId: string; keyId: string; keySecret: string };

// Non-sensitive, stage-labeled diagnostics for the request/creation paths.
// Every thrown error in this adapter is already one of a small set of
// sentinel strings WE define (never a raw provider body, header, token, or
// credential) -- but even so, this deliberately does not log that sentinel
// message verbatim. It maps it through a closed, allowlisted vocabulary
// instead, so a future change to an error message (or an unexpected
// exception this adapter didn't anticipate) can never widen what gets
// logged: anything unrecognized becomes "unknown", never itself.
export type PokDiagnosticStage =
  | "login" | "create_order" | "retrieve_order" | "response_validation" | "checkout_url" | "ready_write";
export type PokDiagnosticCode =
  | "network_failure" | "http_error" | "invalid_envelope" | "invalid_response_shape"
  | "binding_mismatch" | "untrusted_checkout_url" | "ready_write_failed" | "invalid_amount" | "unknown";

// A Map, not a plain object: a plain-object lookup keyed by an arbitrary
// exception message (e.g. "constructor", "toString", "__proto__") reads
// through to Object.prototype's own inherited properties instead of
// `undefined`, defeating the "anything unrecognized becomes unknown"
// guarantee above. A Map has no prototype chain of string keys to leak.
const POK_SENTINEL_TO_CODE = new Map<string, PokDiagnosticCode>([
  ["POK_REQUEST_FAILED", "network_failure"],
  ["POK_INVALID_RESPONSE", "invalid_envelope"],
  ["POK_INVALID_ORDER_SHAPE", "invalid_response_shape"],
  ["POK_CREATED_ORDER_MISMATCH", "binding_mismatch"],
  ["POK_UNTRUSTED_CHECKOUT_URL", "untrusted_checkout_url"],
  ["POK_LINK_FAILED", "ready_write_failed"],
  ["POK_INVALID_AMOUNT", "invalid_amount"],
]);

// Logs exactly one structured line: a fixed stage, a fixed code, and (only
// for the one sentinel shape that carries one) a 3-digit HTTP status this
// adapter itself generated from `response.status`. Never the exception's
// own message/stack, never a Zod error dump, never response headers/body,
// never tokens or credentials, never a callback URL. Wrapped so that a
// failure in logging itself can never throw -- callers rely on this never
// disrupting their own reconciliation/error handling.
export function logPokDiagnostic(stage: PokDiagnosticStage, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : undefined;
    const httpMatch = typeof message === "string" ? /^POK_HTTP_(\d{3})$/.exec(message) : null;
    if (httpMatch) {
      console.error("pok_diagnostic", { stage, code: "http_error" satisfies PokDiagnosticCode, httpStatus: Number(httpMatch[1]) });
      return;
    }
    const code: PokDiagnosticCode = (message !== undefined ? POK_SENTINEL_TO_CODE.get(message) : undefined) ?? "unknown";
    console.error("pok_diagnostic", { stage, code });
  } catch {
    // Logging must never throw or otherwise disrupt the caller's own
    // reconciliation/error handling.
  }
}

export function assertPokStaging(env: Record<string, string | undefined> = process.env): void {
  if (env.POK_ENVIRONMENT !== "staging" || env.VERCEL_ENV !== "preview" ||
      env.VERCEL_GIT_COMMIT_REF !== "staging" ||
      env.NEXT_PUBLIC_SUPABASE_URL !== `https://${STAGING_REF}.supabase.co`) {
    throw new Error("POK_STAGING_ONLY");
  }
}

export function getPokConfig(): PokConfig {
  assertPokStaging();
  return z.object({ merchantId: uuid, keyId: z.string().min(1), keySecret: z.string().min(1) }).parse({
    merchantId: process.env.POK_MERCHANT_ID,
    keyId: process.env.POK_KEY_ID,
    keySecret: process.env.POK_KEY_SECRET,
  });
}

export function validatePokCheckoutUrl(raw: string, orderId?: string): string {
  const url = new URL(raw);
  // Staging-named hosts only: never redirect a sandbox customer to live POK.
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash ||
      !["pay-staging.pokpay.io", "isdk-web-staging.pokpay.io"].includes(url.hostname) ||
      (orderId !== undefined && url.pathname !== `/sdk-orders/${uuid.parse(orderId)}`)) {
    throw new Error("POK_UNTRUSTED_CHECKOUT_URL");
  }
  return url.href;
}

// POK uses major units, Librum stores hundredths. Reject precision loss,
// exponent notation, unsafe integers and fractional minor units.
export function pokAmountToMinor(value: number): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error("POK_INVALID_AMOUNT");
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("POK_INVALID_AMOUNT");
  return minor;
}

export type PokCreateOrder = {
  amount: number; currencyCode: "ALL"; autoCapture: true;
  shippingCost: 0; merchantCustomReference: string; description: string;
  webhookUrl: string; redirectUrl: string; failRedirectUrl: string;
  expiresAfterMinutes: number;
};

export function createPokClient(config: PokConfig, fetcher: typeof fetch = fetch) {
  async function request(path: string, body?: unknown, token?: string): Promise<unknown> {
    // Deliberately no retry of order creation: a timeout can hide a created order.
    let response: Response;
    try {
      response = await fetcher(`${BASE_URL}${path}`, {
        method: body === undefined ? "GET" : "POST", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error("POK_REQUEST_FAILED"); }
    if (!response.ok) throw new Error(`POK_HTTP_${response.status}`);
    const envelope = z.object({ statusCode: z.number().int().min(200).max(299), data: z.unknown() })
      .safeParse(await response.json());
    if (!envelope.success) throw new Error("POK_INVALID_RESPONSE");
    return envelope.data.data;
  }
  async function token() {
    try {
      const data = await request("/auth/sdk/login", { keyId: config.keyId, keySecret: config.keySecret });
      return z.object({ accessToken: z.string().min(1) }).parse(data).accessToken;
    } catch (err) {
      logPokDiagnostic("login", err);
      throw err;
    }
  }
  const path = `/merchants/${encodeURIComponent(config.merchantId)}/sdk-orders`;
  return {
    async createOrder(body: PokCreateOrder): Promise<PokOrder> {
      const accessToken = await token();
      try {
        const data = await request(path, body, accessToken);
        return z.object({ sdkOrder: pokOrderSchema }).parse(data).sdkOrder;
      } catch (err) {
        // A malformed/missing documented field (a Zod parse failure here)
        // is distinguished from a transport/HTTP failure inside request()
        // -- both are otherwise easy to conflate into "something failed".
        const isSchemaFailure = err instanceof Error && err.name === "ZodError";
        logPokDiagnostic("create_order", isSchemaFailure ? new Error("POK_INVALID_ORDER_SHAPE") : err);
        throw isSchemaFailure ? new Error("POK_INVALID_ORDER_SHAPE") : err;
      }
    },
    async retrieveOrder(id: string): Promise<PokOrder> {
      uuid.parse(id);
      const accessToken = await token();
      try {
        const data = await request(`${path}/${encodeURIComponent(id)}?loadTransaction=true`, undefined, accessToken);
        return z.object({ sdkOrder: pokOrderSchema }).parse(data).sdkOrder;
      } catch (err) {
        const isSchemaFailure = err instanceof Error && err.name === "ZodError";
        logPokDiagnostic("retrieve_order", isSchemaFailure ? new Error("POK_INVALID_ORDER_SHAPE") : err);
        throw isSchemaFailure ? new Error("POK_INVALID_ORDER_SHAPE") : err;
      }
    },
  };
}

export function verifiedPokPayment(order: PokOrder, binding: {
  orderId: string; reference: string; merchantId: string; expectedMinor: number; currency: string;
}) {
  if (order.id !== binding.orderId || order.merchantCustomReference !== binding.reference ||
      order.merchant?.id !== binding.merchantId) throw new Error("POK_ORDER_BINDING_MISMATCH");
  if (!order.isCompleted || order.isRefunded || order.isCanceled !== false || !order.transactionId ||
      order.autoCapture !== true || order.capturedAmount === undefined) return null;
  // Require actual captured amount, not the requested finalAmount alone.
  const actualMinor = pokAmountToMinor(order.capturedAmount);
  if (actualMinor !== binding.expectedMinor || pokAmountToMinor(order.finalAmount) !== actualMinor ||
      order.currencyCode !== binding.currency || order.originalCurrencyCode !== binding.currency) {
    throw new Error("POK_AMOUNT_CURRENCY_MISMATCH");
  }
  return { paymentId: order.transactionId, actualMinor, currency: order.currencyCode };
}
