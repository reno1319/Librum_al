// PAID-MODE-1: the provider-neutral answer to one question -- "is this
// execution the exact, protected Librum staging deployment?" -- and
// nothing else. It is deliberately NOT a readiness, permission, or
// payment-provider decision: it identifies a deployment, and callers
// compose it with whatever further condition they own (see
// assertPokStaging in src/lib/pok.ts, and the two resolvers in
// src/lib/paid-readiness.ts).
//
// Provider-neutral means exactly what it says: this module never reads
// POK_ENVIRONMENT, NEW_CHECKOUT_REGIME, LEDGER_PAYMENT_PROVIDER, any
// POK_* credential, or any STRIPE_* value, and never imports a provider
// adapter. That is structural, not a convention -- the read set is
// asserted at runtime in protected-staging.test.ts and
// paid-readiness.test.ts, so a later edit that reached for a provider
// variable would fail a test rather than pass review.
//
// Pure by design, in the same shape as classifyExecutionIdentity
// (src/lib/supabase/env-guard.ts): it takes the environment explicitly
// rather than reading process.env itself, so every branch is directly
// testable with literal values and the set of keys it touches is
// observable.
//
// These three markers are ordinary environment variables Vercel's own
// platform sets, NOT cryptographic proof of anything -- the same
// caveat env-guard.ts already states about VERCEL/VERCEL_ENV/
// VERCEL_PROJECT_ID. Anyone with shell access can reproduce any
// combination locally. Their job here is to fail closed against an
// accidental or partial match, never to authenticate the platform.
export const STAGING_SUPABASE_PROJECT_REF = "erhzpapqwyfjotliqdjo";
export const STAGING_SUPABASE_URL = `https://${STAGING_SUPABASE_PROJECT_REF}.supabase.co`;

// The branch a protected-staging deployment is built from. The active
// staging ruleset protects it against ordinary force-push and deletion,
// which is what makes this condition worth anything at all -- but not
// absolutely: repository administrators retain the recovery bypass that
// ruleset deliberately configures, so this is a guard against accident
// and drift, not a claim that the branch cannot be moved by anyone.
export const PROTECTED_STAGING_BRANCH = "staging";

// All three conditions, exact and case-sensitive. A partial match is
// never "close enough": a Preview build of some other branch against
// the staging database, or a build of `staging` pointed at a different
// Supabase project, is NOT the protected staging deployment and this
// returns false for both.
export function isProtectedStagingDeployment(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env.VERCEL_ENV === "preview" &&
    env.VERCEL_GIT_COMMIT_REF === PROTECTED_STAGING_BRANCH &&
    env.NEXT_PUBLIC_SUPABASE_URL === STAGING_SUPABASE_URL
  );
}
