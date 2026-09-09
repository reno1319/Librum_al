// AUTH-STAGE-1A: fail-closed guard against a non-production Librum
// execution (local dev, local `next build`, tests, or a Vercel
// Preview/Development deployment) ever connecting to the production
// Supabase project, and against a genuine Vercel Production execution
// ever connecting to anything else. See ROADMAP.md Phase 1.
//
// Deliberately a small, pure module with no side effects at import
// time -- every one of the three server-only Supabase client
// constructors (server.ts, admin.ts, middleware.ts) and next.config.ts
// calls assertSupabaseEnvSafeForExecution() explicitly, at the point
// each actually needs a client/build, rather than this module reaching
// into process.env on its own when imported. This keeps the underlying
// logic directly unit-testable with explicit inputs, with no
// environment stubbing required.
//
// NOT called from client.ts (the browser Supabase client): that file's
// createClient() is bundled into browser JavaScript, where none of
// VERCEL/VERCEL_ENV/VERCEL_PROJECT_ID are ever available (only
// NEXT_PUBLIC_-prefixed variables are inlined into a browser bundle --
// see node_modules/next/dist/docs/01-app/02-guides/environment-variables.md).
// Reading an uninlined, non-public env var from browser-bundled code
// does not reliably read as `undefined`; it risks referencing a
// nonexistent `process` global entirely. The real enforcement point for
// that path is upstream, at build time: next.config.ts's top-level call
// to this same guard runs in Node before `next build`/`next dev` ever
// produces or serves a browser bundle, so a disallowed
// NEXT_PUBLIC_SUPABASE_URL can never get baked into one in the first
// place. See next.config.ts's own comment.
export const PRODUCTION_SUPABASE_PROJECT_REF = "pwkukotgpsegieshulpj";

// Supabase project refs are always a 20-character lowercase-alphanumeric
// string, and this app's Supabase URLs are always exactly
// `https://<ref>.supabase.co` -- no other host, subdomain depth, or
// protocol is a Supabase project URL this app recognizes. Anything else
// (missing, empty, unparseable, wrong host, wrong ref shape) is
// deliberately treated as malformed rather than guessed at.
const SUPABASE_URL_PATTERN = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/;

export function parseSupabaseProjectRef(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) return null;
  const match = SUPABASE_URL_PATTERN.exec(rawUrl.trim());
  return match ? match[1] : null;
}

export class UnsafeSupabaseProjectRefError extends Error {}

// AUTH-STAGE-1A security correction (independent patch review, round 2):
// VERCEL/VERCEL_ENV/VERCEL_PROJECT_ID are ordinary environment variables.
// They are defensive identity markers -- signals Vercel's own platform
// sets consistently, that catch accidental misconfiguration (a stray
// VERCEL_ENV=production locally, a copy-pasted env block from the wrong
// project) -- NOT cryptographic proof of anything. Anyone with shell
// access can reproduce any combination of these values locally; this
// guard's job is to fail closed against inconsistent or wrong-project
// combinations, not to authenticate the platform itself.
export const PRODUCTION_VERCEL_PROJECT_ID = "prj_Aox43T7bRLZrB2jlZmtl3ObII3CR";

const VALID_VERCEL_ENVIRONMENTS = new Set(["production", "preview", "development"]);
type VercelEnvironment = "production" | "preview" | "development";

// AUTH-STAGE-1A security correction, round 2: classifying identity and
// deciding which Supabase ref that identity may use are now two
// deliberately separate stages (see assertSupabaseProjectRefAllowed
// below). Splitting them closes a fail-closed gap the single-stage
// version had: previously, wrong/missing/inconsistent Vercel markers
// were only ever checked against the *production* ref -- a request with
// VERCEL=1, a wrong VERCEL_PROJECT_ID, and a perfectly valid
// *non-production* ref sailed through unexamined, because nothing ever
// asked "is this identity even coherent?" independent of which ref was
// supplied. This type makes "the identity itself is malformed" a
// first-class outcome that assertSupabaseProjectRefAllowed rejects
// unconditionally, regardless of which Supabase ref came with it.
export type LibrumExecutionIdentity =
  | { kind: "local" }
  | { kind: "vercel"; vercelEnv: VercelEnvironment }
  | { kind: "invalid" };

function isAbsent(value: string | undefined | null): boolean {
  return value === undefined || value === null || value === "";
}

