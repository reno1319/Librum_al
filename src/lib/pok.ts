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
    const data = await request("/auth/sdk/login", { keyId: config.keyId, keySecret: config.keySecret });
    return z.object({ accessToken: z.string().min(1) }).parse(data).accessToken;
  }
  const path = `/merchants/${encodeURIComponent(config.merchantId)}/sdk-orders`;
  return {
    async createOrder(body: PokCreateOrder): Promise<PokOrder> {
      const data = await request(path, body, await token());
      return z.object({ sdkOrder: pokOrderSchema }).parse(data).sdkOrder;
    },
    async retrieveOrder(id: string): Promise<PokOrder> {
      uuid.parse(id);
      const data = await request(`${path}/${encodeURIComponent(id)}?loadTransaction=true`, undefined, await token());
      return z.object({ sdkOrder: pokOrderSchema }).parse(data).sdkOrder;
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
