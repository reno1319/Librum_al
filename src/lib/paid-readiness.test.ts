import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canPublishPaidTitle,
  canStartPaidCheckout,
  resolvePaidCheckoutMode,
  resolvePaidPublishingMode,
} from "./paid-readiness";
import { STAGING_SUPABASE_URL } from "./protected-staging";
import { PRODUCTION_SUPABASE_PROJECT_REF } from "./supabase/env-guard";

// PAID-MODE-1: the whole truth table of both capabilities, plus the two
// proofs that matter most -- that provider configuration alone enables
// nothing, and that the runtime read set contains no provider variable.
const PUBLISHING_MODE = "controlled_staging_publishing_test";
const CHECKOUT_MODE = "controlled_staging_checkout_test";

// The real production constant, imported from the guard that owns it,
// never a copy of the ref pasted into this file.
const PRODUCTION_SUPABASE_URL = `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;

const protectedStaging = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "staging",
  NEXT_PUBLIC_SUPABASE_URL: STAGING_SUPABASE_URL,
} as const;

// Every payment-provider variable this module must never consult, set
// to a plausible working value, so that any test carrying this object
// proves a denial happened DESPITE a fully configured provider.
const fullyConfiguredProvider = {
  POK_ENVIRONMENT: "staging",
  NEW_CHECKOUT_REGIME: "librum_ledger_v1",
  LEDGER_PAYMENT_PROVIDER: "pok",
  POK_MERCHANT_ID: "22222222-2222-4222-8222-222222222222",
  POK_KEY_ID: "sdk-key-id",
  POK_KEY_SECRET: "test-only",
  STRIPE_SECRET_KEY: "sk_test_dummy",
} as const;

function env(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...protectedStaging, ...extra };
}

afterEach(() => vi.unstubAllEnvs());

describe("paid publishing mode", () => {
  it("allows only the exact value on the exact protected staging deployment", () => {
    expect(resolvePaidPublishingMode(env({ PAID_PUBLISHING_MODE: PUBLISHING_MODE }))).toEqual({
      allowed: true,
      mode: PUBLISHING_MODE,
    });
  });

  it.each([
    ["absent", undefined, "mode_absent"],
    ["empty", "", "mode_absent"],
    ["whitespace only", "   ", "mode_unrecognized"],
    ["leading space", ` ${PUBLISHING_MODE}`, "mode_unrecognized"],
    ["trailing space", `${PUBLISHING_MODE} `, "mode_unrecognized"],
    ["trailing newline", `${PUBLISHING_MODE}\n`, "mode_unrecognized"],
    ["title cased", "Controlled_Staging_Publishing_Test", "mode_unrecognized"],
    ["upper cased", "CONTROLLED_STAGING_PUBLISHING_TEST", "mode_unrecognized"],
    ["quoted", `"${PUBLISHING_MODE}"`, "mode_unrecognized"],
    ["true", "true", "mode_unrecognized"],
    ["1", "1", "mode_unrecognized"],
    ["enabled", "enabled", "mode_unrecognized"],
    ["staging", "staging", "mode_unrecognized"],
    // No Production-capable value exists, and none may be invented in a
    // dashboard: each of these is an unrecognized value, not "some other
    // mode". Widening that is a reviewed type change, never config.
    ["production", "production", "mode_unrecognized"],
    ["production_ready", "production_ready", "mode_unrecognized"],
    ["live", "live", "mode_unrecognized"],
    ["controlled_production", "controlled_production", "mode_unrecognized"],
    ["the old shared v1 value", "controlled_staging_test", "mode_unrecognized"],
    // The wrong variable's value. It is valid SOMEWHERE, which is
    // exactly why it must be unrecognized HERE.
    ["the checkout mode's value", CHECKOUT_MODE, "mode_unrecognized"],
  ])("denies a %s publishing mode", (_label, value, reason) => {
    expect(resolvePaidPublishingMode(env({ PAID_PUBLISHING_MODE: value }))).toEqual({
      allowed: false,
      reason,
    });
  });
});

describe("paid checkout mode", () => {
  it("allows only the exact value on the exact protected staging deployment", () => {
    expect(resolvePaidCheckoutMode(env({ PAID_CHECKOUT_MODE: CHECKOUT_MODE }))).toEqual({
      allowed: true,
      mode: CHECKOUT_MODE,
    });
  });

  it.each([
    ["absent", undefined, "mode_absent"],
    ["empty", "", "mode_absent"],
    ["whitespace only", "   ", "mode_unrecognized"],
    ["leading space", ` ${CHECKOUT_MODE}`, "mode_unrecognized"],
    ["trailing space", `${CHECKOUT_MODE} `, "mode_unrecognized"],
    ["upper cased", "CONTROLLED_STAGING_CHECKOUT_TEST", "mode_unrecognized"],
    ["true", "true", "mode_unrecognized"],
    ["production", "production", "mode_unrecognized"],
    ["live", "live", "mode_unrecognized"],
    ["the old shared v1 value", "controlled_staging_test", "mode_unrecognized"],
    ["the publishing mode's value", PUBLISHING_MODE, "mode_unrecognized"],
  ])("denies a %s checkout mode", (_label, value, reason) => {
    expect(resolvePaidCheckoutMode(env({ PAID_CHECKOUT_MODE: value }))).toEqual({
      allowed: false,
      reason,
    });
  });
});

describe("the two capabilities are independent", () => {
  // Evaluated against ONE env object per case, so a resolver that read
  // the other's variable -- or that shared state between the two --
  // fails here rather than passing by accident.
  it("publishing set, checkout unset: publishing only", () => {
    const e = env({ PAID_PUBLISHING_MODE: PUBLISHING_MODE });
    expect(resolvePaidPublishingMode(e).allowed).toBe(true);
    expect(resolvePaidCheckoutMode(e)).toEqual({ allowed: false, reason: "mode_absent" });
  });

  it("checkout set, publishing unset: checkout only", () => {
    const e = env({ PAID_CHECKOUT_MODE: CHECKOUT_MODE });
    expect(resolvePaidCheckoutMode(e).allowed).toBe(true);
    expect(resolvePaidPublishingMode(e)).toEqual({ allowed: false, reason: "mode_absent" });
  });

  it("both set correctly: both allowed, each with its own mode", () => {
    const e = env({ PAID_PUBLISHING_MODE: PUBLISHING_MODE, PAID_CHECKOUT_MODE: CHECKOUT_MODE });
    expect(resolvePaidPublishingMode(e)).toEqual({ allowed: true, mode: PUBLISHING_MODE });
    expect(resolvePaidCheckoutMode(e)).toEqual({ allowed: true, mode: CHECKOUT_MODE });
  });

  // The residual hazard of two variables in one dashboard: the values
  // are swapped. Neither capability may be enabled by that mistake.
  it("the two values swapped enables NEITHER capability", () => {
    const e = env({ PAID_PUBLISHING_MODE: CHECKOUT_MODE, PAID_CHECKOUT_MODE: PUBLISHING_MODE });
    expect(resolvePaidPublishingMode(e)).toEqual({ allowed: false, reason: "mode_unrecognized" });
    expect(resolvePaidCheckoutMode(e)).toEqual({ allowed: false, reason: "mode_unrecognized" });
  });

  it("one value pasted into both variables enables at most the one it names", () => {
    const publishingInBoth = env({
      PAID_PUBLISHING_MODE: PUBLISHING_MODE,
      PAID_CHECKOUT_MODE: PUBLISHING_MODE,
    });
    expect(resolvePaidPublishingMode(publishingInBoth).allowed).toBe(true);
    expect(resolvePaidCheckoutMode(publishingInBoth)).toEqual({
      allowed: false,
      reason: "mode_unrecognized",
    });

    const checkoutInBoth = env({
      PAID_PUBLISHING_MODE: CHECKOUT_MODE,
      PAID_CHECKOUT_MODE: CHECKOUT_MODE,
    });
    expect(resolvePaidPublishingMode(checkoutInBoth)).toEqual({
      allowed: false,
      reason: "mode_unrecognized",
    });
    expect(resolvePaidCheckoutMode(checkoutInBoth).allowed).toBe(true);
  });
});

describe("environment is decided first, and Production always denies", () => {
  const bothModesSet = {
    PAID_PUBLISHING_MODE: PUBLISHING_MODE,
    PAID_CHECKOUT_MODE: CHECKOUT_MODE,
  };

  it.each([
    [
      "Vercel Production, production Supabase project",
      {
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "staging",
        NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_SUPABASE_URL,
        ...bothModesSet,
      },
    ],
    [
      "Vercel Production forced onto the staging branch and database",
      { ...protectedStaging, VERCEL_ENV: "production", ...bothModesSet },
    ],
    [
      "an ordinary Preview of another branch",
      { ...protectedStaging, VERCEL_GIT_COMMIT_REF: "feat/anything", ...bothModesSet },
    ],
    [
      "a Preview of staging pointed at the wrong Supabase project",
      {
        ...protectedStaging,
        NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_SUPABASE_URL,
        ...bothModesSet,
      },
    ],
    ["a local machine or test runner", { ...bothModesSet }],
  ])("denies both capabilities: %s", (_label, e) => {
    expect(resolvePaidPublishingMode(e)).toEqual({
      allowed: false,
      reason: "environment_not_permitted",
    });
    expect(resolvePaidCheckoutMode(e)).toEqual({
      allowed: false,
      reason: "environment_not_permitted",
    });
  });

  // The requirement this whole module exists for: a completely
  // configured payment provider is not a permission.
  it("a fully configured payment provider with no modes set enables nothing", () => {
    const e = env(fullyConfiguredProvider);
    expect(resolvePaidPublishingMode(e)).toEqual({ allowed: false, reason: "mode_absent" });
    expect(resolvePaidCheckoutMode(e)).toEqual({ allowed: false, reason: "mode_absent" });
  });

  it("a fully configured payment provider in Production enables nothing", () => {
    const e = {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "staging",
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_SUPABASE_URL,
      ...fullyConfiguredProvider,
      ...bothModesSet,
    };
    expect(resolvePaidPublishingMode(e)).toEqual({
      allowed: false,
      reason: "environment_not_permitted",
    });
    expect(resolvePaidCheckoutMode(e)).toEqual({
      allowed: false,
      reason: "environment_not_permitted",
    });
  });
});

// Runtime evidence, not inspection: a Proxy records every key each
// resolver actually touches. This is what proves POK_ENVIRONMENT,
// NEW_CHECKOUT_REGIME, LEDGER_PAYMENT_PROVIDER, every POK_* credential
// and every STRIPE_* value are NEVER READ -- rather than merely never
// named in the source.
function recordReadKeys(
  source: Record<string, string | undefined>,
  run: (env: Record<string, string | undefined>) => unknown,
): string[] {
  const read = new Set<string>();
  const proxy = new Proxy(source, {
    get(target, key, receiver) {
      if (typeof key === "string") read.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  run(proxy);
  return [...read].sort();
}

describe("runtime read set excludes every provider variable", () => {
  const everything = env({
    ...fullyConfiguredProvider,
    PAID_PUBLISHING_MODE: PUBLISHING_MODE,
    PAID_CHECKOUT_MODE: CHECKOUT_MODE,
  });

  it("the publishing resolver reads exactly its own four keys", () => {
    expect(recordReadKeys(everything, resolvePaidPublishingMode)).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "PAID_PUBLISHING_MODE",
      "VERCEL_ENV",
      "VERCEL_GIT_COMMIT_REF",
    ]);
  });

  it("the checkout resolver reads exactly its own four keys", () => {
    expect(recordReadKeys(everything, resolvePaidCheckoutMode)).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "PAID_CHECKOUT_MODE",
      "VERCEL_ENV",
      "VERCEL_GIT_COMMIT_REF",
    ]);
  });

  // Environment before mode: outside protected staging the mode
  // variable is not read at all, so a value set where it does not belong
  // is never even observed.
  it("outside protected staging neither resolver reads any mode variable", () => {
    const production = {
      ...everything,
      VERCEL_ENV: "production",
    };
    expect(recordReadKeys(production, resolvePaidPublishingMode)).toEqual(["VERCEL_ENV"]);
    expect(recordReadKeys(production, resolvePaidCheckoutMode)).toEqual(["VERCEL_ENV"]);
  });
});

describe("the process.env wrappers", () => {
  it("both deny under the test runner's own environment", () => {
    expect(canPublishPaidTitle()).toBe(false);
    expect(canStartPaidCheckout()).toBe(false);
  });

  it("both allow only when the real environment is the protected staging deployment", () => {
    for (const [key, value] of Object.entries(protectedStaging)) vi.stubEnv(key, value);
    expect(canPublishPaidTitle()).toBe(false);
    expect(canStartPaidCheckout()).toBe(false);

    vi.stubEnv("PAID_PUBLISHING_MODE", PUBLISHING_MODE);
    vi.stubEnv("PAID_CHECKOUT_MODE", CHECKOUT_MODE);
    expect(canPublishPaidTitle()).toBe(true);
    expect(canStartPaidCheckout()).toBe(true);

    vi.stubEnv("VERCEL_ENV", "production");
    expect(canPublishPaidTitle()).toBe(false);
    expect(canStartPaidCheckout()).toBe(false);
  });
});
