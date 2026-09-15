import { createAdminClient } from "./supabase/admin";
import type { PokMapping, FrozenPokIntent, PokRepository } from "./pok-checkout";

export function createPokRepository(): PokRepository {
  const db = createAdminClient();
  return {
    async intent(id) {
      const { data, error } = await db.from("book_checkout_intents")
        .select("id,book_id,reader_id,regime,currency,price_cents_at_checkout,expires_at,stripe_checkout_session_id").eq("id", id).maybeSingle<FrozenPokIntent>();
      if (error) throw new Error("POK_INTENT_READ_FAILED");
      return data;
    },
    async mapping(id) {
      const { data, error } = await db.from("pok_book_checkout_orders").select("*").eq("intent_id", id).maybeSingle<PokMapping>();
      if (error) throw new Error("POK_MAPPING_READ_FAILED");
      return data;
    },
    async claim(row) {
      const { error } = await db.from("pok_book_checkout_orders").insert(row);
      if (error?.code === "23505") return false;
      if (error) throw new Error("POK_CLAIM_FAILED");
      return true;
    },
    async ready(id, claimId, orderId, url) {
      const { data, error } = await db.from("pok_book_checkout_orders")
        .update({ state: "ready", provider_order_id: orderId, checkout_url: url })
        .eq("intent_id", id).eq("creation_claim_id", claimId).eq("state", "creating").select("intent_id").single();
      if (error || !data) throw new Error("POK_LINK_FAILED");
    },
    async reconcile(id, claimId) {
      const { error } = await db.from("pok_book_checkout_orders")
        .update({ state: "needs_reconciliation", last_error_code: "creation_unconfirmed" })
        .eq("intent_id", id).eq("creation_claim_id", claimId).eq("state", "creating");
      if (error) throw new Error("POK_RECONCILIATION_WRITE_FAILED");
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
