import { describe, expect, it, vi } from "vitest";
import {
  buildRefundIdempotencyKey,
  buildRetryIdempotencyKey,
  determineRefundAttempt,
  executeApprovedRefund,
  STRIPE_REFUND_ERROR_MESSAGE,
  REFUND_ATTEMPT_INIT_ERROR_MESSAGE,
} from "./issue-refund";

// ---------------------------------------------------------------------
// A minimal, read-only fake of the Supabase query builder -- just enough
// of the fluent chain (.from().select().eq().maybeSingle()) to serve
// executeApprovedRefund()'s single read, plus a `.rpc()` mock for the
// ADMIN-1C Part B begin/complete/fail issuance-attempt RPC calls.
// Deliberately has no .update()/.upsert() method at all: several tests
// below rely on this to prove "no direct table write is attempted" the
// same way a TypeScript compile error would -- there is nothing to call.
//
// ADMIN-1C Part B PRE-FINALIZE CORRECTION: `.rpc()`'s default behavior is
// now NAME-AWARE, not a single blanket resolved value -- a genuinely
// "ready" attempt now calls begin_refund_issuance_attempt() BEFORE
// Stripe, and the returned attempt id must be truthy for
// executeApprovedRefund to ever proceed to the Stripe call at all.
// Defaults to a fixed DEFAULT_ATTEMPT_ID for begin, and a bare
// `{data: null, error: null}` success for complete/fail -- individual
// tests override rpcImpl (also name-aware) to simulate a specific RPC
// call failing.
// ---------------------------------------------------------------------
type Row = Record<string, unknown> | null;
type RpcResult = { data: unknown; error: { message: string } | null };
type RpcImpl = (name: string, params: Record<string, unknown>) => Promise<RpcResult>;

const DEFAULT_ATTEMPT_ID = "attempt-1";

function defaultRpcImpl(name: string): Promise<RpcResult> {
  if (name === "begin_refund_issuance_attempt") {
    return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
  }
  return Promise.resolve({ data: null, error: null });
}

function makeFakeSupabase(row: Row, rpcImpl: RpcImpl = defaultRpcImpl) {
  const rpc = vi.fn((name: string, params: Record<string, unknown>) => rpcImpl(name, params));
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      }),
    }),
    rpc,
  };
}

// `existingRefunds` seeds what determineRefundAttempt's pre-flight
// list() call sees -- defaults to none (a genuine first attempt), the
// common case for most tests below. `createImpl` overrides what
// refunds.create() itself resolves/rejects with (defaults to an
// immediate 'succeeded' result, since a bare `{id}` with no status was
// never a realistic Stripe response and ADMIN-1C's audit write now
// actually reads `.status`); `listError`, when set, makes the pre-flight
// list() call itself reject (simulating a Stripe read failure).
function makeFakeStripe(params: {
  existingRefunds?: Partial<{ id: string; status: string; created: number }>[];
  createImpl?: () => Promise<unknown>;
  listError?: Error;
} = {}) {
  const refunds = params.existingRefunds ?? [];
  return {
    refunds: {
      list: vi.fn(() => ({
        autoPagingToArray: () => {
          if (params.listError) return Promise.reject(params.listError);
          return Promise.resolve(refunds);
        },
      })),
      create: vi.fn(params.createImpl ?? (() => Promise.resolve({ id: "re_test_1", status: "succeeded" }))),
    },
  };
}

const REQUEST_ID = "refund-request-1";
const PAYMENT_INTENT_ID = "pi_test_123";

describe("buildRefundIdempotencyKey", () => {
  it("is deterministic for the same refund request id", () => {
    expect(buildRefundIdempotencyKey(REQUEST_ID)).toBe(buildRefundIdempotencyKey(REQUEST_ID));
  });

  it("is scoped to the exact refund request id", () => {
    expect(buildRefundIdempotencyKey(REQUEST_ID)).toBe(`refund-request-${REQUEST_ID}`);
    expect(buildRefundIdempotencyKey(REQUEST_ID)).not.toBe(buildRefundIdempotencyKey("other-id"));
  });
});

describe("buildRetryIdempotencyKey", () => {
  it("chains off the base key and the specific failed refund's id", () => {
    expect(buildRetryIdempotencyKey(REQUEST_ID, "re_failed_1")).toBe(
      `refund-request-${REQUEST_ID}-after-re_failed_1`,
    );
  });

  it("produces distinct keys for distinct failed refund ids (a repeated-failure chain)", () => {
    const afterR1 = buildRetryIdempotencyKey(REQUEST_ID, "re_r1");
    const afterR2 = buildRetryIdempotencyKey(REQUEST_ID, "re_r2");
    expect(afterR1).not.toBe(afterR2);
  });

  it("is deterministic: two independent calls for the same failed refund id agree", () => {
    expect(buildRetryIdempotencyKey(REQUEST_ID, "re_r1")).toBe(
      buildRetryIdempotencyKey(REQUEST_ID, "re_r1"),
    );
  });
});

