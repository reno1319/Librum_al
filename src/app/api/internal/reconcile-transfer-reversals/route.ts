import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  reverseAuthorTransferForLostDispute,
  type TransferReversalOutcome,
} from "@/app/api/webhooks/stripe/route";

// LAUNCH-1 P1-8: automatic reconciliation for lost-dispute transfer
// recovery. charge.dispute.closed (the event that carries a dispute's
// terminal 'lost' status) is typically the LAST dispute event Stripe
// ever sends for a resolved dispute -- a payment_disputes row stuck in
// 'attempting' (a crash mid-attempt) or 'failed' (a genuine rejection)
// has no guarantee of ever receiving another webhook to naturally
// retrigger recovery. This route exists to close that gap.
//
// No pre-existing scheduler/cron infrastructure was found anywhere in
// this repository (no vercel.json, no cron references, no internal/
// admin machine-to-machine route, no scheduled Supabase function --
// re-confirmed immediately before implementing this file). This route
// is therefore the smallest new, platform-agnostic mechanism: a plain
// secret-protected POST endpoint that performs one bounded
// reconciliation pass per invocation. It does not itself assume or
// configure any particular scheduler -- see the implementation report
// for why vercel.json was deliberately NOT added, and what remains a
// manual deployment step.
//
// Auth: a bearer-token comparison against process.env.CRON_SECRET, the
// same convention Vercel Cron itself uses natively when configured
// (Authorization: Bearer $CRON_SECRET) -- also trivially satisfied by
// any other scheduler (an external cron hitting this URL, a Supabase
// scheduled function) or by manual/curl invocation for operator-
// triggered recovery. This is a machine-to-machine endpoint, not a user
// session -- there is no admin-role check here, only the shared secret,
// the same posture the Stripe webhook itself uses (signature
// verification, not a session).
export async function POST(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;

  if (!configuredSecret) {
    // Fails closed: an unconfigured secret must never be treated as
    // "no auth required." Logged for operator visibility -- this is a
    // deployment/configuration gap, not a normal runtime condition.
    console.error(
      "Reconcile transfer reversals: CRON_SECRET is not configured -- refusing all requests",
    );
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${configuredSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const summary = await runTransferReversalReconciliation(supabase, stripe);

  return NextResponse.json({ received: true, ...summary });
}

// LAUNCH-1 P1-8: 10-minute stale threshold -- roughly an order of
// magnitude larger than any realistic single Stripe API round trip
// (list/create/retrieve), so it will not falsely reclaim a genuinely
// still-in-flight attempt, while bounding real recovery time after an
// actual crash to about one reconciliation cadence beyond this window.
// See the Migration 036 design report for the full justification.
export const STALE_ATTEMPTING_THRESHOLD_MS = 10 * 60 * 1000;

// Bounded batch per invocation -- keeps a single pass's runtime
// predictable and short, which matters specifically because overlapping
// executions must be safe (see below): a huge unbounded pass would make
// "overlapping" the common case rather than the rare one.
export const RECONCILIATION_BATCH_LIMIT = 50;

type ReconciliationSupabaseClient = ReturnType<typeof createAdminClient>;
type ReconciliationStripeClient = Parameters<typeof reverseAuthorTransferForLostDispute>[1];

export type ReconciliationSummary = {
  candidateCount: number;
  outcomes: Record<TransferReversalOutcome["kind"] | "error", number>;
};

// Selects a bounded, deduplicated, oldest-first set of dispute ids
// whose transfer-reversal state needs reconciliation -- 'failed' rows
// (immediately eligible) and 'attempting' rows older than the stale
// cutoff (possibly abandoned mid-attempt). Two plain .eq()/.lt() reads
// merged in JS rather than a single .or() filter -- keeps this
// trivially fakeable with the same simple Supabase test double already
// used throughout this file's own test suite, and avoids any PostgREST
// filter-string construction. A row actually claimed by a concurrent
// worker between this read and the claim attempt below is handled
// safely by claimTransferReversalAttempt's own compare-and-swap (see
// route.ts) -- this selection is advisory candidate-finding only, never
// itself the safety mechanism.
async function selectDisputesNeedingReconciliation(
  supabase: ReconciliationSupabaseClient,
  staleAttemptingCutoff: Date,
  batchLimit: number,
): Promise<string[]> {
  const { data: failedRows } = await supabase
    .from("payment_disputes")
    .select("stripe_dispute_id, transfer_reversal_attempted_at")
    .eq("status", "lost")
    .eq("transfer_reversal_status", "failed")
    .order("transfer_reversal_attempted_at", { ascending: true })
    .limit(batchLimit);

  const { data: staleAttemptingRows } = await supabase
    .from("payment_disputes")
    .select("stripe_dispute_id, transfer_reversal_attempted_at")
    .eq("status", "lost")
    .eq("transfer_reversal_status", "attempting")
    .lt("transfer_reversal_attempted_at", staleAttemptingCutoff.toISOString())
    .order("transfer_reversal_attempted_at", { ascending: true })
    .limit(batchLimit);

  const merged = [...(failedRows ?? []), ...(staleAttemptingRows ?? [])] as {
    stripe_dispute_id: string;
    transfer_reversal_attempted_at: string | null;
  }[];
  merged.sort((a, b) =>
    (a.transfer_reversal_attempted_at ?? "").localeCompare(b.transfer_reversal_attempted_at ?? ""),
  );

  const seen = new Set<string>();
  const disputeIds: string[] = [];
  for (const row of merged) {
    if (seen.has(row.stripe_dispute_id)) continue;
    seen.add(row.stripe_dispute_id);
    disputeIds.push(row.stripe_dispute_id);
    if (disputeIds.length >= batchLimit) break;
  }
  return disputeIds;
}

// The core reconciliation pass -- extracted (only) so route.test.ts can
// drive it directly with fake Supabase/Stripe clients, the same
// spirit as every handler in src/app/api/webhooks/stripe/route.ts.
// POST() above remains the actual route handler and is not itself
// exported or changed beyond calling this function.
//
// For each candidate: re-fetch the LIVE dispute from Stripe (never
// trust the stored status is still current -- the same defensive
// posture processDisputeEvent already uses) and, only if it is still
// exactly 'lost', delegate to reverseAuthorTransferForLostDispute with
// the stale cutoff -- the exact same claim/idempotency/amount/
// reconciliation logic the webhook itself uses, not a duplicated copy.
// A candidate a concurrent worker already resolved (or that changed
// state) between selection and this call simply yields 'not_claimed' --
// not an error, and safe to encounter on every overlapping run.
export async function runTransferReversalReconciliation(
  supabase: ReconciliationSupabaseClient,
  stripeClient: ReconciliationStripeClient,
  now: Date = new Date(),
): Promise<ReconciliationSummary> {
  const staleAttemptingCutoff = new Date(now.getTime() - STALE_ATTEMPTING_THRESHOLD_MS);
  const disputeIds = await selectDisputesNeedingReconciliation(
    supabase,
    staleAttemptingCutoff,
    RECONCILIATION_BATCH_LIMIT,
  );

  const outcomes: ReconciliationSummary["outcomes"] = {
    not_lost: 0,
    not_claimed: 0,
    reconciled_existing: 0,
    reversed: 0,
    nothing_to_reverse: 0,
    failed: 0,
    error: 0,
  };

  for (const disputeId of disputeIds) {
    try {
      const dispute = await stripeClient.disputes.retrieve(disputeId);
      const outcome = await reverseAuthorTransferForLostDispute(
        supabase,
        stripeClient,
        dispute,
        staleAttemptingCutoff,
      );
      outcomes[outcome.kind] += 1;
    } catch (error) {
      outcomes.error += 1;
      console.error("Reconcile transfer reversals: unexpected error processing a candidate", {
        disputeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { candidateCount: disputeIds.length, outcomes };
}
