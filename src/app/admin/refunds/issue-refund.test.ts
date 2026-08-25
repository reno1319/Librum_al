import { describe, expect, it, vi } from "vitest";
import {
  buildRefundIdempotencyKey,
  buildRetryIdempotencyKey,
  determineRefundAttempt,
  executeApprovedRefund,
  STRIPE_REFUND_ERROR_MESSAGE,
} from "./issue-refund";

// ---------------------------------------------------------------------
// A minimal, read-only fake of the Supabase query builder -- just enough
// of the fluent chain (.from().select().eq().maybeSingle()) to serve
// executeApprovedRefund()'s single Supabase call. Deliberately has no
// .update()/.upsert() method at all: several tests below rely on this to
// prove "no Supabase write is attempted" the same way a TypeScript
// compile error would -- there is nothing to call.
// ---------------------------------------------------------------------
type Row = Record<string, unknown> | null;

function makeFakeSupabase(row: Row) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      }),
    }),
  };
}

// `existingRefunds` seeds what determineRefundAttempt's pre-flight
// list() call sees -- defaults to none (a genuine first attempt), the
// common case for most tests below. `createImpl` overrides what
// refunds.create() itself resolves/rejects with; `listError`, when set,
// makes the pre-flight list() call itself reject (simulating a Stripe
// read failure).
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
      create: vi.fn(params.createImpl ?? (() => Promise.resolve({ id: "re_test_1" }))),
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

  it("first approved refund: submits with the base idempotency key, using payment_intent with no amount, reversing the Connect transfer", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe();

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "submitted" });
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
    "existing '%s' refund: no second refunds.create call -- reports submitted (already in flight)",
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

      expect(outcome).toEqual({ kind: "submitted" });
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    },
  );

  it("existing succeeded refund covering the full transaction: no second refunds.create call -- reports submitted (webhook will finalize)", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_1", status: "succeeded", created: 100 }],
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "submitted" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("manual Stripe Dashboard refund already succeeded: no Librum-triggered duplicate, even though this admin action never created it", async () => {
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

    expect(outcome).toEqual({ kind: "submitted" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("manual Stripe Dashboard refund still pending: no Librum-triggered duplicate", async () => {
    const supabase = makeFakeSupabase({
      id: REQUEST_ID,
      status: "approved",
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });
    const stripe = makeFakeStripe({
      existingRefunds: [{ id: "re_dashboard_2", status: "pending", created: 100 }],
    });

    const outcome = await executeApprovedRefund(supabase as never, stripe as never, REQUEST_ID);

    expect(outcome).toEqual({ kind: "submitted" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
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

    expect(outcome).toEqual({ kind: "submitted" });
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

    expect(outcome).toEqual({ kind: "submitted" });
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

  it("a Stripe error reading live refund state fails closed: no create call is ever attempted", async () => {
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
    consoleErrorSpy.mockRestore();
  });

  it("returns a safe, non-sensitive error and attempts no Supabase write when Stripe rejects the create call", async () => {
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
    // makeFakeSupabase's builder has no update/upsert method at all --
    // if executeApprovedRefund attempted a write here, this test would
    // throw a TypeError rather than silently pass, since there is
    // nothing to call.
    consoleErrorSpy.mockRestore();
  });

  it("Stripe's already-refunded-charge rejection surfaces as the same safe stripe_error outcome", async () => {
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
    consoleErrorSpy.mockRestore();
  });

  // -------------------------------------------------------------------
  // REFUND-1B Step 5 correction: refunds.create() resolving successfully
  // only means Stripe ACCEPTED the request -- the installed SDK's own
  // Refund.status type ("pending" | "requires_action" | "succeeded" |
  // "failed" | "canceled") means a resolved call can still carry an
  // already-terminal failed/canceled status. "submitted" must only ever
  // be reported for a genuinely non-terminal-bad outcome; the webhook
  // (processRefundLifecycleEvent) remains the sole authority for
  // Librum's own state regardless of which of these is returned here.
  // -------------------------------------------------------------------
  it.each(["pending", "requires_action", "succeeded"])(
    "reports submitted for an immediate '%s' refund status (still Stripe's authority to confirm later)",
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

      expect(outcome).toEqual({ kind: "submitted" });
    },
  );

  it.each(["failed", "canceled"])(
    "reports a safe stripe_error, never 'submitted', for an immediate '%s' refund status",
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
      consoleErrorSpy.mockRestore();
    },
  );
});
