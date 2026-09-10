// PHASE-1C: an INDEPENDENT production-ref guard for the staging fixture
// CLI scripts -- deliberately NOT the same trust model as
// src/lib/supabase/env-guard.ts's assertSupabaseEnvSafeForExecution().
// That guard's entire identity model is built on Vercel platform
// markers (VERCEL/VERCEL_ENV/VERCEL_PROJECT_ID), which a locally-run
// Node CLI script never has -- under that guard's own logic, a script
// with no Vercel markers classifies as `{kind: "local"}`, which is
// ALLOWED to use any non-production ref, including one a human merely
// believes is staging. That's correct for the application; it is not
// strong enough for a script whose entire purpose is a destructive-
// capable bulk write/delete. See the PHASE-1C design report's section 6
// for the full reasoning.
//
// This module reuses ONLY the pure, already-tested parseSupabaseProjectRef()
// function and the PRODUCTION_SUPABASE_PROJECT_REF constant from
// env-guard.ts (both safe to reuse: a pure regex parser and a named
// constant, neither carrying any Vercel-identity trust assumption) via a
// RELATIVE import with an explicit .ts extension -- confirmed in the
// PHASE-1C design review that env-guard.ts itself has zero further
// imports, so this stays resolvable under plain
// `node --experimental-strip-types` with no bundler and no `@/` alias.
import {
  parseSupabaseProjectRef,
  PRODUCTION_SUPABASE_PROJECT_REF,
} from "../../src/lib/supabase/env-guard.ts";

export { PRODUCTION_SUPABASE_PROJECT_REF };

// The one and only Supabase project ref these scripts are ever allowed
// to target. An allowlist of exactly one -- "not production" is
// necessary but not sufficient; a third, unrecognized project must be
// rejected just as hard as production would be.
export const STAGING_SUPABASE_PROJECT_REF = "erhzpapqwyfjotliqdjo";

export class UnsafeStagingTargetError extends Error {}

// Never includes the raw URL or ref VALUE in its thrown message -- only
// fixed, non-secret constants -- matching env-guard.ts's own established
// discipline (see that file's top-of-file comment).
export function assertStagingTarget(supabaseUrl: string | undefined | null): string {
  const ref = parseSupabaseProjectRef(supabaseUrl);

  if (ref === null) {
    throw new UnsafeStagingTargetError(
      "Target Supabase URL is missing or is not a recognized Supabase project " +
        "URL (expected https://<project-ref>.supabase.co). Refusing to " +
        "construct any Supabase client -- see scripts/staging-fixtures/README.md.",
    );
  }

  // Checked unconditionally, independent of the staging allowlist below
  // -- this must never be "close enough to pass" logic.
  if (ref === PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new UnsafeStagingTargetError(
      "Target Supabase URL resolves to the PRODUCTION project. Refusing to " +
        "construct any Supabase client. This is a hard, unconditional " +
        "rejection -- see scripts/staging-fixtures/README.md.",
    );
  }

  if (ref !== STAGING_SUPABASE_PROJECT_REF) {
    throw new UnsafeStagingTargetError(
      "Target Supabase URL does not resolve to the approved staging project " +
        "(an allowlist of exactly one ref). Refusing to construct any " +
        "Supabase client for an unrecognized third project -- see " +
        "scripts/staging-fixtures/README.md.",
    );
  }

  return ref;
}

// Thin env-reading wrapper the real CLI entry points use. Deliberately
// separate from assertStagingTarget() (a pure function taking an
// explicit input) so every branch above stays directly unit-testable
// with literal values -- see guard.test.ts.
export function assertStagingTargetFromEnv(): string {
  return assertStagingTarget(process.env.STAGING_FIXTURE_SUPABASE_URL);
}
