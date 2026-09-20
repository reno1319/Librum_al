import { z } from "zod";
import { isProtectedStagingDeployment } from "@/lib/protected-staging";

// Contract: https://payments.doc.pokpay.io/ (checked 2026-09-15).
// No production endpoint or client-selectable base URL exists in this adapter.
const BASE_URL = "https://api-staging.pokpay.io";
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

// STALE-CHECKOUT-1: a SECOND, deliberately separate diagnostic channel
// for the small set of events that mean "a human has to look at this",
// as distinct from logPokDiagnostic's ordinary per-stage failures. It is
// separate rather than another stage value because these lines carry
// IDENTIFIERS -- which intent, which claim, which provider order -- and
// that is the whole point of them: an orphaned provider order is
// worthless in a log that cannot name it.
//
// What it may carry is therefore an explicit allowlist of three opaque
// identifiers plus a state string, and nothing else. It NEVER carries
// the checkout URL, the webhook token, any credential, or any provider
// response body. The webhook token in particular is the callback's only
// secret and must not reach any log: it is not a field of this type, so
// a caller cannot pass one without a type error.
export type PokCriticalCode =
  // POK created an order and the first attempt to record its id failed.
  // The reader was never handed a URL, so the order expires unpaid --
  // but it is unnameable to us unless this line exists.
  | "orphan_provider_order"
  // A callback verified real money on a mapping we had already retired.
  // Reaching this means the retirement classifier was wrong, and staging
  // must surface that loudly rather than silently doing the right thing.
  | "fulfilment_on_retired_mapping"
  // A recordProviderOrder attempt failed and is about to be retried.
  | "provider_order_persistence_retry";

export type PokCriticalDetail = {
  intentId: string;
  creationClaimId?: string;
  providerOrderId?: string;
  mappingState?: string;
  attempt?: number;
};

export function logPokCritical(code: PokCriticalCode, detail: PokCriticalDetail): void {
  try {
    // Rebuilt field by field rather than spread, so a caller passing an
    // object with extra properties (a wider object still satisfies the
    // type) can never widen what is actually written.
    console.error("pok_critical", {
      code,
      intentId: detail.intentId,
      creationClaimId: detail.creationClaimId,
      providerOrderId: detail.providerOrderId,
      mappingState: detail.mappingState,
      attempt: detail.attempt,
    });
  } catch {
    // Logging must never throw or disrupt the caller's own handling.
  }
}

