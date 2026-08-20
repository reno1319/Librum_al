"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe";
import { platformFeeCents } from "@/lib/pricing";

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

  const { data: existingPurchases } = await supabase
    .from("purchases")
    .select("book_id")
    .eq("reader_id", user.id)
    .in("book_id", bookIds)
    .is("refunded_at", null);

  const ownedIds = new Set((existingPurchases ?? []).map((p) => p.book_id));
  const ownsEverything = bookIds.every((id) => ownedIds.has(id));
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

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

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
  // (see the Stage 2A webhook path). A failure here is logged and
  // otherwise ignored; checkout must still proceed for the reader
  // either way.
  //
  // The write itself is the conditional filter, not a separate read
  // beforehand -- this UPDATE only ever touches a row that is both this
  // exact snapshot AND still unlinked, so there is no window between
  // checking and writing for a concurrent process to race. If it claims
  // zero rows, that's not itself an error: it means either this exact
  // session is already stored (a duplicate/retried call for the same
  // snapshot) or -- a genuine anomaly -- a DIFFERENT session got there
  // first. The follow-up read exists only to tell those two apart for
  // logging, never to decide whether to write.
  const { data: linkedRows, error: linkBackError } = await supabase
    .from("bundle_checkout_snapshots")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", snapshot.snapshot_id)
    .is("stripe_checkout_session_id", null)
    .select("id");

  if (linkBackError) {
    console.error("buyBundle: failed to link snapshot to its checkout session", {
      snapshotId: snapshot.snapshot_id,
      error: linkBackError,
    });
  } else if ((linkedRows?.length ?? 0) === 0) {
    const { data: currentSnapshot, error: readBackError } = await supabase
      .from("bundle_checkout_snapshots")
      .select("stripe_checkout_session_id")
      .eq("id", snapshot.snapshot_id)
      .maybeSingle();

    if (readBackError) {
      console.error(
        "buyBundle: failed to read back snapshot after a missed link-back claim",
        { snapshotId: snapshot.snapshot_id, error: readBackError },
      );
    } else if (
      currentSnapshot?.stripe_checkout_session_id &&
      currentSnapshot.stripe_checkout_session_id !== session.id
    ) {
      console.error(
        "buyBundle: snapshot already linked to a different checkout session -- not overwriting",
        {
          snapshotId: snapshot.snapshot_id,
          existingSessionId: currentSnapshot.stripe_checkout_session_id,
          incomingSessionId: session.id,
        },
      );
    }
    // Otherwise the row is already correctly linked to this exact
    // session -- nothing further to do.
  }

  redirect(session.url);
}
