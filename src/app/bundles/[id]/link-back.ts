// Pure decision logic for buyBundle's post-checkout-creation snapshot
// link-back (src/app/bundles/[id]/actions.ts). Deliberately NOT in
// actions.ts itself: that file starts with "use server", and Next.js
// requires every top-level export of a "use server" file to be an async
// Server Action -- a plain synchronous helper can't live there. Split
// out here so it's an ordinary, freely importable/testable module, and
// so buyBundle's own orchestration (auth, Stripe calls, DB calls) isn't
// disturbed to make this testable.
export type LinkBackOutcome =
  | { kind: "linked" }
  | { kind: "already_linked" }
  | { kind: "conflict"; existingSessionId: string }
  | { kind: "missing" }
  | { kind: "update_error" }
  | { kind: "read_back_error" };

// Classifies the result of buyBundle's write-once
// `UPDATE ... SET stripe_checkout_session_id = :sessionId
//  WHERE id = :snapshotId AND stripe_checkout_session_id IS NULL`
// (performed with the admin client, so it isn't itself subject to RLS)
// together with, when that UPDATE claimed zero rows, a follow-up
// read-back of the row's current stripe_checkout_session_id (also via
// the admin client). Zero rows updated is not on its own an error --
// it's ambiguous between "already linked to this exact session" (a
// harmless retry/duplicate) and "linked to something else" (a genuine
// anomaly worth logging loudly) until the read-back resolves it.
export function classifyLinkBackResult(params: {
  linkedRowCount: number;
  updateError: unknown;
  readBackSessionId: string | null | undefined;
  readBackError: unknown;
  sessionId: string;
}): LinkBackOutcome {
  const { linkedRowCount, updateError, readBackSessionId, readBackError, sessionId } = params;

  if (updateError) return { kind: "update_error" };
  if (linkedRowCount > 0) return { kind: "linked" };

  // The UPDATE claimed zero rows -- find out why via the read-back.
  if (readBackError) return { kind: "read_back_error" };
  if (readBackSessionId === sessionId) return { kind: "already_linked" };
  if (readBackSessionId) return { kind: "conflict", existingSessionId: readBackSessionId };

  // Zero rows updated (so the WHERE clause's stripe_checkout_session_id
  // IS NULL should have matched) yet the read-back also shows no
  // session id and no error -- only reachable if the snapshot row
  // itself no longer exists for this id, which should never happen for
  // a snapshot this same request just created or reused moments
  // earlier. Distinct from "conflict" (a real, different value) and
  // from the ordinary error cases -- worth its own category to log.
  return { kind: "missing" };
}

// The one safety-critical decision this whole module exists for: may
// buyBundle redirect the reader to the Stripe Checkout Session it just
// created? Every outcome except "conflict" answers yes -- update_error,
// read_back_error, and missing are ordinary AUDIT-LINK availability
// failures (fulfillment reads Stripe's own metadata.snapshot_id, never
// this field, so none of them make the just-created session unsafe to
// use). "conflict" is different in kind, not degree: it means this
// snapshot is ALREADY linked to a different, non-null Stripe session --
// under the deterministic idempotency key buyBundle uses
// (`bundle-checkout:` + snapshot id), two concurrent/retried calls for
// the same snapshot are guaranteed the SAME session.id back from Stripe,
// so two different non-null ids is a confirmed integrity-invariant
// violation, not a normal race. Exposing a SECOND, freshly-created,
// still-payable session on top of whatever this snapshot is already
// linked to risks the reader ending up with two live, ambiguous payment
// attempts for the same bundle -- availability loss for this one request
// is the safer failure mode.
export function shouldExposeStripeCheckoutSession(outcome: LinkBackOutcome): boolean {
  return outcome.kind !== "conflict";
}