// PAID-MODE-1: the three deployment-identity conditions this function
// has always required now come from the provider-neutral predicate
// (src/lib/protected-staging.ts), and POK_ENVIRONMENT -- the one
// genuinely POK-specific condition -- is supplied HERE, by the POK
// adapter that owns it. Composition only: the signature, the default
// argument, the POK_STAGING_ONLY sentinel and the accept/reject
// behaviour of every input are unchanged, which is why pok.test.ts
// passes with no edit at all.
//
// Note the case worth reading twice: for `{ POK_ENVIRONMENT:
// "production" }` the neutral predicate now PASSES and this function
// still throws, because the fourth condition is its own. Deployment
// identity and POK's own environment are two separate decisions now,
// and only this function requires both.
export function assertPokStaging(env: Record<string, string | undefined> = process.env): void {
  if (!isProtectedStagingDeployment(env) || env.POK_ENVIRONMENT !== "staging") {
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

// LOCAL-ONLY diagnostic addition (not part of any commit): narrowly
// sanitized detail for a POK_HTTP_400 rejection on create_order, captured
// right before the existing sentinel is thrown. Never touches the
// existing PokDiagnosticCode/logPokDiagnostic contract or any of its
// call sites -- this is a strictly additive second log line.
//
// CORRECTION (round 2, after a reported false positive): the first draft
// recursively scanned every key AND string leaf in the whole body against
// the allowlist. A fabricated `{"statusCode":400,"errors":[],"request":
// {"amount":4.99}}` -- our OWN echoed request, carrying no actual
// rejection at all -- was misclassified as "field_rejected"/"amount",
// because the scan couldn't distinguish an ECHOED request field from an
// ACTUAL reported error. Fixed by reading fields ONLY from the explicit,
// documented `errors` array shape -- never the rest of the body -- so an
// echoed request/data object can no longer be mistaken for a rejection.
//
// The field allowlist is createOrder's own outgoing request fields
// (PokCreateOrder's keys) PLUS "deeplink", a create-order field POK's own
// published 400 example names as rejectable even though this adapter
// never sends it -- a documented field can still be meaningfully
// "missing" even when we don't send it ourselves. No other field is
// added: this codebase has no further documented evidence of POK's
// create-order field set, and inventing more would defeat the point of
// an allowlist. (pok.test.ts asserts every PokCreateOrder key is present,
// since `satisfies` can't express "superset of a type's keys".)
const POK_CREATE_ORDER_FIELDS: ReadonlySet<string> = new Set<string>([
  "amount", "currencyCode", "autoCapture", "shippingCost", "merchantCustomReference",
  "description", "webhookUrl", "redirectUrl", "failRedirectUrl", "expiresAfterMinutes",
  "deeplink",
]);

// Closed vocabulary for POK's own documented validation-error `type`
// values -- only the two this codebase has direct published evidence for
// (POK's create-order 400 example: collection reference already used
// elsewhere in this file). Never a claim about any OTHER type string;
// anything else maps to "unknown" and its raw text is never logged.
export type PokValidationCategory = "missing_required" | "invalid_uri" | "unknown";
const POK_VALIDATION_TYPE_TO_CATEGORY = new Map<string, PokValidationCategory>([
  ["any.required", "missing_required"],
  ["string.uri", "invalid_uri"],
]);

// Overall shape of what was found in a 400 body:
//   - "errors_reported": the body had a non-empty `errors` array with at
//     least one entry carrying a string `key` (see below -- `type` is
//     not required for an entry to count here).
//   - "no_errors_reported": the body parsed to an object, but its
//     `errors` field was missing, not an array, empty, or contained no
//     entry with a string `key` -- includes the exact false-positive
//     repro `{"errors":[],"request":{"amount":4.99}}`.
//   - "unparseable": the body wasn't valid JSON, was too large to read
//     safely, or reading it failed outright.
export type PokRejectionOutcome = "errors_reported" | "no_errors_reported" | "unparseable";
export type PokRejectionEntry = { field: string; category: PokValidationCategory };
export type PokRejectionClassification = {
  outcome: PokRejectionOutcome;
  errors?: PokRejectionEntry[];
  statusCode?: number;
  serverStatusCode?: number;
};

// Small fixed cap on how many error entries are ever retained/logged --
// independent of how many the body actually claims to contain.
const MAX_REJECTION_ERROR_ENTRIES = 10;

// Bytes are bounded WHILE reading, before any full buffering or JSON
// parsing -- a response claiming (or actually sending) a huge body can
// never be fully pulled into memory here. Deliberately no separate
// timer: this reuses request()'s own already-attached AbortSignal
// deadline rather than inventing a second one.
const MAX_REJECTION_BODY_BYTES = 16 * 1024;

// Reads at most MAX_REJECTION_BODY_BYTES from the response body stream,
// bailing out (and returning null) the moment that cap would be
// exceeded, rather than buffering the whole thing first and measuring
// after. Returns null on any read failure, or when there is no readable
// body at all -- both are treated identically to "unparseable" by the
// caller, never surfaced as a distinct error.
async function readBoundedRejectionText(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REJECTION_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return null;
  } finally {
    try { reader.releaseLock(); } catch { /* already released or errored */ }
  }
}

function extractFiniteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
}

