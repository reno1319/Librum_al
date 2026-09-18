import "server-only";
import { isProtectedStagingDeployment } from "@/lib/protected-staging";

// PAID-MODE-1: whether Librum is permitted to let an author publish a
// PAID title, and whether it is permitted to start a PAID checkout, as
// two separate, provider-neutral product permissions.
//
// This module is not a payment-provider decision and must never become
// one. It never reads POK_ENVIRONMENT, NEW_CHECKOUT_REGIME,
// LEDGER_PAYMENT_PROVIDER, any POK_* credential or any STRIPE_* value,
// and it imports nothing but `server-only` and the neutral deployment
// predicate. A fully configured payment provider therefore enables
// NOTHING here on its own -- which is the whole point: until this PR,
// provider configuration alone was the only thing deciding whether
// Librum took a reader's money.
//
// WHAT THIS DOES NOT CLAIM. It does not claim that fulfilment, refunds,
// author payouts or Production commerce are ready. None of them are. It
// creates a controlled-staging-test permission and nothing else. The
// only two modes that exist are reachable ONLY on the exact protected
// staging deployment, and neither is, or may ever be read as, a step
// toward Production enablement. A future Production-enablement change
// must introduce a DISTINCT Production-capable value with REACHABLE
// obligation checks gating it; it may not widen, reinterpret or quietly
// reuse either mode below. Each type has exactly one member precisely so
// that any such attempt is a visible type change in a reviewed diff.
export type PaidPublishingMode = "controlled_staging_publishing_test";
export type PaidCheckoutMode = "controlled_staging_checkout_test";

// Deliberately two separate one-member types, never one shared union:
// the two capabilities cannot be conflated by a later edit, and a value
// pasted into the wrong variable is not "the other mode", it is an
// unrecognized value that enables nothing.
const CONTROLLED_STAGING_PUBLISHING_TEST: PaidPublishingMode = "controlled_staging_publishing_test";
const CONTROLLED_STAGING_CHECKOUT_TEST: PaidCheckoutMode = "controlled_staging_checkout_test";

export type PaidCapabilityDenial =
  // not the exact protected staging deployment -- decided before the
  // mode variable is read at all
  | "environment_not_permitted"
  // the mode variable is unset or empty
  | "mode_absent"
  // the mode variable is present but is not the exact literal
  | "mode_unrecognized";

export type PaidPublishingCapability =
  | { allowed: true; mode: PaidPublishingMode }
  | { allowed: false; reason: PaidCapabilityDenial };

export type PaidCheckoutCapability =
  | { allowed: true; mode: PaidCheckoutMode }
  | { allowed: false; reason: PaidCapabilityDenial };

// Exact, case-sensitive, untrimmed equality only -- the same rule
// resolveMaintenanceMode (maintenance-mode.ts) and resolveCheckoutRegime
// (checkout-regime.ts) already apply, and for the same reason:
// "Controlled_Staging_Publishing_Test", " controlled_staging_publishing_test"
// (leading space), "true", "1", "enabled" and "production" are all
// near-misses, and silently coercing a near-miss into the enabled state
// is exactly the class of accident that could open a paid path nobody
// meant to open.
//
// Environment first, mode second, in both resolvers: a deployment that
// is not protected staging is denied WITHOUT its mode variable ever
// being read. Setting either variable somewhere it does not belong
// therefore cannot even be observed by this code, let alone honoured.
export function resolvePaidPublishingMode(
  env: Record<string, string | undefined>,
): PaidPublishingCapability {
  if (!isProtectedStagingDeployment(env)) {
    return { allowed: false, reason: "environment_not_permitted" };
  }
  const raw = env.PAID_PUBLISHING_MODE;
  if (raw === undefined || raw === "") {
    return { allowed: false, reason: "mode_absent" };
  }
  if (raw !== CONTROLLED_STAGING_PUBLISHING_TEST) {
    return { allowed: false, reason: "mode_unrecognized" };
  }
  return { allowed: true, mode: CONTROLLED_STAGING_PUBLISHING_TEST };
}

// A separate function, not one parameterised function called twice, so
// the two capabilities cannot be coupled by a later edit and neither
// resolver can ever read the other's variable.
export function resolvePaidCheckoutMode(
  env: Record<string, string | undefined>,
): PaidCheckoutCapability {
  if (!isProtectedStagingDeployment(env)) {
    return { allowed: false, reason: "environment_not_permitted" };
  }
  const raw = env.PAID_CHECKOUT_MODE;
  if (raw === undefined || raw === "") {
    return { allowed: false, reason: "mode_absent" };
  }
  if (raw !== CONTROLLED_STAGING_CHECKOUT_TEST) {
    return { allowed: false, reason: "mode_unrecognized" };
  }
  return { allowed: true, mode: CONTROLLED_STAGING_CHECKOUT_TEST };
}

// The thin process.env wrappers real call sites use -- the same split
// env-guard.ts uses between its pure decision functions and
// assertSupabaseEnvSafeForExecution(). Server-only, never overridable by
// request input (query/body/cookie), and never exposed to the browser:
// neither variable carries a NEXT_PUBLIC_ prefix, so neither is inlined
// into any client bundle.
export function canPublishPaidTitle(): boolean {
  return resolvePaidPublishingMode(process.env).allowed;
}

export function canStartPaidCheckout(): boolean {
  return resolvePaidCheckoutMode(process.env).allowed;
}
