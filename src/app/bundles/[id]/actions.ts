"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { platformFeeCents } from "@/lib/pricing";
import { resolveSiteOrigin } from "@/lib/site-url";
import {
  classifyLinkBackResult,
  shouldExposeStripeCheckoutSession,
  type LinkBackOutcome,
} from "./link-back";

type BundleForCheckout = {
  id: string;
  status: string;
  author_id: string;
  profiles: {
    stripe_account_id: string | null;
    stripe_payouts_enabled: boolean;
  } | null;
};

type SnapshotResult = {
  snapshot_id: string;
  bundle_title: string;
  bundle_price_cents_at_checkout: number;
  protection_expires_at: string;
};

export async function buyBundle(bundleId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/bundles/${bundleId}`);
  }

  // Cheap, non-authoritative early checks -- create_bundle_checkout_snapshot
  // (migration 025) re-validates published status and membership
  // atomically at the moment it actually freezes the checkout, so
  // nothing here needs to be race-free with that. This just avoids an
  // RPC round trip (and its generic failure message) for an obviously
  // invalid attempt, and gives a friendlier redirect than the RPC's own
  // exception would.
  const { data: bundle } = await supabase
    .from("bundles")
    .select("id, status, author_id, profiles(stripe_account_id, stripe_payouts_enabled)")
    .eq("id", bundleId)
    .single<BundleForCheckout>();

  if (!bundle || bundle.status !== "published" || bundle.author_id === user.id) {
    redirect(`/bundles/${bundleId}`);
  }

  const authorAccount = bundle.profiles?.stripe_account_id;
  if (!bundle.profiles?.stripe_payouts_enabled || !authorAccount) {
    redirect(`/bundles/${bundleId}?error=This+bundle+isn%27t+available+for+purchase+right+now`);
  }

  // Advisory only -- an early, friendlier "you already own this" exit.
  // Whatever the snapshot RPC actually freezes moments later is
  // authoritative for the real checkout; this doesn't need to be
  // race-free with it.
  const { data: bundleBooks } = await supabase
    .from("bundle_books")
    .select("book_id")
    .eq("bundle_id", bundleId);

  const bookIds = (bundleBooks ?? []).map((row) => row.book_id);
  if (bookIds.length === 0) {
    redirect(`/bundles/${bundleId}`);
  }

  // LAUNCH-1 P1-7A: per-book, via user_owns_book() (also excludes a
  // purchase whose payment intent has a dispute at status 'lost')
  // rather than a single raw multi-book purchases select -- payment_
  // disputes is fully closed to this request-scoped client, so a raw
  // query here could no longer see the same ownership truth
  // create_bundle_checkout_snapshot's own (now-corrected) authoritative
  // check uses. Bundles are small (a handful of books at most), so N
  // RPC round trips in parallel is not a real cost.
  const ownershipChecks = await Promise.all(
    bookIds.map((id) => supabase.rpc("user_owns_book", { target_book_id: id })),
  );
  const ownsEverything = ownershipChecks.every((result) => !!result.data);
  if (ownsEverything) {
    redirect(`/bundles/${bundleId}`);
  }

  // The snapshot is the sole source of truth for what Stripe actually
  // charges from this point forward -- book membership, per-book
  // prices, and the bundle's own price are all frozen atomically by
  // this one call (see migration 025). Nothing after this point may
  // re-read bundles/bundle_books for pricing purposes -- doing so would
  // reopen the exact mutable-price race this whole design exists to
  // close.
  const { data: snapshotRows, error: snapshotError } = await supabase.rpc(
    "create_bundle_checkout_snapshot",
    { bundle_id: bundleId },
  );

  const snapshot = (snapshotRows as SnapshotResult[] | null)?.[0];

  if (snapshotError || !snapshot) {
    console.error("buyBundle: create_bundle_checkout_snapshot failed", {
      bundleId,
      readerId: user.id,
      error: snapshotError,
    });
    redirect(`/bundles/${bundleId}?error=Could+not+start+checkout`);
  }

  // `snapshotRows as SnapshotResult[] | null` above is a compile-time
  // cast only -- it gives no runtime guarantee that the RPC actually
  // returned well-formed values. Every field that flows into the Stripe
  // call below is checked explicitly before that call is ever made.
  const protectionExpiresAtMs = Date.parse(snapshot.protection_expires_at);
  const isSnapshotUsable =
    typeof snapshot.snapshot_id === "string" &&
    snapshot.snapshot_id.length > 0 &&
    typeof snapshot.bundle_title === "string" &&
    snapshot.bundle_title.length > 0 &&
    typeof snapshot.bundle_price_cents_at_checkout === "number" &&
    Number.isInteger(snapshot.bundle_price_cents_at_checkout) &&
    snapshot.bundle_price_cents_at_checkout >= 0 &&
    Number.isFinite(protectionExpiresAtMs);

  if (!isSnapshotUsable) {
    console.error("buyBundle: snapshot RPC returned a malformed result", {
      bundleId,
      readerId: user.id,
      snapshot,
    });
    redirect(`/bundles/${bundleId}?error=Could+not+start+checkout`);
  }

  const stripeExpiresAtSeconds = Math.floor(protectionExpiresAtMs / 1000);

  const origin = resolveSiteOrigin();

  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: snapshot.bundle_title },
              unit_amount: snapshot.bundle_price_cents_at_checkout,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: platformFeeCents(
            snapshot.bundle_price_cents_at_checkout,
          ),
          transfer_data: {
            destination: authorAccount,
          },
        },
        expires_at: stripeExpiresAtSeconds,
        success_url: `${origin}/bundles/${bundleId}?purchase=success`,
        cancel_url: `${origin}/bundles/${bundleId}?purchase=cancelled`,
        metadata: {
          snapshot_id: snapshot.snapshot_id,
          bundle_id: bundleId,
        },
      },
      {
        // Deterministic, not random: retrying this exact snapshot's
        // checkout-creation request (e.g. after an ambiguous network
        // failure) must never be able to create a second, independent
        // Stripe Checkout Session for the same frozen snapshot.
        idempotencyKey: `bundle-checkout:${snapshot.snapshot_id}`,
      },
    );
  } catch (error) {
    // The request may have been ambiguous -- Stripe could have accepted
    // it even though this call didn't receive a successful response.
    // The snapshot and its reservations/reader-hold are deliberately
    // left completely intact: they're what makes the idempotency key
    // above safe to retry, and eagerly tearing them down here could
    // release a book/reader protection out from under a Stripe session
    // that, unknown to this request, actually exists and is still
    // payable. They expire and self-clear on their own via migration
    // 025's existing mechanism if no session ever completes.
    console.error("buyBundle: Stripe checkout session creation failed", {
      bundleId,
      readerId: user.id,
      snapshotId: snapshot.snapshot_id,
      error,
    });
    redirect(`/bundles/${bundleId}?error=Could+not+start+checkout`);
  }

  if (!session.url) {
    redirect(`/bundles/${bundleId}?error=Could+not+start+checkout`);
  }

  // Audit-only -- fulfillment never depends on this succeeding, since
  // the webhook resolves the snapshot directly from metadata.snapshot_id
  // (see the Stage 2A webhook path) and links this same field itself,
  // via its own admin-role client, independent of whether this call
  // does. A failure here is logged and otherwise ignored; checkout must
  // still proceed for the reader either way.
  //
  // Performed with the ADMIN client, not the request-scoped one used
  // for everything above -- bundle_checkout_snapshots has never had an
  // UPDATE (or reader-facing SELECT) policy for authenticated, so the
  // original direct UPDATE from the reader's own client always matched
  // zero rows, silently, on every single bundle checkout (RLS
  // default-deny with no applicable policy is not a SQL error). A
  // client-callable RPC to bypass that was considered and rejected: an
  // authenticated reader could call it directly with an ARBITRARY
  // session id for their own unlinked snapshot -- transaction identity
  // must only ever be asserted by trusted server code after Stripe
  // itself has returned session.id, never accepted as caller input, even
  // narrowly. buyBundle is already a Server Action (`"use server"` at
  // the top of this file) -- it never runs in, and is never bundled
  // into, the browser -- so using the admin client HERE, directly, is
  // the same trusted-server-code posture already used for this exact
  // purpose in the webhook (src/app/api/webhooks/stripe/route.ts) and
  // for admin reads/writes elsewhere in this codebase (see
  // src/lib/supabase/admin.ts and its other callers). The UPDATE itself
  // is scoped to touch ONLY stripe_checkout_session_id, only this one
  // snapshot id, only while it's still unlinked -- every other frozen
  // field (items, bundle_price_cents_at_checkout, fulfilled_at, and so
  // on) is completely untouched by this statement, admin client or not.
  const admin = createAdminClient();
  const { data: linkedRows, error: linkBackError } = await admin
    .from("bundle_checkout_snapshots")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", snapshot.snapshot_id)
    .is("stripe_checkout_session_id", null)
    .select("id");

  let outcome: LinkBackOutcome;
  let readBackError: unknown = null;
  if (linkBackError) {
    outcome = { kind: "update_error" };
  } else if ((linkedRows?.length ?? 0) > 0) {
    outcome = { kind: "linked" };
  } else {
    // Zero rows updated -- ambiguous between "already linked to this
    // exact session" (a harmless retry/duplicate call) and "linked to
    // something else" (a genuine anomaly) until read back. Also via the
    // admin client -- the same RLS gap that blocks the reader's own
    // client from writing this field blocks it from reading this row
    // back too.
    const { data: currentSnapshot, error: readBackErr } = await admin
      .from("bundle_checkout_snapshots")
      .select("stripe_checkout_session_id")
      .eq("id", snapshot.snapshot_id)
      .maybeSingle();
    readBackError = readBackErr;

    outcome = classifyLinkBackResult({
      linkedRowCount: 0,
      updateError: null,
      readBackSessionId: currentSnapshot?.stripe_checkout_session_id,
      readBackError: readBackErr,
      sessionId: session.id,
    });
  }

  switch (outcome.kind) {
    case "linked":
    case "already_linked":
      // Nothing to log -- either this call set it, or an earlier
      // delivery already had, correctly, to this exact session.
      break;
    case "update_error":
      console.error("buyBundle: failed to link snapshot to its checkout session", {
        snapshotId: snapshot.snapshot_id,
        error: linkBackError,
      });
      break;
    case "read_back_error":
      console.error(
        "buyBundle: failed to read back snapshot after a missed link-back claim",
        { snapshotId: snapshot.snapshot_id, error: readBackError },
      );
      break;
    case "missing":
      console.error(
        "buyBundle: snapshot link-back matched zero rows and the read-back found no session id either -- snapshot may no longer exist",
        { snapshotId: snapshot.snapshot_id, incomingSessionId: session.id },
      );
      break;
    case "conflict":
      // A different, non-null session id is already on this snapshot.
      // Under Stripe's own idempotency guarantee this should be
      // unreachable in normal operation -- two concurrent buyBundle
      // calls that both reuse this same snapshot use the identical
      // idempotency key ("bundle-checkout:" + snapshot_id, see above)
      // and are therefore guaranteed the SAME session.id back from
      // Stripe, not two different ones. A genuine mismatch here means
      // either a Stripe idempotency-key violation or an out-of-band
      // change to this row -- a confirmed integrity-invariant
      // violation, not an ordinary availability hiccup like the other
      // cases above. See shouldExposeStripeCheckoutSession below for
      // why this is the one outcome that blocks the redirect.
      console.error(
        "buyBundle: SNAPSHOT LINKAGE INTEGRITY ANOMALY -- snapshot already linked to a different checkout session, refusing to expose a second session for the same snapshot",
        {
          snapshotId: snapshot.snapshot_id,
          existingSessionId: outcome.existingSessionId,
          incomingSessionId: session.id,
        },
      );
      break;
  }

  // The only safety-critical branch point in this whole link-back
  // block: everything above is best-effort logging, this is the actual
  // decision of whether it's safe to hand the reader a Stripe Checkout
  // URL. Deliberately a single call to a pure, independently tested
  // predicate (link-back.ts) rather than inline logic duplicated from
  // the switch above -- "conflict does not redirect to Stripe" is an
  // invariant worth being able to verify in isolation, decoupled from
  // Stripe/redirect/DB mocking.
  if (!shouldExposeStripeCheckoutSession(outcome)) {
    redirect(`/bundles/${bundleId}?error=Could+not+start+checkout`);
  }

  redirect(session.url);
}
