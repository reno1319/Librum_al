import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_SUPABASE_PROJECT_REF,
  PRODUCTION_VERCEL_PROJECT_ID,
  UnsafeSupabaseProjectRefError,
  assertSupabaseProjectRefAllowed,
  classifyExecutionIdentity,
  parseSupabaseProjectRef,
} from "./env-guard";

// An obviously fabricated, syntactically valid 20-character
// lowercase-alphanumeric ref. It is not any real Librum project ref;
// it only represents a generic non-production Supabase project.
const NON_PRODUCTION_REF = "abcdefghijklmnopqrst";
const PRODUCTION_URL = `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;
const NON_PRODUCTION_URL = `https://${NON_PRODUCTION_REF}.supabase.co`;

// Shorthand for the exact, all-agreeing identity markers of a genuine
// Librum Vercel Production execution.
const GENUINE_PRODUCTION_IDENTITY = {
  vercel: "1",
  vercelEnv: "production",
  vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
} as const;

const NO_VERCEL_MARKERS = {
  vercel: undefined,
  vercelEnv: undefined,
  vercelProjectId: undefined,
} as const;

const PREVIEW_IDENTITY = {
  vercel: "1",
  vercelEnv: "preview",
  vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
} as const;

describe("parseSupabaseProjectRef", () => {
  it("extracts the ref from a well-formed Supabase URL", () => {
    expect(parseSupabaseProjectRef(PRODUCTION_URL)).toBe(PRODUCTION_SUPABASE_PROJECT_REF);
    expect(parseSupabaseProjectRef(NON_PRODUCTION_URL)).toBe(NON_PRODUCTION_REF);
  });

  it("tolerates a trailing slash", () => {
    expect(parseSupabaseProjectRef(`${NON_PRODUCTION_URL}/`)).toBe(NON_PRODUCTION_REF);
  });

  it("returns null for missing/empty/undefined/null input", () => {
    expect(parseSupabaseProjectRef(undefined)).toBeNull();
    expect(parseSupabaseProjectRef(null)).toBeNull();
    expect(parseSupabaseProjectRef("")).toBeNull();
  });

  it("returns null for a non-Supabase host", () => {
    expect(parseSupabaseProjectRef(`https://${NON_PRODUCTION_REF}.evil.com`)).toBeNull();
    expect(parseSupabaseProjectRef("https://supabase.co")).toBeNull();
  });

  it("returns null for http:// (never https)", () => {
    expect(parseSupabaseProjectRef(`http://${NON_PRODUCTION_REF}.supabase.co`)).toBeNull();
  });

  it("returns null for a ref of the wrong length or shape", () => {
    expect(parseSupabaseProjectRef("https://tooshort.supabase.co")).toBeNull();
    expect(parseSupabaseProjectRef("https://UPPERCASEREFXXXXXXXX.supabase.co")).toBeNull();
    expect(parseSupabaseProjectRef(`https://${NON_PRODUCTION_REF}-extra.supabase.co`)).toBeNull();
  });

  it("returns null for garbage/non-URL strings", () => {
    expect(parseSupabaseProjectRef("not a url at all")).toBeNull();
    expect(parseSupabaseProjectRef("supabase.co")).toBeNull();
  });
});