describe("determineRefundAttempt", () => {
  it("I: returns the base key when no refund exists yet for this PaymentIntent", async () => {
    const stripe = makeFakeStripe({ existingRefunds: [] });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "ready", idempotencyKey: buildRefundIdempotencyKey(REQUEST_ID) });
    expect(stripe.refunds.list).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: PAYMENT_INTENT_ID, limit: 100 }),
    );
  });

  it.each(["pending", "requires_action"])(
    "blocks on a lone refund that is '%s'",
    async (status) => {
      const stripe = makeFakeStripe({
        existingRefunds: [{ id: "re_1", status, created: 100 }],
      });

      const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

      expect(plan).toEqual({ kind: "blocked" });
    },
  );

  it("blocks on a lone refund that already succeeded", async () => {
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_1", status: "succeeded", created: 100 }],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "blocked" });
  });

  it("blocks on a succeeded refund even if it's only partial -- Librum never auto-layers a second Stripe operation on an atypical refund history", async () => {
    // This refund object carries no `amount` at all in this fixture --
    // determineRefundAttempt deliberately never inspects amount, exactly
    // because distinguishing "full" from "partial" here would require an
    // extra Charge lookup this function intentionally doesn't make. ANY
    // succeeded refund blocks, full or partial alike -- see the
    // function's own documentation for why this is the correct,
    // policy-consistent behavior rather than an oversight.
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_partial", status: "succeeded", created: 100 }],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "blocked" });
  });

  it("allows a retry chained off a lone failed refund's own id", async () => {
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_failed_1", status: "failed", created: 100 }],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({
      kind: "ready",
      idempotencyKey: buildRetryIdempotencyKey(REQUEST_ID, "re_failed_1"),
    });
  });

  it("allows a retry chained off a lone canceled refund's own id", async () => {
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_canceled_1", status: "canceled", created: 100 }],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({
      kind: "ready",
      idempotencyKey: buildRetryIdempotencyKey(REQUEST_ID, "re_canceled_1"),
    });
  });

  // ---------------------------------------------------------------
  // The fixed defect: an earlier version of this function looked ONLY at
  // the latest refund by `created`, which could miss an EARLIER
  // succeeded or in-flight refund sitting behind a later failed one.
  // These tests construct exactly that shape and assert the whole set is
  // evaluated, not just its most recent member.
  // ---------------------------------------------------------------
  it("A: an earlier succeeded (partial) refund behind a later failed one still blocks", async () => {
    const stripe = makeFakeStripe({
      existingRefunds: [
        { id: "re_r1_succeeded_partial", status: "succeeded", created: 100 },
        { id: "re_r2_failed", status: "failed", created: 200 },
      ],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "blocked" });
  });

  it("B: an earlier pending refund behind a later failed one still blocks", async () => {
    const stripe = makeFakeStripe({
      existingRefunds: [
        { id: "re_r1_pending", status: "pending", created: 100 },
        { id: "re_r2_failed", status: "failed", created: 200 },
      ],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "blocked" });
  });

  it("C: an earlier requires_action refund behind a later canceled one still blocks", async () => {
    const stripe = makeFakeStripe({
      existingRefunds: [
        { id: "re_r1_requires_action", status: "requires_action", created: 100 },
        { id: "re_r2_canceled", status: "canceled", created: 200 },
      ],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "blocked" });
  });

  it("D: retry is allowed only when EVERY refund in the set is terminal failed/canceled", async () => {
    const stripe = makeFakeStripe({
      existingRefunds: [
        { id: "re_r1", status: "failed", created: 100 },
        { id: "re_r2", status: "canceled", created: 200 },
        { id: "re_r3", status: "failed", created: 300 },
      ],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({
      kind: "ready",
      idempotencyKey: buildRetryIdempotencyKey(REQUEST_ID, "re_r3"),
    });
  });

  it("E: with only failed/canceled refunds present, the latest by `created` determines the retry key", async () => {
    // R1 (older) failed, then R2 (newer) also failed -- the next retry
    // must chain off R2, not R1, regardless of what order the fake
    // (or a real, paginated) list happens to return them in.
    const stripe = makeFakeStripe({
      existingRefunds: [
        { id: "re_r1", status: "failed", created: 100 },
        { id: "re_r2", status: "failed", created: 200 },
      ],
    });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({
      kind: "ready",
      idempotencyKey: buildRetryIdempotencyKey(REQUEST_ID, "re_r2"),
    });
  });

  it("F: equal `created` timestamps break the tie deterministically by refund id, agreeing across independent calls", async () => {
    const existingRefunds = [
      { id: "re_bbb", status: "failed", created: 100 },
      { id: "re_aaa", status: "failed", created: 100 },
    ];
    const stripeA = makeFakeStripe({ existingRefunds });
    const stripeB = makeFakeStripe({ existingRefunds });

    const planA = await determineRefundAttempt(stripeA as never, PAYMENT_INTENT_ID, REQUEST_ID);
    const planB = await determineRefundAttempt(stripeB as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(planA).toEqual(planB);
    expect(planA.kind).toBe("ready");
  });

  it("G: a succeeded refund past a default 10-item page still blocks (whole set is inspected, not just a first page)", async () => {
    const existingRefunds = Array.from({ length: 14 }, (_, i) => ({
      id: `re_failed_${i}`,
      status: "failed",
      created: i,
    }));
    // Placed at index 12 -- past where a default page size of 10 would
    // have cut off.
    existingRefunds[12] = { id: "re_succeeded_late", status: "succeeded", created: 12 };
    const stripe = makeFakeStripe({ existingRefunds });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "blocked" });
  });

  it("H: a pending refund past a default 10-item page still blocks", async () => {
    const existingRefunds = Array.from({ length: 14 }, (_, i) => ({
      id: `re_failed_${i}`,
      status: "failed",
      created: i,
    }));
    existingRefunds[13] = { id: "re_pending_late", status: "pending", created: 13 };
    const stripe = makeFakeStripe({ existingRefunds });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "blocked" });
  });

  it("requests Stripe's own maximum page size (100), not the default 10, and passes the same cap to auto-pagination", async () => {
    const stripe = makeFakeStripe({ existingRefunds: [] });

    await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(stripe.refunds.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("fails closed when the live refund count reaches the inspection cap -- cannot prove the full set was seen", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const existingRefunds = Array.from({ length: 100 }, (_, i) => ({
      id: `re_${i}`,
      status: "failed",
      created: i,
    }));
    const stripe = makeFakeStripe({ existingRefunds });

    const plan = await determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID);

    expect(plan).toEqual({ kind: "blocked" });
    consoleWarnSpy.mockRestore();
  });

  it("propagates a Stripe list failure so the caller can fail closed", async () => {
    const stripe = makeFakeStripe({ listError: new Error("connection reset") });

    await expect(
      determineRefundAttempt(stripe as never, PAYMENT_INTENT_ID, REQUEST_ID),
    ).rejects.toThrow("connection reset");
  });
});

