import { describe, expect, it } from "vitest";
import {
  isProtectedStagingDeployment,
  PROTECTED_STAGING_BRANCH,
  STAGING_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_URL,
} from "./protected-staging";
import { PRODUCTION_SUPABASE_PROJECT_REF } from "./supabase/env-guard";

// PAID-MODE-1: the neutral predicate's entire contract -- exactly three
// conditions, every single-field miss fails closed, and no payment
// provider variable is an input to any of it.
const protectedStaging: Record<string, string | undefined> = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "staging",
  NEXT_PUBLIC_SUPABASE_URL: STAGING_SUPABASE_URL,
};

describe("isProtectedStagingDeployment: the exact protected staging deployment", () => {
  it("accepts exactly the three-condition protected staging environment", () => {
    expect(isProtectedStagingDeployment(protectedStaging)).toBe(true);
  });

  it("derives the staging URL from the staging project ref", () => {
    expect(STAGING_SUPABASE_URL).toBe(`https://${STAGING_SUPABASE_PROJECT_REF}.supabase.co`);
    expect(PROTECTED_STAGING_BRANCH).toBe("staging");
  });

  // The staging and production Supabase projects are compared against
  // the REAL production constant, imported from the guard that owns it
  // -- never a copy of the ref pasted into this file.
  it("never names the production Supabase project", () => {
    expect(STAGING_SUPABASE_PROJECT_REF).not.toBe(PRODUCTION_SUPABASE_PROJECT_REF);
    expect(STAGING_SUPABASE_URL).not.toContain(PRODUCTION_SUPABASE_PROJECT_REF);
  });

  it.each([
    ["empty environment", {}],
    ["VERCEL_ENV absent", { ...protectedStaging, VERCEL_ENV: undefined }],
    ["VERCEL_ENV production", { ...protectedStaging, VERCEL_ENV: "production" }],
    ["VERCEL_ENV development", { ...protectedStaging, VERCEL_ENV: "development" }],
    ["VERCEL_ENV wrongly cased", { ...protectedStaging, VERCEL_ENV: "Preview" }],
    ["VERCEL_ENV padded", { ...protectedStaging, VERCEL_ENV: " preview" }],
    ["branch absent", { ...protectedStaging, VERCEL_GIT_COMMIT_REF: undefined }],
    ["another branch", { ...protectedStaging, VERCEL_GIT_COMMIT_REF: "feat/pok-payments" }],
    ["branch wrongly cased", { ...protectedStaging, VERCEL_GIT_COMMIT_REF: "Staging" }],
    ["branch padded", { ...protectedStaging, VERCEL_GIT_COMMIT_REF: "staging " }],
    ["supabase url absent", { ...protectedStaging, NEXT_PUBLIC_SUPABASE_URL: undefined }],
    ["supabase url empty", { ...protectedStaging, NEXT_PUBLIC_SUPABASE_URL: "" }],
    [
      "production supabase project",
      {
        ...protectedStaging,
        NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`,
      },
    ],
    [
      "staging ref on the wrong host",
      {
        ...protectedStaging,
        NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_SUPABASE_PROJECT_REF}.supabase.co.evil.com`,
      },
    ],
    [
      "staging url with a trailing slash",
      { ...protectedStaging, NEXT_PUBLIC_SUPABASE_URL: `${STAGING_SUPABASE_URL}/` },
    ],
  ])("fails closed: %s", (_label, env) => {
    expect(isProtectedStagingDeployment(env as Record<string, string | undefined>)).toBe(false);
  });

  // The predicate is provider-neutral by construction, and this is the
  // behavioural proof rather than a comment: POK's own environment
  // variable is not an input to it in either direction. assertPokStaging
  // (pok.ts) supplies that fourth condition itself -- see pok.test.ts,
  // which still passes unchanged.
  it.each([
    ["absent", undefined],
    ["staging", "staging"],
    ["production", "production"],
  ])("is unaffected by POK_ENVIRONMENT=%s", (_label, pokEnvironment) => {
    expect(
      isProtectedStagingDeployment({ ...protectedStaging, POK_ENVIRONMENT: pokEnvironment }),
    ).toBe(true);
  });

  it("is unaffected by a fully configured payment provider outside protected staging", () => {
    expect(
      isProtectedStagingDeployment({
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "staging",
        NEXT_PUBLIC_SUPABASE_URL: STAGING_SUPABASE_URL,
        POK_ENVIRONMENT: "staging",
        NEW_CHECKOUT_REGIME: "librum_ledger_v1",
        LEDGER_PAYMENT_PROVIDER: "pok",
        POK_MERCHANT_ID: "merchant",
        POK_KEY_ID: "key",
        POK_KEY_SECRET: "secret",
        STRIPE_SECRET_KEY: "sk_test_x",
      }),
    ).toBe(false);
  });
});
