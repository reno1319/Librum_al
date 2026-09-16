import { describe, expect, it } from "vitest";
import {
  resolveCheckoutRegime,
  resolveLedgerPaymentProvider,
  resolveActiveCheckoutProvider,
  isStripeSecretKeyTestMode,
  isStripeEventTestMode,
} from "./checkout-regime";

describe("resolveLedgerPaymentProvider", () => {
  it("POK requires an exact explicit opt-in", () => expect(resolveLedgerPaymentProvider("pok")).toBe("pok"));
  it.each([undefined, "", "stripe", "POK", " pok", "other"])("preserves the legacy default for %s", raw => {
    expect(resolveLedgerPaymentProvider(raw)).toBe("stripe");
  });
});

// STRIPE-CUTOVER-2A Section 31: the regime selector is the single point
// that decides whether a NEW checkout freezes as legacy or ledger_v1.
// Every case here matters for Section 28's production-default guarantee
// -- an unrecognized/absent env value must never accidentally resolve to
// the ledger regime.
describe("resolveCheckoutRegime", () => {
  it("missing (undefined) resolves to legacy", () => {
    expect(resolveCheckoutRegime(undefined)).toBe("legacy_stripe_connect_v1");
  });

  it("empty string resolves to legacy", () => {
    expect(resolveCheckoutRegime("")).toBe("legacy_stripe_connect_v1");
  });

  it("an invalid/unrecognized value resolves to legacy", () => {
    expect(resolveCheckoutRegime("not_a_real_regime")).toBe("legacy_stripe_connect_v1");
  });

  it("the exact legacy string resolves to legacy", () => {
    expect(resolveCheckoutRegime("legacy_stripe_connect_v1")).toBe("legacy_stripe_connect_v1");
  });

  it("the exact ledger_v1 string resolves to ledger_v1", () => {
    expect(resolveCheckoutRegime("librum_ledger_v1")).toBe("librum_ledger_v1");
  });

  it("whitespace is NOT trimmed -- a leading/trailing space is treated as unrecognized and resolves to legacy", () => {
    expect(resolveCheckoutRegime(" librum_ledger_v1")).toBe("legacy_stripe_connect_v1");
    expect(resolveCheckoutRegime("librum_ledger_v1 ")).toBe("legacy_stripe_connect_v1");
    expect(resolveCheckoutRegime("  ")).toBe("legacy_stripe_connect_v1");
  });

  it("case sensitivity is explicit -- any casing other than the exact lowercase string is unrecognized and resolves to legacy", () => {
    expect(resolveCheckoutRegime("LIBRUM_LEDGER_V1")).toBe("legacy_stripe_connect_v1");
    expect(resolveCheckoutRegime("Librum_Ledger_V1")).toBe("legacy_stripe_connect_v1");
    expect(resolveCheckoutRegime("LEGACY_STRIPE_CONNECT_V1")).toBe("legacy_stripe_connect_v1");
  });
});

// STRIPE-DISABLE-1: exhaustive input matrix -- every combination must
// resolve to "disabled" except the one exact pair (librum_ledger_v1,
// pok). "stripe" must never be a possible output of this function.
describe("resolveActiveCheckoutProvider", () => {
  it("the exact enabled pair resolves to pok", () => {
    expect(
      resolveActiveCheckoutProvider({
        newCheckoutRegime: "librum_ledger_v1",
        ledgerPaymentProvider: "pok",
      }),
    ).toBe("pok");
  });

  const disabledCases: Array<[string, string | undefined, string | undefined]> = [
    ["both missing", undefined, undefined],
    ["both empty", "", ""],
    ["legacy regime + pok provider", "legacy_stripe_connect_v1", "pok"],
    ["ledger regime + missing provider", "librum_ledger_v1", undefined],
    ["ledger regime + empty provider", "librum_ledger_v1", ""],
    ["ledger regime + explicit stripe provider", "librum_ledger_v1", "stripe"],
    ["ledger regime + wrong-case provider", "librum_ledger_v1", "POK"],
    ["ledger regime + whitespace provider", "librum_ledger_v1", " pok"],
    ["ledger regime + unrecognized provider", "librum_ledger_v1", "other"],
    ["missing regime + pok provider", undefined, "pok"],
    ["empty regime + pok provider", "", "pok"],
    ["wrong-case regime + pok provider", "LIBRUM_LEDGER_V1", "pok"],
    ["whitespace regime + pok provider", " librum_ledger_v1", "pok"],
    ["unrecognized regime + pok provider", "not_a_real_regime", "pok"],
    ["legacy regime + stripe provider (pre-cutover default)", "legacy_stripe_connect_v1", "stripe"],
    ["legacy regime + missing provider (pre-cutover default)", "legacy_stripe_connect_v1", undefined],
  ];

  it.each(disabledCases)("%s resolves to disabled", (_label, regime, provider) => {
    expect(
      resolveActiveCheckoutProvider({ newCheckoutRegime: regime, ledgerPaymentProvider: provider }),
    ).toBe("disabled");
  });

  it("never returns \"stripe\" for any input in this matrix", () => {
    const regimes = [undefined, "", "legacy_stripe_connect_v1", "librum_ledger_v1", "LIBRUM_LEDGER_V1", "garbage"];
    const providers = [undefined, "", "pok", "stripe", "POK", " pok", "garbage"];
    for (const regime of regimes) {
      for (const provider of providers) {
        const result = resolveActiveCheckoutProvider({ newCheckoutRegime: regime, ledgerPaymentProvider: provider });
        expect(result).not.toBe("stripe");
      }
    }
  });
});

describe("isStripeSecretKeyTestMode", () => {
  it("undefined resolves to false (fail closed)", () => {
    expect(isStripeSecretKeyTestMode(undefined)).toBe(false);
  });

  it("empty string resolves to false", () => {
    expect(isStripeSecretKeyTestMode("")).toBe(false);
  });

  it("a live secret key resolves to false", () => {
    expect(isStripeSecretKeyTestMode("sk_live_abc123")).toBe(false);
  });

  it("a test secret key resolves to true", () => {
    expect(isStripeSecretKeyTestMode("sk_test_abc123")).toBe(true);
  });

  it("a restricted test key resolves to true", () => {
    expect(isStripeSecretKeyTestMode("rk_test_abc123")).toBe(true);
  });

  it("a restricted live key resolves to false", () => {
    expect(isStripeSecretKeyTestMode("rk_live_abc123")).toBe(false);
  });

  it("an unrecognized key shape resolves to false", () => {
    expect(isStripeSecretKeyTestMode("not_a_stripe_key")).toBe(false);
  });
});

describe("isStripeEventTestMode", () => {
  it("livemode false resolves to true", () => {
    expect(isStripeEventTestMode({ livemode: false })).toBe(true);
  });

  it("livemode true resolves to false", () => {
    expect(isStripeEventTestMode({ livemode: true })).toBe(false);
  });
});