describe("executeApprovedRefund", () => {
  it("returns not_found and never calls Stripe when the id doesn't resolve to a row", async () => {
    const supabase = makeFakeSupabase(null);
    const stripe = makeFakeStripe();

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "not_found" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns not_approved and never calls Stripe for a request still awaiting review", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "requested",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe();

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "not_approved" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns not_approved and never calls Stripe for an already-refunded request (webhook already finalized this transaction)", async () => {
    // Simulates the CURRENT database state at the moment
    // executeApprovedRefund's own read runs -- e.g. the webhook already
    // moved this row to 'refunded' from an earlier attempt or a manual
    // Stripe Dashboard refund. This is the same re-fetch-and-recheck path
    // as the 'requested' case above, just landing on a different
    // terminal status. Caught before the Stripe pre-flight even runs.
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "refunded",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe();

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "not_approved" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(stripe.refunds.list).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects every non-approved status the same way, never calling Stripe", async () => {
    for (const status of ["requested", "rejected", "cancelled", "refunded"]) {
      const supabase = makeFakeSupabase({
        id: REQUEST_ID,
        status,
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
      });
      const stripe = makeFakeStripe();

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({ kind: "not_approved" });
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    }
  });

  it("first approved refund: issues with the base idempotency key, using payment_intent with no amount, reversing the Connect transfer", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe();

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({
      kind: "issued",
      refund: { id: "re_test_1", status: "succeeded" },
      auditRecorded: true,
    });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: PAYMENT_INTENT_ID,
        reverse_transfer: true,
        refund_application_fee: true,
      },
      { idempotencyKey: buildRefundIdempotencyKey(REQUEST_ID) },
    );
    // No `amount` key at all -- the full remaining charge, per Stripe's
    // own documented default behavior when amount is omitted. Full
    // refund + reverse_transfer: true reverses the ENTIRE Connect
    // transfer (the SDK's own doc comment: reversed "proportionally to
    // the amount being refunded (either the entire or partial
    // amount)") -- Librum only ever does full refunds, so this is
    // always a 100% reversal, never a partial one. Also asserts
    // refund_application_fee IS sent -- LAUNCH-1 P1-9 approved Policy B:
    // Librum's own platform fee is refunded alongside the reader's
    // payment and the author's transfer on every normal full refund.
    const [params] = stripe.refunds.create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params).not.toHaveProperty("amount");
    expect(params.reverse_transfer).toBe(true);
    expect(params.refund_application_fee).toBe(true);
  });

  it("double click on the first attempt: both calls use the identical base idempotency key (Stripe's own dedup contract) and both request reverse_transfer + refund_application_fee", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe();

    await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
    await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
    const [firstCallParams, firstCallOptions] = stripe.refunds.create.mock.calls[0] as unknown as [
      { reverse_transfer?: boolean; refund_application_fee?: boolean },
      { idempotencyKey: string },
    ];
    const [secondCallParams, secondCallOptions] = stripe.refunds.create.mock.calls[1] as unknown as [
      { reverse_transfer?: boolean; refund_application_fee?: boolean },
      { idempotencyKey: string },
    ];
    expect(firstCallOptions.idempotencyKey).toBe(secondCallOptions.idempotencyKey);
    expect(firstCallOptions.idempotencyKey).toBe(buildRefundIdempotencyKey(REQUEST_ID));
    expect(firstCallParams.reverse_transfer).toBe(true);
    expect(secondCallParams.reverse_transfer).toBe(true);
    expect(firstCallParams.refund_application_fee).toBe(true);
    expect(secondCallParams.refund_application_fee).toBe(true);
  });

  it.each(["pending", "requires_action"])(
    "existing '%s' refund: no second refunds.create call -- reports blocked (already in flight), and never calls any issuance-attempt RPC",
    async (status) => {
      const supabase = makeFakeSupabase({
        id: REQUEST_ID,
        status: "approved",
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
      });
      const stripe = makeFakeStripe({
        existingRefunds: [{ id: "re_1", status, created: 100 }],
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({ kind: "blocked" });
      expect(stripe.refunds.create).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    },
  );

  it("existing succeeded refund covering the full transaction: no second refunds.create call -- reports blocked (webhook will finalize), and never calls any issuance-attempt RPC", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_1", status: "succeeded", created: 100 }],
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "blocked" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("manual Stripe Dashboard refund already succeeded: no Librum-triggered duplicate, even though this admin action never created it, and no issuance-attempt RPC is called", async () => {
    // Nothing here distinguishes "created via the Stripe Dashboard" from
    // "created via this action" -- both look identical from the live
    // refunds.list() read, and both are handled the exact same way.
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_dashboard_1", status: "succeeded", created: 100 }],
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "blocked" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("manual Stripe Dashboard refund still pending: no Librum-triggered duplicate, and no issuance-attempt RPC is called", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_dashboard_2", status: "pending", created: 100 }],
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "blocked" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("R1 failed: retry creates R2 using a key deterministically derived from R1, still reversing the transfer and refunding the application fee", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_r1", status: "failed", created: 100 }],
      createImpl: () => Promise.resolve({ id: "re_r2", status: "succeeded" }),
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({
      kind: "issued",
      refund: { id: "re_r2", status: "succeeded" },
      auditRecorded: true,
    });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: PAYMENT_INTENT_ID,
        reverse_transfer: true,
        refund_application_fee: true,
      },
      { idempotencyKey: buildRetryIdempotencyKey(REQUEST_ID, "re_r1") },
    );
  });

  it("two concurrent retries after R1 failed both derive the identical R2 key, collapse at Stripe, and both reverse the transfer + refund the application fee", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_r1", status: "failed", created: 100 }],
    });

    await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
    await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
    const [firstParams, firstOptions] = stripe.refunds.create.mock.calls[0] as unknown as [
      { reverse_transfer?: boolean; refund_application_fee?: boolean },
      { idempotencyKey: string },
    ];
    const [secondParams, secondOptions] = stripe.refunds.create.mock.calls[1] as unknown as [
      { reverse_transfer?: boolean; refund_application_fee?: boolean },
      { idempotencyKey: string },
    ];
    expect(firstOptions.idempotencyKey).toBe(secondOptions.idempotencyKey);
    expect(firstOptions.idempotencyKey).toBe(buildRetryIdempotencyKey(REQUEST_ID, "re_r1"));
    expect(firstParams.reverse_transfer).toBe(true);
    expect(secondParams.reverse_transfer).toBe(true);
    expect(firstParams.refund_application_fee).toBe(true);
    expect(secondParams.refund_application_fee).toBe(true);
  });

  it("R1 failed, R2 failed: the next retry uses a DIFFERENT deterministic key derived from R2, not R1", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    // Simulates the live Stripe state AFTER both R1 and R2 have already
    // failed -- the fake list() always returns both this fixture.
    const stripe = makeFakeStripe({
      existingRefunds: [
        { id: "re_r1", status: "failed", created: 100 },
        { id: "re_r2", status: "failed", created: 200 },
      ],
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({
      kind: "issued",
      refund: { id: "re_test_1", status: "succeeded" },
      auditRecorded: true,
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: PAYMENT_INTENT_ID,
        reverse_transfer: true,
        refund_application_fee: true,
      },
      { idempotencyKey: buildRetryIdempotencyKey(REQUEST_ID, "re_r2") },
    );
  });

  it("J: two concurrent retries over the SAME multi-refund all-failed/canceled set derive the identical key", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      existingRefunds: [
        { id: "re_r1", status: "failed", created: 100 },
        { id: "re_r2", status: "canceled", created: 200 },
      ],
    });

    await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
    await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
    const [firstOptions] = stripe.refunds.create.mock.calls[0].slice(1) as unknown as [
      { idempotencyKey: string },
    ];
    const [secondOptions] = stripe.refunds.create.mock.calls[1].slice(1) as unknown as [
      { idempotencyKey: string },
    ];
    expect(firstOptions.idempotencyKey).toBe(secondOptions.idempotencyKey);
    expect(firstOptions.idempotencyKey).toBe(buildRetryIdempotencyKey(REQUEST_ID, "re_r2"));
  });

  it("a Stripe error reading live refund state fails closed: no create call is ever attempted, no issuance-attempt RPC is called", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({ listError: new Error("connection reset") });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  // -------------------------------------------------------------------
  // ADMIN-1C Part B PRE-FINALIZE CORRECTION: the required flow-ordering
  // proofs. These exercise the exact sequence the correction mandates --
  // a durable attempt row committed BEFORE Stripe is ever called, the
  // SAME idempotency key used for both, and the completion/failure RPCs
  // called only from the correct branch afterward.
  // -------------------------------------------------------------------
  describe("begin/Stripe/complete ordering", () => {
    it("NEW ATTEMPT: begins the attempt before calling Stripe, with the SAME idempotency key passed to both, then completes the attempt after Stripe succeeds", async () => {
      const callOrder: string[] = [];
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name, params) => {
          callOrder.push(`rpc:${name}`);
          if (name === "begin_refund_issuance_attempt") {
            expect(params.p_idempotency_key).toBe(buildRefundIdempotencyKey(REQUEST_ID));
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          if (name === "complete_refund_issuance_attempt") {
            expect(params).toEqual({
              p_attempt_id: DEFAULT_ATTEMPT_ID,
              p_stripe_refund_id: "re_test_1",
              p_stripe_status: "succeeded",
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      );
      const stripe = makeFakeStripe({
        createImpl: () => {
          callOrder.push("stripe:refunds.create");
          return Promise.resolve({ id: "re_test_1", status: "succeeded" });
        },
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({
        kind: "issued",
        refund: { id: "re_test_1", status: "succeeded" },
        auditRecorded: true,
      });
      expect(callOrder).toEqual([
        "rpc:begin_refund_issuance_attempt",
        "stripe:refunds.create",
        "rpc:complete_refund_issuance_attempt",
      ]);
      const [, createOptions] = stripe.refunds.create.mock.calls[0] as unknown as [
        unknown,
        { idempotencyKey: string },
      ];
      expect(createOptions.idempotencyKey).toBe(buildRefundIdempotencyKey(REQUEST_ID));
    });

    it("BEGIN RPC FAILURE: Stripe is never called, and the outcome reports the attempt-specific error message, not the generic Stripe one", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name) => {
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: null, error: { message: "connection reset" } });
          }
          throw new Error(`unexpected rpc call: ${name}`);
        },
      );
      const stripe = makeFakeStripe();

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({ kind: "stripe_error", message: REFUND_ATTEMPT_INIT_ERROR_MESSAGE });
      expect(stripe.refunds.create).not.toHaveBeenCalled();
      expect(supabase.rpc).toHaveBeenCalledTimes(1);
      consoleErrorSpy.mockRestore();
    });

    it("BEGIN RPC FAILURE (null attempt id with no error): still treated as a failure -- Stripe is never called", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        () => Promise.resolve({ data: null, error: null }),
      );
      const stripe = makeFakeStripe();

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({ kind: "stripe_error", message: REFUND_ATTEMPT_INIT_ERROR_MESSAGE });
      expect(stripe.refunds.create).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it("BLOCKED: neither begin_refund_issuance_attempt nor Stripe is ever called", async () => {
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        () => {
          throw new Error("rpc should never be called for a blocked pre-flight outcome");
        },
      );
      const stripe = makeFakeStripe({
        existingRefunds: [{ id: "re_1", status: "succeeded", created: 100 }],
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({ kind: "blocked" });
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    });

    // ADMIN-1C Part B FINAL FINANCIAL INVARIANT CORRECTION: this call
    // site's own behavior (which RPC, which reason code, ordering) is
    // unchanged by that correction -- what changed is purely a DB-layer
    // decision, migration 042's fail_refund_issuance_attempt() now maps
    // reason 'stripe_error' to status = 'unknown' rather than 'failed'
    // (a thrown call proves only that no response was received, not that
    // Stripe never processed the request). This fake-Supabase test can
    // only assert the RPC call itself (name + params), not the resulting
    // DB row's status column -- that mapping is verified directly in
    // supabase/tests/042_admin_audit_visibility.test.sql's own
    // fail_refund_issuance_attempt() tests.
    it("STRIPE THROW: the durable attempt already exists (begin succeeded), Stripe throws, fail_refund_issuance_attempt is called with reason 'stripe_error', and complete is never called", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name, params) => {
          rpcCalls.push({ name, params });
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      );
      const stripe = makeFakeStripe({
        createImpl: () => Promise.reject(new Error("No such payment_intent (internal detail)")),
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });
      expect(rpcCalls.map((c) => c.name)).toEqual([
        "begin_refund_issuance_attempt",
        "fail_refund_issuance_attempt",
      ]);
      expect(rpcCalls[1].params).toEqual({
        p_attempt_id: DEFAULT_ATTEMPT_ID,
        p_failure_reason: "stripe_error",
      });
      consoleErrorSpy.mockRestore();
    });

    it.each([
      ["failed", "immediate_failed"],
      ["canceled", "immediate_canceled"],
    ])(
      "IMMEDIATE %s: fail_refund_issuance_attempt is called with reason '%s', and complete is never called",
      async (status, expectedReason) => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const supabase = makeFakeSupabase(
          { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
          (name, params) => {
            rpcCalls.push({ name, params });
            if (name === "begin_refund_issuance_attempt") {
              return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        );
        const stripe = makeFakeStripe({
          createImpl: () => Promise.resolve({ id: "re_test_1", status }),
        });

        const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

        expect(outcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });
        expect(rpcCalls.map((c) => c.name)).toEqual([
          "begin_refund_issuance_attempt",
          "fail_refund_issuance_attempt",
        ]);
        expect(rpcCalls[1].params).toEqual({
          p_attempt_id: DEFAULT_ATTEMPT_ID,
          p_failure_reason: expectedReason,
        });
        consoleErrorSpy.mockRestore();
      },
    );

    it("COMPLETION RPC FAILURE AFTER STRIPE SUCCESS: outcome is still 'issued' (Stripe genuinely succeeded), but auditRecorded is false -- the durable attempt is not lost, and fail is never called for a Stripe success", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name, params) => {
          rpcCalls.push({ name, params });
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          if (name === "complete_refund_issuance_attempt") {
            return Promise.resolve({ data: null, error: { message: "connection reset" } });
          }
          return Promise.resolve({ data: null, error: null });
        },
      );
      const stripe = makeFakeStripe({
        createImpl: () => Promise.resolve({ id: "re_new_3", status: "succeeded" }),
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({
        kind: "issued",
        refund: { id: "re_new_3", status: "succeeded" },
        auditRecorded: false,
      });
      expect(rpcCalls.map((c) => c.name)).toEqual([
        "begin_refund_issuance_attempt",
        "complete_refund_issuance_attempt",
      ]);
      consoleErrorSpy.mockRestore();
    });

    it("genuine retry: a NEW deterministic idempotency key (chained off the prior failed refund) is what gets begun and passed to Stripe, not the base key", async () => {
      const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name, params) => {
          rpcCalls.push({ name, params });
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      );
      const stripe = makeFakeStripe({
        existingRefunds: [{ id: "re_r1", status: "failed", created: 100 }],
        createImpl: () => Promise.resolve({ id: "re_r2", status: "succeeded" }),
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      const retryKey = buildRetryIdempotencyKey(REQUEST_ID, "re_r1");
      expect(retryKey).not.toBe(buildRefundIdempotencyKey(REQUEST_ID));
      expect(rpcCalls[0]).toEqual({
        name: "begin_refund_issuance_attempt",
        params: { p_refund_request_id: REQUEST_ID, p_idempotency_key: retryKey },
      });
      const [, createOptions] = stripe.refunds.create.mock.calls[0] as unknown as [
        unknown,
        { idempotencyKey: string },
      ];
      expect(createOptions.idempotencyKey).toBe(retryKey);
      expect(outcome).toEqual({
        kind: "issued",
        refund: { id: "re_r2", status: "succeeded" },
        auditRecorded: true,
      });
    });

    // -----------------------------------------------------------------
    // ADMIN-1C Part B FINAL FINANCIAL INVARIANT CORRECTION: an 'unknown'
    // local attempt status (a prior Stripe throw whose true outcome is
    // unproven) must never itself be treated as "safe to retry" -- the
    // existing live-refund Stripe preflight (determineRefundAttempt) is
    // what actually governs, unconditionally, on every call, regardless
    // of what any local attempt row says. These two tests prove both
    // directions of that: Stripe genuinely never processed the ambiguous
    // attempt (a fresh retry with the SAME base key is safe), vs. Stripe
    // actually did process it (a second click must block, not duplicate).
    // -----------------------------------------------------------------
    it("UNKNOWN RETRY (never actually processed): after an ambiguous Stripe throw, a second click re-derives LIVE Stripe state (still empty) and safely retries with the SAME base idempotency key -- the local 'unknown' status is never consulted", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name, params) => {
          rpcCalls.push({ name, params });
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      );
      // existingRefunds stays empty across BOTH calls -- simulating that
      // Stripe genuinely never received/processed the first (thrown)
      // request, so the live preflight correctly finds nothing to block
      // on, on either call.
      let createCallCount = 0;
      const stripe = makeFakeStripe({
        existingRefunds: [],
        createImpl: () => {
          createCallCount += 1;
          if (createCallCount === 1) {
            return Promise.reject(new Error("transport error, no response received"));
          }
          return Promise.resolve({ id: "re_after_unknown", status: "succeeded" });
        },
      });

      const firstOutcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
      expect(firstOutcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });

      const secondOutcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(secondOutcome).toEqual({
        kind: "issued",
        refund: { id: "re_after_unknown", status: "succeeded" },
        auditRecorded: true,
      });
      expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
      const baseKey = buildRefundIdempotencyKey(REQUEST_ID);
      for (const call of stripe.refunds.create.mock.calls) {
        const [, options] = call as unknown as [unknown, { idempotencyKey: string }];
        expect(options.idempotencyKey).toBe(baseKey);
      }
      expect(rpcCalls.filter((c) => c.name === "begin_refund_issuance_attempt")).toHaveLength(2);
      for (const call of rpcCalls.filter((c) => c.name === "begin_refund_issuance_attempt")) {
        expect(call.params.p_idempotency_key).toBe(baseKey);
      }
      consoleErrorSpy.mockRestore();
    });

    it("UNKNOWN RETRY (actually processed despite the throw): a second click's live Stripe preflight discovers the real refund and BLOCKS -- no second create() call, no second begin call", async () => {
      // Represents Stripe's live state AFTER an earlier ambiguous
      // (thrown) attempt actually succeeded on Stripe's own side --
      // exactly what determineRefundAttempt's own live list() call would
      // see on a second click, regardless of what the local attempt row
      // says.
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        () => {
          throw new Error("rpc should never be called for a blocked pre-flight outcome");
        },
      );
      const stripe = makeFakeStripe({
        existingRefunds: [{ id: "re_ambiguous_but_succeeded", status: "succeeded", created: 100 }],
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({ kind: "blocked" });
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------
    // ADMIN-1C Part B UNKNOWN-STATE RECOVERY CORRECTION: the three
    // required recovery-path scenarios. Each simulates two SEQUENTIAL
    // calls to executeApprovedRefund for the SAME refund request, sharing
    // one fake Supabase/Stripe pair across both calls -- the first call
    // produces an ambiguous (thrown) Stripe outcome; the second call is
    // the retry. existingRefunds stays empty across BOTH calls in every
    // one of these tests (Stripe genuinely never processed the first,
    // ambiguous attempt) -- these tests exercise the RECOVERY RPCs
    // directly, distinct from the "actually processed despite the throw"
    // preflight-blocks test above. The DEFAULT_ATTEMPT_ID mock (unchanged
    // across both calls) stands in for "the same idempotency key resolves
    // to the same durable attempt row" -- begin_refund_issuance_attempt()
    // itself is not re-tested here (already covered by its own dedicated
    // tests above and by the SQL suite); what these tests actually prove
    // is that this call site never mints a fresh idempotency key or a
    // second attempt merely because the prior local outcome was
    // ambiguous, and that the SAME attempt id flows through to whichever
    // RPC the retry's outcome calls next.
    // -----------------------------------------------------------------

    it("A. UNKNOWN -> SUBMITTED: a throw marks the attempt ambiguous, a retry with the SAME key/attempt succeeds, and completion is recorded exactly once for that SAME attempt", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name, params) => {
          rpcCalls.push({ name, params });
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      );
      let createCallCount = 0;
      const stripe = makeFakeStripe({
        existingRefunds: [],
        createImpl: () => {
          createCallCount += 1;
          if (createCallCount === 1) {
            return Promise.reject(new Error("transport error, no response received"));
          }
          return Promise.resolve({ id: "re_recovered", status: "succeeded" });
        },
      });

      // 1. first Stripe call throws.
      const firstOutcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
      expect(firstOutcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });

      // 2. attempt becomes unknown -- asserted at the RPC-call level (the
      // DB-side resulting status is verified in the SQL suite -- see
      // fail_refund_issuance_attempt()'s own migration-042 tests).
      expect(rpcCalls[1]).toEqual({
        name: "fail_refund_issuance_attempt",
        params: { p_attempt_id: DEFAULT_ATTEMPT_ID, p_failure_reason: "stripe_error" },
      });

      // 3. retry uses the same idempotency key / same attempt.
      const secondOutcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
      const baseKey = buildRefundIdempotencyKey(REQUEST_ID);
      expect(rpcCalls[2]).toEqual({
        name: "begin_refund_issuance_attempt",
        params: { p_refund_request_id: REQUEST_ID, p_idempotency_key: baseKey },
      });

      // 4 & 5. Stripe returns an accepted refund, and the completion RPC
      // is called for that SAME attempt.
      expect(rpcCalls[3]).toEqual({
        name: "complete_refund_issuance_attempt",
        params: { p_attempt_id: DEFAULT_ATTEMPT_ID, p_stripe_refund_id: "re_recovered", p_stripe_status: "succeeded" },
      });

      // 6. final intended state is submitted (reflected as "issued" with
      // auditRecorded: true -- the outcome-level equivalent of the
      // attempt's own transition to 'submitted').
      expect(secondOutcome).toEqual({
        kind: "issued",
        refund: { id: "re_recovered", status: "succeeded" },
        auditRecorded: true,
      });

      // 7. exactly one submitted/completion call across the whole
      // recovery -- never two.
      expect(rpcCalls.filter((c) => c.name === "complete_refund_issuance_attempt")).toHaveLength(1);
      expect(rpcCalls.filter((c) => c.name === "fail_refund_issuance_attempt")).toHaveLength(1);

      consoleErrorSpy.mockRestore();
    });

    it("B. UNKNOWN -> FAILED: a throw marks the attempt ambiguous, a retry with the SAME key/attempt resolves to an explicit failure, and no submitted audit event is ever produced", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name, params) => {
          rpcCalls.push({ name, params });
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      );
      let createCallCount = 0;
      const stripe = makeFakeStripe({
        existingRefunds: [],
        createImpl: () => {
          createCallCount += 1;
          if (createCallCount === 1) {
            return Promise.reject(new Error("transport error, no response received"));
          }
          return Promise.resolve({ id: "re_now_failed", status: "failed" });
        },
      });

      // 1-2. first Stripe call throws -> unknown.
      await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
      expect(rpcCalls[1]).toEqual({
        name: "fail_refund_issuance_attempt",
        params: { p_attempt_id: DEFAULT_ATTEMPT_ID, p_failure_reason: "stripe_error" },
      });

      // 3. retry uses the same attempt/key.
      const secondOutcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
      expect(rpcCalls[2].name).toBe("begin_refund_issuance_attempt");
      expect(rpcCalls[2].params.p_idempotency_key).toBe(buildRefundIdempotencyKey(REQUEST_ID));

      // 4-5. Stripe returns an explicit failed status -> the failure RPC
      // resolves the SAME attempt to failed.
      expect(rpcCalls[3]).toEqual({
        name: "fail_refund_issuance_attempt",
        params: { p_attempt_id: DEFAULT_ATTEMPT_ID, p_failure_reason: "immediate_failed" },
      });
      expect(secondOutcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });

      // no submitted audit event: complete_refund_issuance_attempt is
      // never called anywhere in this recovery.
      expect(rpcCalls.some((c) => c.name === "complete_refund_issuance_attempt")).toBe(false);

      consoleErrorSpy.mockRestore();
    });

    it("C. UNKNOWN -> UNKNOWN: a repeat ambiguous transport failure on retry stays unknown, never creates a fresh idempotency key, and no submitted audit event is ever produced", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name, params) => {
          rpcCalls.push({ name, params });
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      );
      const stripe = makeFakeStripe({
        existingRefunds: [],
        createImpl: () => Promise.reject(new Error("transport error, no response received")),
      });

      const firstOutcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);
      const secondOutcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(firstOutcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });
      expect(secondOutcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });

      const baseKey = buildRefundIdempotencyKey(REQUEST_ID);
      const beginCalls = rpcCalls.filter((c) => c.name === "begin_refund_issuance_attempt");
      expect(beginCalls).toHaveLength(2);
      // local 'unknown' state alone never creates a fresh idempotency key
      // -- both begin calls use the identical base key, never a
      // buildRetryIdempotencyKey()-derived one.
      for (const call of beginCalls) {
        expect(call.params.p_idempotency_key).toBe(baseKey);
      }

      const failCalls = rpcCalls.filter((c) => c.name === "fail_refund_issuance_attempt");
      expect(failCalls).toHaveLength(2);
      for (const call of failCalls) {
        expect(call.params).toEqual({ p_attempt_id: DEFAULT_ATTEMPT_ID, p_failure_reason: "stripe_error" });
      }

      expect(rpcCalls.some((c) => c.name === "complete_refund_issuance_attempt")).toBe(false);

      consoleErrorSpy.mockRestore();
    });
  });

  it("returns the attempt-init error and never calls Stripe when begin_refund_issuance_attempt fails (legacy no-write assertion)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = makeFakeSupabase(
      { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
      (name) => {
        if (name === "begin_refund_issuance_attempt") {
          return Promise.resolve({ data: null, error: { message: "connection reset" } });
        }
        throw new Error(`unexpected rpc call: ${name}`);
      },
    );
    const stripe = makeFakeStripe();

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "stripe_error", message: REFUND_ATTEMPT_INIT_ERROR_MESSAGE });
    // makeFakeSupabase's builder has no update/upsert method at all --
    // if executeApprovedRefund attempted a direct table write here, this
    // test would throw a TypeError rather than silently pass, since
    // there is nothing to call.
    consoleErrorSpy.mockRestore();
  });

  it("returns a safe, non-sensitive error when Stripe rejects the create call, after the attempt was already durably begun", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      createImpl: () =>
        Promise.reject(new Error("No such payment_intent: 'pi_test_123' (secret internal detail)")),
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });
    // The safe message never echoes the underlying Stripe exception text.
    if (outcome.kind === "stripe_error") {
      expect(outcome.message).not.toContain("pi_test_123");
      expect(outcome.message).not.toContain("secret internal detail");
    }
    // complete_refund_issuance_attempt (the audit-writing RPC) must never
    // be called for a failed Stripe attempt.
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "complete_refund_issuance_attempt",
      expect.anything(),
    );
    consoleErrorSpy.mockRestore();
  });

  it("Stripe's already-refunded-charge rejection surfaces as the same safe stripe_error outcome, with no completion RPC call", async () => {
    // Per the installed stripe@22.5.0 SDK's own doc comment on
    // RefundResource.create(): "This method will raise an error when
    // called on an already-refunded charge..." -- this is the backstop
    // for a race the pre-flight list() itself might miss (e.g. the
    // charge became fully refunded via some means between the pre-flight
    // read and this call landing at Stripe); Stripe's own API refusal is
    // sufficient, no separate detection logic is needed here either.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      createImpl: () =>
        Promise.reject(
          Object.assign(new Error("Charge already refunded"), { type: "StripeInvalidRequestError" }),
        ),
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "complete_refund_issuance_attempt",
      expect.anything(),
    );
    consoleErrorSpy.mockRestore();
  });

  // -------------------------------------------------------------------
  // REFUND-1B Step 5 correction: refunds.create() resolving successfully
  // only means Stripe ACCEPTED the request -- the installed SDK's own
  // Refund.status type ("pending" | "requires_action" | "succeeded" |
  // "failed" | "canceled") means a resolved call can still carry an
  // already-terminal failed/canceled status. "issued" must only ever be
  // reported for a genuinely non-terminal-bad outcome; the webhook
  // (processRefundLifecycleEvent) remains the sole authority for
  // Librum's own state regardless of which of these is returned here.
  // -------------------------------------------------------------------
  it.each(["pending", "requires_action", "succeeded"])(
    "reports issued for an immediate '%s' refund status (still Stripe's authority to confirm later)",
    async (status) => {
      const supabase = makeFakeSupabase({
        id: REQUEST_ID,
        status: "approved",
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
      });
      const stripe = makeFakeStripe({
        createImpl: () => Promise.resolve({ id: "re_test_1", status }),
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({
        kind: "issued",
        refund: { id: "re_test_1", status },
        auditRecorded: true,
      });
    },
  );

  it.each(["failed", "canceled"])(
    "reports a safe stripe_error, never 'issued', for an immediate '%s' refund status, and never calls the completion RPC",
    async (status) => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const supabase = makeFakeSupabase({
        id: REQUEST_ID,
        status: "approved",
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
      });
      const stripe = makeFakeStripe({
        createImpl: () => Promise.resolve({ id: "re_test_1", status }),
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({ kind: "stripe_error", message: STRIPE_REFUND_ERROR_MESSAGE });
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        "complete_refund_issuance_attempt",
        expect.anything(),
      );
      consoleErrorSpy.mockRestore();
    },
  );

  // -------------------------------------------------------------------
  // ADMIN-1C Part B: the completion-RPC audit-write call itself. Part
  // A's own required condition -- the audit event is written ONLY when a
  // genuine new stripe.refunds.create() call was made, resolved without
  // throwing, and the resolved status is not an immediate failed/
  // canceled terminal failure -- is exercised directly here, on top of
  // the "no issuance-attempt RPC call" assertions already threaded
  // through every blocked/pre-Stripe-error test above.
  // -------------------------------------------------------------------
  describe("complete_refund_issuance_attempt audit call", () => {
    it("calls begin then complete, with the exact refund id/status, only for a genuine new Stripe attempt", async () => {
      const supabase = makeFakeSupabase({
        id: REQUEST_ID,
        status: "approved",
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
      });
      const stripe = makeFakeStripe({
        createImpl: () => Promise.resolve({ id: "re_new_1", status: "pending" }),
      });

      await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(supabase.rpc).toHaveBeenCalledTimes(2);
      expect(supabase.rpc).toHaveBeenNthCalledWith(1, "begin_refund_issuance_attempt", {
        p_refund_request_id: REQUEST_ID,
        p_idempotency_key: buildRefundIdempotencyKey(REQUEST_ID),
      });
      expect(supabase.rpc).toHaveBeenNthCalledWith(2, "complete_refund_issuance_attempt", {
        p_attempt_id: DEFAULT_ATTEMPT_ID,
        p_stripe_refund_id: "re_new_1",
        p_stripe_status: "pending",
      });
    });

    it("coerces a null/undefined refund status to 'unknown' rather than passing it through raw", async () => {
      const supabase = makeFakeSupabase({
        id: REQUEST_ID,
        status: "approved",
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
      });
      const stripe = makeFakeStripe({
        createImpl: () => Promise.resolve({ id: "re_new_2", status: null }),
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({
        kind: "issued",
        refund: { id: "re_new_2", status: "unknown" },
        auditRecorded: true,
      });
      expect(supabase.rpc).toHaveBeenCalledWith("complete_refund_issuance_attempt", {
        p_attempt_id: DEFAULT_ATTEMPT_ID,
        p_stripe_refund_id: "re_new_2",
        p_stripe_status: "unknown",
      });
    });

    it("a completion-RPC failure does not change the outcome's kind/refund -- the Stripe refund already succeeded by this point -- but auditRecorded reflects the failure honestly", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const supabase = makeFakeSupabase(
        { id: REQUEST_ID, status: "approved", stripe_payment_intent_id: PAYMENT_INTENT_ID },
        (name) => {
          if (name === "begin_refund_issuance_attempt") {
            return Promise.resolve({ data: DEFAULT_ATTEMPT_ID, error: null });
          }
          return Promise.resolve({ data: null, error: { message: "connection reset" } });
        },
      );
      const stripe = makeFakeStripe({
        createImpl: () => Promise.resolve({ id: "re_new_3", status: "succeeded" }),
      });

      const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

      expect(outcome).toEqual({
        kind: "issued",
        refund: { id: "re_new_3", status: "succeeded" },
        auditRecorded: false,
      });
      expect(supabase.rpc).toHaveBeenCalledTimes(2);
      consoleErrorSpy.mockRestore();
    });
  });
});
