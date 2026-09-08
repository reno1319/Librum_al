// STRIPE-CUTOVER-2A: the single, server-only source of truth for which
// checkout regime a NEWLY-created book/bundle checkout freezes into.
// Never imported into any client component, never exposed to the
// browser, and never overridable by request input (query/body/cookie) --
// the only input this ever reads is the server's own NEW_CHECKOUT_REGIME
// env var. Once a checkout row exists, ITS OWN frozen `regime` column
// (migration 056) is authoritative forever; this selector only ever
// governs the moment a fresh row is created.
export type CheckoutRegime = "legacy_stripe_connect_v1" | "librum_ledger_v1";

const LEGACY_REGIME: CheckoutRegime = "legacy_stripe_connect_v1";
const LEDGER_V1_REGIME: CheckoutRegime = "librum_ledger_v1";

// PRE-CUTOVER default (Section 3/28): missing, empty, whitespace-only,
// wrongly-cased, or any other unrecognized value all resolve to legacy.
// This is the entire mechanism behind Section 28's hard acceptance
// criterion -- merely deploying this code with NEW_CHECKOUT_REGIME unset
// must be a complete no-op for production checkout behavior. Exact,
// case-sensitive, untrimmed string match only: neither
// "Librum_Ledger_V1" nor " librum_ledger_v1" (leading space) is coerced
// into the ledger regime -- silently tolerating a near-miss here is
// exactly the class of accident that could activate real ledger_v1
// commerce from a typo'd env value.
export function resolveCheckoutRegime(raw: string | undefined): CheckoutRegime {
  if (raw === LEDGER_V1_REGIME) return LEDGER_V1_REGIME;
  return LEGACY_REGIME;
}

// Smallest robust, non-client-trusting test-mode proof available at
// checkout-CREATION time. Stripe secret keys are always sk_test_... /
// sk_live_... (restricted keys: rk_test_.../rk_live_...) -- a purely
// server-side configuration value, never influenced by the browser or
// by any request input, so it cannot be spoofed by a caller the way a
// client-supplied "test" flag could be. This is the FIRST of the two
// reachable stages Section 4 requires protection at.
export function isStripeSecretKeyTestMode(secretKey: string | undefined): boolean {
  if (!secretKey) return false;
  return secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_");
}

// The SECOND reachable stage (Section 4): genuine test-mode proof is
// only available later, once Stripe itself has returned a verified
// object. `event.livemode` is part of the SIGNED webhook payload Stripe
// just verified (constructStripeEventFromApprovedSecrets) -- not
// anything this app derived and not anything a caller supplied -- so it
// is the authoritative, non-spoofable confirmation that THIS SPECIFIC
// delivery genuinely originated in Stripe's test mode. Checked again
// here, independently of the checkout-creation-time key check above,
// because the two checks protect two different moments and neither
// implies the other (e.g. STRIPE_SECRET_KEY could theoretically change
// between checkout creation and webhook delivery).
export function isStripeEventTestMode(event: { livemode: boolean }): boolean {
  return event.livemode === false;
}
