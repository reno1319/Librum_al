import { describe, expect, it } from "vitest";
import {
  classifyLinkBackResult,
  shouldExposeStripeCheckoutSession,
  type LinkBackOutcome,
} from "./link-back";

const SESSION_ID = "cs_test_123";

describe("classifyLinkBackResult", () => {
  it("A. classifies a successful NULL -> session.id link", () => {
    const outcome = classifyLinkBackResult({
      linkedRowCount: 1,
      updateError: null,
      readBackSessionId: undefined,
      readBackError: null,
      sessionId: SESSION_ID,
    });
    expect(outcome).toEqual({ kind: "linked" });
  });

  it("B. classifies a zero-row update that reads back as already linked to this exact session", () => {
    const outcome = classifyLinkBackResult({
      linkedRowCount: 0,
      updateError: null,
      readBackSessionId: SESSION_ID,
      readBackError: null,
      sessionId: SESSION_ID,
    });
    expect(outcome).toEqual({ kind: "already_linked" });
  });

  it("C. classifies a zero-row update that reads back a conflicting, different session id", () => {
    const outcome = classifyLinkBackResult({
      linkedRowCount: 0,
      updateError: null,
      readBackSessionId: "cs_test_someone_else",
      readBackError: null,
      sessionId: SESSION_ID,
    });
    expect(outcome).toEqual({
      kind: "conflict",
      existingSessionId: "cs_test_someone_else",
    });
  });

  it("D1. classifies a database UPDATE error, regardless of row count", () => {
    const outcome = classifyLinkBackResult({
      linkedRowCount: 0,
      updateError: { message: "connection reset" },
      readBackSessionId: undefined,
      readBackError: null,
      sessionId: SESSION_ID,
    });
    expect(outcome).toEqual({ kind: "update_error" });
  });

  it("D2. classifies a database read-back error after a zero-row update", () => {
    const outcome = classifyLinkBackResult({
      linkedRowCount: 0,
      updateError: null,
      readBackSessionId: undefined,
      readBackError: { message: "connection reset" },
      sessionId: SESSION_ID,
    });
    expect(outcome).toEqual({ kind: "read_back_error" });
  });

  it("classifies a zero-row update whose read-back also shows no session id as 'missing'", () => {
    const outcome = classifyLinkBackResult({
      linkedRowCount: 0,
      updateError: null,
      readBackSessionId: null,
      readBackError: null,
      sessionId: SESSION_ID,
    });
    expect(outcome).toEqual({ kind: "missing" });
  });
});

// Proves the actual caller behavior buyBundle depends on -- not just
// that the classifier can produce a "conflict" value, but that the
// specific decision buyBundle makes from it (redirect to Stripe, or
// not) is correct for every outcome kind. This is the exact predicate
// actions.ts calls to decide whether to redirect, so asserting on it
// here is equivalent to asserting on buyBundle's own behavior for this
// branch point, without needing to mock Stripe, next/navigation's
// redirect(), or the surrounding Server Action/DB calls.
describe("shouldExposeStripeCheckoutSession", () => {
  it("confirmed conflict: does NOT proceed to Stripe", () => {
    const outcome: LinkBackOutcome = {
      kind: "conflict",
      existingSessionId: "cs_test_someone_else",
    };
    expect(shouldExposeStripeCheckoutSession(outcome)).toBe(false);
  });

  it("same-session idempotent result: proceeds to Stripe", () => {
    const outcome: LinkBackOutcome = { kind: "already_linked" };
    expect(shouldExposeStripeCheckoutSession(outcome)).toBe(true);
  });

  it("successful link: proceeds to Stripe", () => {
    const outcome: LinkBackOutcome = { kind: "linked" };
    expect(shouldExposeStripeCheckoutSession(outcome)).toBe(true);
  });

  it("ordinary UPDATE failure: retains best-effort proceed", () => {
    const outcome: LinkBackOutcome = { kind: "update_error" };
    expect(shouldExposeStripeCheckoutSession(outcome)).toBe(true);
  });

  it("ordinary read-back failure: retains best-effort proceed", () => {
    const outcome: LinkBackOutcome = { kind: "read_back_error" };
    expect(shouldExposeStripeCheckoutSession(outcome)).toBe(true);
  });

  it("missing/anomalous zero-row state: retains best-effort proceed", () => {
    const outcome: LinkBackOutcome = { kind: "missing" };
    expect(shouldExposeStripeCheckoutSession(outcome)).toBe(true);
  });
});
