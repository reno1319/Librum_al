import { createAdminClient } from "./supabase/admin";
import type {
  PokMapping, FrozenPokIntent, PokRepository, PokClaimOutcome, PokRetireOutcome,
} from "./pok-checkout";

export function createPokRepository(): PokRepository {
  const db = createAdminClient();
  return {
    async intent(id) {
      const { data, error } = await db.from("book_checkout_intents")
        // POK-FULFILMENT-1: fulfilled_at and reconciliation_reason are
        // read for ONE purpose -- telling the two already_finalized
        // meanings apart after finalization. fulfilled_at stays the sole
        // entitlement authority; nothing here writes either column.
        .select("id,book_id,reader_id,regime,currency,price_cents_at_checkout,expires_at,stripe_checkout_session_id,fulfilled_at,reconciliation_reason").eq("id", id).maybeSingle<FrozenPokIntent>();
      if (error) throw new Error("POK_INTENT_READ_FAILED");
      return data;
    },
    async mapping(id) {
      const { data, error } = await db.from("pok_book_checkout_orders").select("*").eq("intent_id", id).maybeSingle<PokMapping>();
      if (error) throw new Error("POK_MAPPING_READ_FAILED");
      return data;
    },
    // STALE-CHECKOUT-1: an RPC outcome, not a JavaScript reading of
    // SQLSTATE 23505. The previous `error?.code === "23505" -> false`
    // branch treated ANY unique violation as "already claimed" --
    // including a webhook_token or merchant_custom_reference collision,
    // neither of which means anything of the sort. SQL now names the
    // primary key as the only legitimate conflict target, so any other
    // unique violation arrives here as a real error and becomes
    // POK_CLAIM_FAILED. It can never read as "already claimed".
    //
    // The granted window comes back FROM SQL and is what gets sent to
    // POK, so one clock governs both the stored window and the duration
    // the provider is asked for.
    async claim(row): Promise<PokClaimOutcome> {
      const { data, error } = await db.rpc("claim_pok_book_checkout_order", {
        p_intent_id: row.intentId,
        p_reference: row.reference,
        p_webhook_token: row.webhookToken,
        p_claim_id: row.claimId,
        p_requested_window_minutes: row.requestedWindowMinutes,
      });
      const result = (data as Array<{ outcome: string; granted_window_minutes: number | null }> | null)?.[0];
      if (error || !result) throw new Error("POK_CLAIM_FAILED");
      if (result.outcome === "claimed") {
        if (!Number.isInteger(result.granted_window_minutes) || (result.granted_window_minutes ?? 0) < 1) {
          // A claim without a usable window is unusable: we would have
          // to invent the duration POK is asked for, which is exactly
          // what moving the calculation into SQL removed.
          throw new Error("POK_CLAIM_FAILED");
        }
        return { outcome: "claimed", grantedWindowMinutes: result.granted_window_minutes as number };
      }
      if (result.outcome === "already_claimed" || result.outcome === "intent_not_found" ||
          result.outcome === "intent_not_claimable" || result.outcome === "intent_expired" ||
          result.outcome === "intent_stripe_bound" || result.outcome === "reference_mismatch") {
        return { outcome: result.outcome };
      }
      throw new Error("POK_CLAIM_FAILED");
    },
    // STALE-CHECKOUT-1: the provider order id is written the moment POK
    // returns it, separately from and before `ready`. Idempotent by
    // construction -- it re-matches the same claim in the same state and
    // accepts an already-recorded IDENTICAL id -- so the bounded retry in
    // pok-checkout.ts is safe. The precise CAS on (intent, claim, state)
    // is preserved exactly: a different claim, or a mapping that has
    // moved on, matches nothing and fails rather than overwriting.
    async recordProviderOrder(id, claimId, orderId) {
      const { data, error } = await db.from("pok_book_checkout_orders")
        .update({ provider_order_id: orderId })
        .eq("intent_id", id).eq("creation_claim_id", claimId).eq("state", "creating")
        .or(`provider_order_id.is.null,provider_order_id.eq.${orderId}`)
        .select("intent_id").maybeSingle();
      if (error || !data) throw new Error("POK_ORDER_PERSISTENCE_FAILED");
    },
    async ready(id, claimId, url) {
      const { data, error } = await db.from("pok_book_checkout_orders")
        .update({ state: "ready", checkout_url: url })
        .eq("intent_id", id).eq("creation_claim_id", claimId).eq("state", "creating")
        .not("provider_order_id", "is", null)
        .select("intent_id").single();
      if (error || !data) throw new Error("POK_LINK_FAILED");
    },
    async reconcile(id, claimId) {
      // Never nulls provider_order_id: an id recorded above must survive
      // a later validation failure, or the orphan becomes unnameable.
      const { error } = await db.from("pok_book_checkout_orders")
        .update({ state: "needs_reconciliation", last_error_code: "creation_unconfirmed" })
        .eq("intent_id", id).eq("creation_claim_id", claimId).eq("state", "creating");
      if (error) throw new Error("POK_RECONCILIATION_WRITE_FAILED");
    },
    // POK-FULFILMENT-1: ONE statement -- write the observation, return
    // the timing. There is deliberately no pre-write read: a read-then-
    // decide pair yields a STALE first-seen value whenever two callbacks
    // race, and the value this decision needs is the one the database
    // holds AFTER this write.
    //
    // The CAS is a single `in` predicate rather than two negations, so
    // there is one thing to read and no way to satisfy three of four
    // conditions. It matches neither 'creating' nor 'retired':
    //
    //   retired   terminal. A diagnostic write must not disturb it, and
    //             the mapping's own transition trigger additionally
    //             refuses to stamp the marker on any row whose resulting
    //             state is not ready/needs_reconciliation.
    //   creating  the id is recorded several statements BEFORE
    //             repo.ready() runs, so a callback landing in that window
    //             would move the row to needs_reconciliation, make
    //             ready()'s own `state = 'creating'` CAS match zero rows,
    //             and leave the reader with no checkout_url at all.
    //
    // A zero-row result is NOT an error -- it is exactly those states --
    // so it returns null and the caller answers terminally rather than
    // asking the provider to retry into a state with no bounded exit.
    // A real write failure throws.
    //
    // The returned pair are two readings of the DATABASE clock inside one
    // transaction: the transition trigger stamps
    // fulfilment_gap_first_seen_at (once, immutably) and the existing
    // unconditional trigger stamps updated_at. No application clock is
    // involved in the retry decision at any point.
    async recordFulfilmentObservation(id, code) {
      const { data, error } = await db.from("pok_book_checkout_orders")
        .update({ state: "needs_reconciliation", last_error_code: code })
        .eq("intent_id", id)
        .not("provider_order_id", "is", null)
        .in("state", ["ready", "needs_reconciliation"])
        .select("fulfilment_gap_first_seen_at,updated_at")
        .maybeSingle<{ fulfilment_gap_first_seen_at: string | null; updated_at: string }>();
      if (error) throw new Error("POK_FULFILMENT_OBSERVATION_WRITE_FAILED");
      return data;
    },
    // STALE-CHECKOUT-1: ONE atomic call. The mapping moves to 'retired'
    // and the intent is superseded in the same transaction under the same
    // advisory lock, or neither happens -- a two-step retire-then-
    // supersede would leave a window where a dead attempt sat on a live
    // quote. The expected claim/order-id/state triple is a compare-and-
    // set inside SQL, compared with `is not distinct from` so a
    // legitimately null provider_order_id is matched rather than
    // misreported as a change.
    async retire(args): Promise<PokRetireOutcome> {
      const { data, error } = await db.rpc("retire_book_checkout_attempt", {
        p_intent_id: args.intentId,
        p_expected_claim_id: args.expectedClaimId,
        p_expected_provider_order_id: args.expectedProviderOrderId,
        p_expected_state: args.expectedState,
        p_retired_reason: args.retiredReason,
      });
      if (error || typeof data !== "string") throw new Error("POK_RETIRE_FAILED");
      return data as PokRetireOutcome;
    },
    async recordEvent(paymentId) {
      const { data, error } = await db.rpc("record_payment_event", {
        p_provider: "pok", p_provider_event_id: `payment:${paymentId}:succeeded`,
        p_event_type: "pok.order.payment_verified", p_provider_payment_id: paymentId,
      });
      const row = data?.[0] as { id: string; received_at: string } | undefined;
      if (error || !row) throw new Error("POK_EVENT_WRITE_FAILED");
      return row;
    },
    async finalize(args) {
      const { data, error } = await db.rpc("finalize_ledger_book_payment", {
        p_payment_event_id: args.eventId, p_intent_id: args.intentId, p_provider: "pok",
        p_provider_payment_id: args.paymentId, p_actual_amount_minor: args.minor,
        p_actual_currency: args.currency, p_paid_at: args.paidAt,
      });
      const row = data?.[0] as { outcome: string } | undefined;
      if (error || !row) throw new Error("POK_FINALIZATION_FAILED");
      return row.outcome;
    },
  };
}
