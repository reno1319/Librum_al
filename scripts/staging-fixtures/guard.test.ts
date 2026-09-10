import { describe, expect, it } from "vitest";
import {
  assertStagingTarget,
  PRODUCTION_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_PROJECT_REF,
  UnsafeStagingTargetError,
} from "./guard.mts";

// PHASE-1C correction pass 2, item 5: "production ref always rejected;
// staging ref accepted; malformed/missing/third-project URL rejected."

describe("assertStagingTarget", () => {
  it("accepts the exact staging ref", () => {
    const url = `https://${STAGING_SUPABASE_PROJECT_REF}.supabase.co`;
    expect(assertStagingTarget(url)).toBe(STAGING_SUPABASE_PROJECT_REF);
  });

  it("rejects the production ref unconditionally", () => {
    const url = `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;
    expect(() => assertStagingTarget(url)).toThrow(UnsafeStagingTargetError);
  });

  it("rejects a third, unrecognized project ref", () => {
    const url = "https://abcdefghijklmnopqrst.supabase.co";
    expect(() => assertStagingTarget(url)).toThrow(UnsafeStagingTargetError);
  });

  it("rejects a missing URL", () => {
    expect(() => assertStagingTarget(undefined)).toThrow(UnsafeStagingTargetError);
    expect(() => assertStagingTarget(null)).toThrow(UnsafeStagingTargetError);
    expect(() => assertStagingTarget("")).toThrow(UnsafeStagingTargetError);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertStagingTarget("not-a-url")).toThrow(UnsafeStagingTargetError);
    expect(() => assertStagingTarget("http://erhzpapqwyfjotliqdjo.supabase.co")).toThrow(
      UnsafeStagingTargetError,
    );
    expect(() => assertStagingTarget(`https://${STAGING_SUPABASE_PROJECT_REF}.example.com`)).toThrow(
      UnsafeStagingTargetError,
    );
  });

  it("never includes the raw URL value in its thrown message", () => {
    const secretLookingUrl = "https://abcdefghijklmnopqrst.supabase.co";
    try {
      assertStagingTarget(secretLookingUrl);
      throw new Error("expected assertStagingTarget to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeStagingTargetError);
      expect((err as Error).message).not.toContain("abcdefghijklmnopqrst");
    }
  });

  it("the production and staging refs are distinct", () => {
    expect(PRODUCTION_SUPABASE_PROJECT_REF).not.toBe(STAGING_SUPABASE_PROJECT_REF);
    expect(PRODUCTION_SUPABASE_PROJECT_REF).toBe("pwkukotgpsegieshulpj");
    expect(STAGING_SUPABASE_PROJECT_REF).toBe("erhzpapqwyfjotliqdjo");
  });
});

// PHASE-1C correction pass 2, item 5: "no Supabase client factory is
// called when guard/preflight fails." Proven at the orchestrator level
// in reset.test.ts (via a fake client factory spy); this module-level
// test proves the guard itself throws synchronously BEFORE returning
// control to any caller, which is the property that makes that
// orchestrator-level guarantee possible in the first place.
describe("assertStagingTarget fails closed, synchronously, before any caller could proceed", () => {
  it("throws (does not return, does not resolve a promise) on a bad ref", () => {
    let reached = false;
    expect(() => {
      assertStagingTarget("https://pwkukotgpsegieshulpj.supabase.co");
      reached = true;
    }).toThrow();
    expect(reached).toBe(false);
  });
});