describe("classifyExecutionIdentity", () => {
  it("all three markers absent -> local", () => {
    expect(classifyExecutionIdentity(NO_VERCEL_MARKERS)).toEqual({ kind: "local" });
  });

  it("genuine production markers -> vercel/production", () => {
    expect(classifyExecutionIdentity(GENUINE_PRODUCTION_IDENTITY)).toEqual({
      kind: "vercel",
      vercelEnv: "production",
    });
  });

  it("genuine preview markers -> vercel/preview", () => {
    expect(classifyExecutionIdentity(PREVIEW_IDENTITY)).toEqual({
      kind: "vercel",
      vercelEnv: "preview",
    });
  });

  it("genuine development markers -> vercel/development", () => {
    expect(
      classifyExecutionIdentity({
        vercel: "1",
        vercelEnv: "development",
        vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
      }),
    ).toEqual({ kind: "vercel", vercelEnv: "development" });
  });

  it("wrong VERCEL_PROJECT_ID with otherwise-valid markers -> invalid", () => {
    expect(
      classifyExecutionIdentity({
        vercel: "1",
        vercelEnv: "production",
        vercelProjectId: "prj_some_other_project_entirely",
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("missing VERCEL_PROJECT_ID while other markers exist -> invalid", () => {
    expect(
      classifyExecutionIdentity({
        vercel: "1",
        vercelEnv: "production",
        vercelProjectId: undefined,
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("VERCEL=1 with missing VERCEL_ENV -> invalid", () => {
    expect(
      classifyExecutionIdentity({
        vercel: "1",
        vercelEnv: undefined,
        vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("VERCEL_ENV present with VERCEL absent -> invalid", () => {
    expect(
      classifyExecutionIdentity({
        vercel: undefined,
        vercelEnv: "production",
        vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("VERCEL_ENV set to an unrecognized value -> invalid", () => {
    expect(
      classifyExecutionIdentity({
        vercel: "1",
        vercelEnv: "staging",
        vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("VERCEL set to something other than exactly \"1\" -> invalid", () => {
    expect(
      classifyExecutionIdentity({
        vercel: "true",
        vercelEnv: "production",
        vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
      }),
    ).toEqual({ kind: "invalid" });
  });
});

describe("assertSupabaseProjectRefAllowed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exact genuine Librum production identity + production Supabase: allowed", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: PRODUCTION_URL, ...GENUINE_PRODUCTION_IDENTITY }),
    ).not.toThrow();
  });

  it("production Supabase + VERCEL_ENV=production but VERCEL missing: rejected", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({
        supabaseUrl: PRODUCTION_URL,
        vercel: undefined,
        vercelEnv: "production",
        vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
      }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  it("production Supabase + wrong VERCEL_PROJECT_ID: rejected", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({
        supabaseUrl: PRODUCTION_URL,
        vercel: "1",
        vercelEnv: "production",
        vercelProjectId: "prj_some_other_project_entirely",
      }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  it("production Supabase + missing VERCEL_PROJECT_ID: rejected", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({
        supabaseUrl: PRODUCTION_URL,
        vercel: "1",
        vercelEnv: "production",
        vercelProjectId: undefined,
      }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  it("genuine production identity + non-production Supabase: rejected", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: NON_PRODUCTION_URL, ...GENUINE_PRODUCTION_IDENTITY }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  it("correct Librum Preview identity + non-production Supabase: allowed", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: NON_PRODUCTION_URL, ...PREVIEW_IDENTITY }),
    ).not.toThrow();
  });

  it("correct Librum Preview identity + production Supabase: rejected", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: PRODUCTION_URL, ...PREVIEW_IDENTITY }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  it("local/no Vercel markers + non-production Supabase: allowed", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: NON_PRODUCTION_URL, ...NO_VERCEL_MARKERS }),
    ).not.toThrow();
  });

  it("local/no Vercel markers + production Supabase: rejected", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: PRODUCTION_URL, ...NO_VERCEL_MARKERS }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  // The fail-closed gap this round's correction exists to close: an
  // invalid/inconsistent identity must be rejected regardless of which
  // Supabase ref it's paired with -- including a perfectly valid
  // non-production one. Previously these cases sailed through
  // unexamined, because identity was only ever checked against the
  // production ref.
  describe("invalid/inconsistent Vercel identity is rejected even with a non-production Supabase ref", () => {
    it("VERCEL=1 + preview + wrong VERCEL_PROJECT_ID + non-production Supabase: rejected", () => {
      expect(() =>
        assertSupabaseProjectRefAllowed({
          supabaseUrl: NON_PRODUCTION_URL,
          vercel: "1",
          vercelEnv: "preview",
          vercelProjectId: "prj_some_other_project_entirely",
        }),
      ).toThrow(UnsafeSupabaseProjectRefError);
    });

    it("VERCEL=1 + production + wrong VERCEL_PROJECT_ID + non-production Supabase: rejected", () => {
      expect(() =>
        assertSupabaseProjectRefAllowed({
          supabaseUrl: NON_PRODUCTION_URL,
          vercel: "1",
          vercelEnv: "production",
          vercelProjectId: "prj_some_other_project_entirely",
        }),
      ).toThrow(UnsafeSupabaseProjectRefError);
    });

    it("wrong VERCEL_PROJECT_ID (otherwise-valid markers) + non-production Supabase: rejected", () => {
      expect(() =>
        assertSupabaseProjectRefAllowed({
          supabaseUrl: NON_PRODUCTION_URL,
          vercel: "1",
          vercelEnv: "production",
          vercelProjectId: "prj_some_other_project_entirely",
        }),
      ).toThrow(UnsafeSupabaseProjectRefError);
    });

    it("missing VERCEL_PROJECT_ID while other markers exist + non-production Supabase: rejected", () => {
      expect(() =>
        assertSupabaseProjectRefAllowed({
          supabaseUrl: NON_PRODUCTION_URL,
          vercel: "1",
          vercelEnv: "production",
          vercelProjectId: undefined,
        }),
      ).toThrow(UnsafeSupabaseProjectRefError);
    });

    it("VERCEL=1 with missing VERCEL_ENV + non-production Supabase: rejected", () => {
      expect(() =>
        assertSupabaseProjectRefAllowed({
          supabaseUrl: NON_PRODUCTION_URL,
          vercel: "1",
          vercelEnv: undefined,
          vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
        }),
      ).toThrow(UnsafeSupabaseProjectRefError);
    });

    it("VERCEL_ENV present with VERCEL absent + non-production Supabase: rejected", () => {
      expect(() =>
        assertSupabaseProjectRefAllowed({
          supabaseUrl: NON_PRODUCTION_URL,
          vercel: undefined,
          vercelEnv: "production",
          vercelProjectId: PRODUCTION_VERCEL_PROJECT_ID,
        }),
      ).toThrow(UnsafeSupabaseProjectRefError);
    });
  });

  it("malformed URL: rejected, regardless of Vercel markers", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: "not-a-url", ...GENUINE_PRODUCTION_IDENTITY }),
    ).toThrow(UnsafeSupabaseProjectRefError);
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: "not-a-url", ...NO_VERCEL_MARKERS }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  it("missing URL: rejected, regardless of Vercel markers", () => {
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: undefined, ...GENUINE_PRODUCTION_IDENTITY }),
    ).toThrow(UnsafeSupabaseProjectRefError);
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: undefined, ...NO_VERCEL_MARKERS }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  // AUTH-STAGE-1A requirement (original guard): NODE_ENV is
  // automatically "production" for `next build`/`next start` even when
  // run locally, so this function must never branch on it -- only the
  // three Vercel identity markers matter. This test can't literally pass
  // NODE_ENV in (the function doesn't accept it, by design), so it
  // instead proves the point directly: a local build has every Vercel
  // marker unset while NODE_ENV=production, and that must still be
  // rejected exactly like any other non-production execution.
  it("NODE_ENV=production with every Vercel marker absent + production ref: rejected (local build simulation)", () => {
    // vi.stubEnv, not a direct assignment: process.env.NODE_ENV is
    // typed read-only (TS2540) in this environment.
    vi.stubEnv("NODE_ENV", "production");
    expect(process.env.VERCEL).toBeUndefined();
    expect(process.env.VERCEL_ENV).toBeUndefined();
    expect(process.env.VERCEL_PROJECT_ID).toBeUndefined();
    expect(() =>
      assertSupabaseProjectRefAllowed({ supabaseUrl: PRODUCTION_URL, ...NO_VERCEL_MARKERS }),
    ).toThrow(UnsafeSupabaseProjectRefError);
  });

  it("thrown errors do not disclose the supplied URL, ref, or Vercel marker values", () => {
    let caught: unknown;
    try {
      assertSupabaseProjectRefAllowed({ supabaseUrl: NON_PRODUCTION_URL, ...GENUINE_PRODUCTION_IDENTITY });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsafeSupabaseProjectRefError);
    const message = (caught as Error).message;
    expect(message).not.toContain(NON_PRODUCTION_REF);
    expect(message).not.toContain(NON_PRODUCTION_URL);
    expect(message).not.toContain(PRODUCTION_SUPABASE_PROJECT_REF);
    expect(message).not.toContain(PRODUCTION_VERCEL_PROJECT_ID);

    let caughtWrongProject: unknown;
    try {
      assertSupabaseProjectRefAllowed({
        supabaseUrl: NON_PRODUCTION_URL,
        vercel: "1",
        vercelEnv: "production",
        vercelProjectId: "prj_some_other_project_entirely",
      });
    } catch (error) {
      caughtWrongProject = error;
    }
    expect(caughtWrongProject).toBeInstanceOf(UnsafeSupabaseProjectRefError);
    const wrongProjectMessage = (caughtWrongProject as Error).message;
    expect(wrongProjectMessage).not.toContain("prj_some_other_project_entirely");
    expect(wrongProjectMessage).not.toContain(NON_PRODUCTION_REF);
    expect(wrongProjectMessage).not.toContain(PRODUCTION_SUPABASE_PROJECT_REF);
  });
});
