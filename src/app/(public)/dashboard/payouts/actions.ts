"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { resolveSiteOrigin } from "@/lib/site-url";

// LAUNCH-1 P2-1: shown for every failure mode below where the
// underlying cause (a DB read/write anomaly, a Stripe API error) isn't
// something the author can act on directly -- deliberately the SAME
// generic message for all of them, so this string never leaks which
// internal step failed. The specific cause always goes to the server
// log via console.error instead, never into this redirect's own query
// string.
const GENERIC_CONNECT_FAILURE_REDIRECT =
  "/dashboard/payouts?error=Something+went+wrong+connecting+your+payout+account.+Please+try+again.";

// LAUNCH-1 P2-1: a permanent, deterministic idempotency key -- derived
// only from Librum's own stable user id, no timestamp or random
// component -- for Stripe Connect account creation specifically. Safe
// to reuse across retries because every retry of THIS call expresses
// the exact same intent ("get-or-create this one user's Connect
// account"): unlike a refund retry (see
// src/app/admin/refunds/issue-refund.ts), where a definitively-failed
// attempt needs a genuinely NEW operation and blindly reusing a key
// would be unsafe there, no failure mode here needs a second, different
// Stripe account for the same retried call.
//
// This is NOT a uniqueness guarantee for all time -- Stripe only
// retains an idempotency key for a bounded window before pruning it, so
// this only closes the near-term retry/concurrency race (a
// double-click, two tabs, a request retried after an ambiguous network
// failure). A request that genuinely arrives after Stripe has pruned
// the key is an operator-recovery case, not something a key can
// prevent -- the persistence-verification and canonical-account-
// selection logic below is what keeps THAT scenario from corrupting
// Librum's own data, even though it can't stop Stripe from creating a
// second, orphaned account on Stripe's side.
function buildConnectAccountIdempotencyKey(userId: string): string {
  return `connect-account-${userId}`;
}

export async function connectStripeAccount() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", user.id)
    .single();

  if (profileError) {
    // LAUNCH-1 P2-1: a failed read must never be interpreted as "this
    // author has no Stripe account yet" -- that misreading is exactly
    // what would let this action create a DUPLICATE Stripe account for
    // an author who already has one, merely because their own existing
    // profiles row failed to load this one time.
    console.error("connectStripeAccount: failed to read the author's profile", {
      userId: user.id,
      error: profileError,
    });
    redirect(GENERIC_CONNECT_FAILURE_REDIRECT);
  }

  let accountId = profile?.stripe_account_id;

  if (!accountId) {
    let account;
    try {
      account = await stripe.accounts.create(
        {
          type: "express",
          email: user.email,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: { librum_user_id: user.id },
        },
        { idempotencyKey: buildConnectAccountIdempotencyKey(user.id) },
      );
    } catch (error) {
      console.error("connectStripeAccount: Stripe account creation failed", {
        userId: user.id,
        error,
      });
      redirect(GENERIC_CONNECT_FAILURE_REDIRECT);
    }

    // Written with the admin client: regular users aren't allowed to
    // update this column themselves (see schema.sql). Conditional on
    // stripe_account_id still being NULL -- LAUNCH-1 P2-1: never
    // blindly overwrite an already-established connected account if a
    // concurrent request already won this race. `.select()` proves
    // whether a row was actually updated; an absent `error` alone never
    // proves that (a filter that matches nothing fails silently with
    // zero rows touched, not an error -- the same reasoning already
    // applied to bundle_checkout_snapshots's own link-back write in
    // src/app/bundles/[id]/actions.ts).
    const admin = createAdminClient();
    const { data: updatedRows, error: persistError } = await admin
      .from("profiles")
      .update({ stripe_account_id: account.id })
      .eq("id", user.id)
      .is("stripe_account_id", null)
      .select("stripe_account_id");

    if (persistError) {
      console.error(
        "connectStripeAccount: failed to persist the newly-created Stripe account",
        { userId: user.id, newlyCreatedStripeAccountId: account.id, error: persistError },
      );
      redirect(GENERIC_CONNECT_FAILURE_REDIRECT);
    }

    if (updatedRows && updatedRows.length > 0) {
      // Positive proof: Postgres only returns a row here because this
      // exact user's row existed AND still had a NULL
      // stripe_account_id AND now holds account.id -- not merely "no
      // error was thrown".
      accountId = updatedRows[0].stripe_account_id;
    } else {
      // Zero rows updated -- ambiguous between "a concurrent request
      // already persisted this exact account" (harmless) and "a
      // DIFFERENT account is already there" (a possible orphan) until
      // read back.
      const { data: currentProfile, error: reReadError } = await admin
        .from("profiles")
        .select("stripe_account_id")
        .eq("id", user.id)
        .maybeSingle();

      if (reReadError || !currentProfile?.stripe_account_id) {
        console.error(
          "connectStripeAccount: persistence write matched zero rows and the re-read could not confirm any stored account -- failing safely",
          {
            userId: user.id,
            newlyCreatedStripeAccountId: account.id,
            error: reReadError ?? null,
          },
        );
        redirect(GENERIC_CONNECT_FAILURE_REDIRECT);
      }

      if (currentProfile.stripe_account_id === account.id) {
        // Converged: a concurrent request already wrote this exact
        // account id first.
        accountId = currentProfile.stripe_account_id;
      } else {
        // A DIFFERENT, already-persisted account wins -- it is
        // canonical. The account just created in this invocation is
        // logged as a possible orphan for operator attention and is
        // deliberately left alone: no automatic Stripe-side deletion --
        // that is a separate lifecycle problem needing its own design.
        console.error(
          "connectStripeAccount: a different Stripe account was already persisted for this author -- using the existing persisted account as canonical; the newly-created account may be an orphan requiring operator attention",
          {
            userId: user.id,
            newlyCreatedStripeAccountId: account.id,
            canonicalStripeAccountId: currentProfile.stripe_account_id,
          },
        );
        accountId = currentProfile.stripe_account_id;
      }
    }
  }

  const origin = resolveSiteOrigin();

  let accountLink;
  try {
    accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/dashboard/payouts`,
      return_url: `${origin}/dashboard/payouts`,
      type: "account_onboarding",
    });
  } catch (error) {
    // The stripe_account_id persisted above is untouched by this
    // failure -- a retry of this action re-reads it and reuses the same
    // account rather than creating another.
    console.error("connectStripeAccount: failed to create the Stripe onboarding link", {
      userId: user.id,
      stripeAccountId: accountId,
      error,
    });
    redirect(GENERIC_CONNECT_FAILURE_REDIRECT);
  }

  redirect(accountLink.url);
}

export async function openStripeExpressDashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", user.id)
    .single();

  if (!profile?.stripe_account_id) {
    redirect("/dashboard/payouts");
  }

  const loginLink = await stripe.accounts.createLoginLink(profile.stripe_account_id);
  redirect(loginLink.url);
}