// Stage 1: classify execution identity from the three Vercel markers
// alone, independent of any Supabase URL.
//
// - All three absent -> "local" (local dev, a local build, most test
//   runners, or any other non-Vercel execution).
// - Any one present -> every one of the following must hold, or the
//   whole identity is "invalid": VERCEL === "1"; VERCEL_PROJECT_ID
//   matches the verified Librum project; VERCEL_ENV is exactly one of
//   "production"/"preview"/"development". A partial match (e.g. VERCEL=1
//   with VERCEL_ENV missing, or the right VERCEL_ENV with the wrong
//   project ID) is never treated as "close enough" -- it's "invalid",
//   the same outcome as having no markers make sense at all.
export function classifyExecutionIdentity(params: {
  vercel: string | undefined | null;
  vercelEnv: string | undefined | null;
  vercelProjectId: string | undefined | null;
}): LibrumExecutionIdentity {
  const allMarkersAbsent =
    isAbsent(params.vercel) && isAbsent(params.vercelEnv) && isAbsent(params.vercelProjectId);

  if (allMarkersAbsent) {
    return { kind: "local" };
  }

  const hasValidVercelEnv =
    typeof params.vercelEnv === "string" && VALID_VERCEL_ENVIRONMENTS.has(params.vercelEnv);

  if (
    params.vercel === "1" &&
    params.vercelProjectId === PRODUCTION_VERCEL_PROJECT_ID &&
    hasValidVercelEnv
  ) {
    return { kind: "vercel", vercelEnv: params.vercelEnv as VercelEnvironment };
  }

  return { kind: "invalid" };
}

// Stage 2 + entry point: validates the Supabase URL, classifies
// execution identity (stage 1), and only then decides whether that
// specific (identity, ref) pairing is allowed. Pure by design: takes
// every input explicitly rather than reading process.env itself, so
// every branch below is directly testable with literal values -- see
// env-guard.test.ts. Never includes the raw URL, ref, or any other
// environment-variable *value* in its thrown message (only fixed,
// non-secret constants and variable *names* are safe to name, since
// none of those are credentials).
export function assertSupabaseProjectRefAllowed(params: {
  supabaseUrl: string | undefined | null;
  vercel: string | undefined | null;
  vercelEnv: string | undefined | null;
  vercelProjectId: string | undefined | null;
}): void {
  const ref = parseSupabaseProjectRef(params.supabaseUrl);

  if (ref === null) {
    throw new UnsafeSupabaseProjectRefError(
      "NEXT_PUBLIC_SUPABASE_URL is missing or is not a recognized Supabase " +
        "project URL (expected https://<project-ref>.supabase.co). Refusing " +
        "to construct a Supabase client without a validated project " +
        "reference -- see ROADMAP.md Phase 1.",
    );
  }

  const identity = classifyExecutionIdentity(params);

  // Rejected unconditionally, before the Supabase ref is even
  // considered: an execution whose VERCEL/VERCEL_ENV/VERCEL_PROJECT_ID
  // markers are present but inconsistent, incomplete, or wrong-project
  // is never safe to trust with ANY Supabase project, production or
  // not -- it means something about this execution's environment is
  // already wrong, and a "helpfully" valid non-production ref must not
  // paper over that.
  if (identity.kind === "invalid") {
    throw new UnsafeSupabaseProjectRefError(
      "This execution's VERCEL, VERCEL_ENV, and VERCEL_PROJECT_ID markers " +
        "are present but do not resolve to a coherent execution identity " +
        "(VERCEL must be exactly \"1\", VERCEL_PROJECT_ID must match the " +
        "verified Librum project, and VERCEL_ENV must be exactly one of " +
        "production/preview/development -- a partial match on some but " +
        "not all of these is treated the same as no match at all). " +
        "Refusing to construct a Supabase client regardless of which " +
        "project NEXT_PUBLIC_SUPABASE_URL names -- see ROADMAP.md Phase 1.",
    );
  }

  const isProductionIdentity = identity.kind === "vercel" && identity.vercelEnv === "production";

  if (isProductionIdentity && ref !== PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new UnsafeSupabaseProjectRefError(
      "This is a genuine Librum Vercel Production execution, but " +
        "NEXT_PUBLIC_SUPABASE_URL does not resolve to the approved " +
        "production Supabase project. Refusing to construct a Supabase " +
        "client -- see ROADMAP.md Phase 1.",
    );
  }

  if (!isProductionIdentity && ref === PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new UnsafeSupabaseProjectRefError(
      "NEXT_PUBLIC_SUPABASE_URL resolves to the production Supabase " +
        "project, but this execution's identity (local development, a " +
        "local build, a test run, or a validated Vercel Preview/" +
        "Development deployment) is not a genuine Librum Vercel " +
        "Production execution. Refusing to construct a Supabase client " +
        "to avoid touching production data -- configure an isolated " +
        "non-production Supabase project instead (see .env.local.example " +
        "and ROADMAP.md Phase 1).",
    );
  }
}

// Thin wrapper real call sites use -- reads the relevant environment
// variables itself so every server-only client constructor doesn't have
// to. Only ever called from server-only code (never from client.ts --
// see this file's top-of-file comment).
export function assertSupabaseEnvSafeForExecution(): void {
  assertSupabaseProjectRefAllowed({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV,
    vercelProjectId: process.env.VERCEL_PROJECT_ID,
  });
}