// Extracts field/type pairs ONLY from the explicit, documented `errors`
// array -- never from any other part of the body (an echoed `request`/
// `data` object, a top-level message, or any other key), which is
// exactly what a plain recursive scan got wrong before. Each retained
// entry's `field` is one of our own allowlisted names or "unknown"; its
// `category` is one of the two documented validation types or "unknown"
// -- an unrecognized key/type's raw text is never returned or logged.
// A string `key` is the one thing an entry needs to be retained at all;
// `type` is informative, not load-bearing -- absent, non-string, or
// unrecognized all fall back to "unknown" rather than discarding the
// entry (and its otherwise-identifiable field) entirely.
function classifyPokRejectionBody(
  rawText: string | null, fieldAllowlist: ReadonlySet<string>,
): PokRejectionClassification {
  if (rawText === null) return { outcome: "unparseable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { outcome: "unparseable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { outcome: "no_errors_reported" };
  }
  const body = parsed as Record<string, unknown>;
  const statusCode = extractFiniteInt(body.statusCode);
  const serverStatusCode = extractFiniteInt(body.serverStatusCode);
  const rawErrors = body.errors;
  if (!Array.isArray(rawErrors) || rawErrors.length === 0) {
    return { outcome: "no_errors_reported", statusCode, serverStatusCode };
  }

  const errors: PokRejectionEntry[] = [];
  for (const entry of rawErrors) {
    if (errors.length >= MAX_REJECTION_ERROR_ENTRIES) break;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { key, type } = entry as Record<string, unknown>;
    // No string key at all -- nothing identifiable to retain for this
    // entry (never fabricate a slot for it). A missing/non-string/
    // unrecognized `type`, by contrast, still retains the entry: it just
    // resolves to category "unknown" below.
    if (typeof key !== "string") continue;
    errors.push({
      field: fieldAllowlist.has(key) ? key : "unknown",
      category: typeof type === "string" ? POK_VALIDATION_TYPE_TO_CATEGORY.get(type) ?? "unknown" : "unknown",
    });
  }
  if (errors.length === 0) return { outcome: "no_errors_reported", statusCode, serverStatusCode };
  return { outcome: "errors_reported", errors, statusCode, serverStatusCode };
}

// Separate, distinctly-named event from "pok_diagnostic" so this
// narrower, LOCAL-ONLY addition is never confused with (and never
// changes the shape of) the existing, already-tested diagnostic
// contract. Wrapped so it can never throw or replace the caller's own
// POK_HTTP_400 throw. Never logs anything but the stage, the fixed
// httpStatus 400, the outcome, up to MAX_REJECTION_ERROR_ENTRIES
// {field, category} pairs (each already reduced to a known-safe name/
// category or "unknown"), and finite integer statusCode/serverStatusCode
// -- never the raw body, message, or any provider-supplied text.
function logPokRejectionDiagnostic(
  stage: PokDiagnosticStage, result: PokRejectionClassification,
): void {
  try {
    const payload: Record<string, unknown> = { stage, httpStatus: 400, outcome: result.outcome };
    if (result.statusCode !== undefined) payload.statusCode = result.statusCode;
    if (result.serverStatusCode !== undefined) payload.serverStatusCode = result.serverStatusCode;
    if (result.outcome === "errors_reported" && result.errors) payload.errors = result.errors;
    console.error("pok_rejection_diagnostic", payload);
  } catch {
    // Must never throw or otherwise disrupt the caller's own error
    // propagation/reconciliation.
  }
}

export function createPokClient(config: PokConfig, fetcher: typeof fetch = fetch) {
  async function request(
    path: string, body?: unknown, token?: string,
    // Both optional and only ever supplied by createOrder below -- every
    // other call site (login, retrieveOrder) is completely unaffected by
    // this addition: with no allowlist, the new block below never runs.
    stage?: PokDiagnosticStage, rejectionFieldAllowlist?: ReadonlySet<string>,
  ): Promise<unknown> {
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
    if (!response.ok) {
      if (response.status === 400 && stage !== undefined && rejectionFieldAllowlist !== undefined) {
        try {
          const rawText = await readBoundedRejectionText(response);
          logPokRejectionDiagnostic(stage, classifyPokRejectionBody(rawText, rejectionFieldAllowlist));
        } catch {
          // Reading/classifying the rejection body must never disrupt or
          // replace the existing POK_HTTP_400 throw immediately below.
        }
      }
      throw new Error(`POK_HTTP_${response.status}`);
    }
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
        const data = await request(path, body, accessToken, "create_order", POK_CREATE_ORDER_FIELDS);
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
