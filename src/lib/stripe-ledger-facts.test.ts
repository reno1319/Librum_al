import { describe, expect, it, vi } from "vitest";
import { retrieveStripeLedgerPaymentFacts } from "./stripe-ledger-facts";

// STRIPE-CUTOVER-2A.1 Sections 2-7: proves the adapter is a genuine
// payment-success proof, not merely a paid_at lookup -- it must verify
// PaymentIntent.status and (when present) the Charge's own status/paid
// state before returning ANY fact, and it must source amount/currency
// from the ACTUAL captured/received payment, never a Librum-expected
// value.
describe("retrieveStripeLedgerPaymentFacts", () => {
  it("succeeded PaymentIntent + successful paid Charge: returns ok with charge-sourced facts", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 999999, // deliberately different from the charge's own amount, to prove charge wins
      currency: "usd",
      latest_charge: {
        id: "ch_1",
        status: "succeeded",
        paid: true,
        created: 1_700_000_050,
        amount_captured: 120000,
        currency: "all",
      },
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_1");

    expect(retrieve).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] });
    expect(result).toEqual({
      ok: true,
      paidAt: new Date(1_700_000_050 * 1000),
      actualAmountMinor: 120000,
      actualCurrency: "all",
    });
  });

  it("PaymentIntent.status is not 'succeeded' (e.g. still processing): returns ok:false, no facts extracted", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_2",
      status: "processing",
      created: 1_700_000_000,
      amount_received: 0,
      currency: "usd",
      latest_charge: null,
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_2");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("processing");
  });

  it("PaymentIntent.status is 'requires_action' (e.g. an async/delayed payment method mid-flight): returns ok:false", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_3",
      status: "requires_action",
      created: 1_700_000_000,
      currency: "usd",
      latest_charge: null,
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_3");

    expect(result.ok).toBe(false);
  });

  it("succeeded PaymentIntent but the attached charge is not itself successful/paid: returns ok:false", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_4",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 120000,
      currency: "all",
      latest_charge: { id: "ch_4", status: "pending", paid: false, created: 1_700_000_050, amount_captured: 0, currency: "all" },
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_4");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a successful, paid charge");
  });

  it("succeeded PaymentIntent, charge succeeded but paid=false: returns ok:false (both must hold)", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_5",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 120000,
      currency: "all",
      latest_charge: { id: "ch_5", status: "succeeded", paid: false, created: 1_700_000_050, amount_captured: 120000, currency: "all" },
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_5");

    expect(result.ok).toBe(false);
  });

  it("succeeded PaymentIntent with NO attached charge: falls back to PaymentIntent-level facts", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_6",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 120000,
      currency: "all",
      latest_charge: null,
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_6");

    expect(result).toEqual({
      ok: true,
      paidAt: new Date(1_700_000_000 * 1000),
      actualAmountMinor: 120000,
      actualCurrency: "all",
    });
  });

  it("latest_charge present only as an unexpanded string id: treated the same as no charge (falls back to PaymentIntent facts)", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_7",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 120000,
      currency: "all",
      latest_charge: "ch_7",
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_7");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actualAmountMinor).toBe(120000);
  });

  it("no usable actual amount (neither charge.amount_captured nor amount_received is a positive number): returns ok:false", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_8",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 0,
      currency: "all",
      latest_charge: null,
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_8");

    expect(result.ok).toBe(false);
  });

  it("no usable currency: returns ok:false", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_9",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 120000,
      currency: null,
      latest_charge: null,
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_9");

    expect(result.ok).toBe(false);
  });

  it("no usable paid_at timestamp: returns ok:false", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_10",
      status: "succeeded",
      created: null,
      amount_received: 120000,
      currency: "all",
      latest_charge: null,
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_10");

    expect(result.ok).toBe(false);
  });

  it("never substitutes a Librum-expected amount -- the returned actualAmountMinor is exactly the charge's amount_captured, independent of any external expectation", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_11",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 999,
      currency: "all",
      latest_charge: { id: "ch_11", status: "succeeded", paid: true, created: 1_700_000_050, amount_captured: 55000, currency: "all" },
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_11");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actualAmountMinor).toBe(55000);
      expect(result.actualAmountMinor).not.toBe(999);
    }
  });

  it("a retrieval failure propagates (throws) rather than being swallowed -- caller must fail closed", async () => {
    const retrieve = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(
      retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_12"),
    ).rejects.toThrow("network error");
  });

  it("an unrecognized charge.status string is treated as unsuccessful, never assumed safe", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_13",
      status: "succeeded",
      created: 1_700_000_000,
      amount_received: 120000,
      currency: "all",
      latest_charge: { id: "ch_13", status: "some_future_stripe_status", paid: true, created: 1_700_000_050, amount_captured: 120000, currency: "all" },
    });

    const result = await retrieveStripeLedgerPaymentFacts({ paymentIntents: { retrieve } } as never, "pi_13");

    expect(result.ok).toBe(false);
  });
});
