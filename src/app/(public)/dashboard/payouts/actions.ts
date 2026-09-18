"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";

// STRIPE-DISABLE-1: shown whenever an author reaches connectStripeAccount
// -- new Stripe Connect account creation, and finishing onboarding for an
// account that isn't fully payout-ready yet, are both disabled under
// every configuration (locked product decision). Deliberately the same
// generic, no-internal-detail message this action's failure redirects
// already used before this patch.
const CONNECT_ONBOARDING_UNAVAILABLE_REDIRECT =
  "/dashboard/payouts?error=Connecting+a+payout+account+is+temporarily+unavailable.+Please+check+back+later.";

export async function connectStripeAccount() {
  // AUTH-1C: defense-in-depth -- Proxy already blocks /dashboard/*
  // while a recovery session is active, so this is the second layer
  // against a crafted direct POST. Runs before any Supabase call.
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // STRIPE-DISABLE-1: new Stripe Connect account creation is disabled
  // for this patch -- fails closed here, before any profile read, any
  // Stripe API call of any kind, and any DB mutation, whether or not
  // this author already has a stripe_account_id on file (i.e. this
  // covers both "never connected" and "started onboarding but not
  // payouts-ready yet"). openStripeExpressDashboard below is the only
  // remaining reachable action, and only for an author whose connection
  // is already payouts-enabled.
  redirect(CONNECT_ONBOARDING_UNAVAILABLE_REDIRECT);
}

export async function openStripeExpressDashboard() {
  // ALL-CUTOVER APP-A: gated before any Supabase/Stripe call -- this
  // action makes a real outbound Stripe API call
  // (accounts.createLoginLink), and no provider request may occur while
  // the maintenance window is active.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard/payouts");
  }

  // AUTH-1C: defense-in-depth, same reasoning as connectStripeAccount()
  // above -- Stripe's own Express Dashboard is where an already-
  // connected author can view/change bank details and payout
  // destination, so this is just as materially sensitive as the
  // onboarding link itself. Runs before any Supabase/Stripe call.
  await redirectIfRecoverySessionActive();

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

  const loginLink = await getStripe().accounts.createLoginLink(profile.stripe_account_id);
  redirect(loginLink.url);
}
