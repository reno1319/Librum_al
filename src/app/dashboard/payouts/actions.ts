"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { resolveSiteOrigin } from "@/lib/site-url";

export async function connectStripeAccount() {
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

  let accountId = profile?.stripe_account_id;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
    accountId = account.id;

    // Written with the admin client: regular users aren't allowed to
    // update this column themselves (see schema.sql).
    const admin = createAdminClient();
    await admin
      .from("profiles")
      .update({ stripe_account_id: accountId })
      .eq("id", user.id);
  }

  const origin = resolveSiteOrigin();

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${origin}/dashboard/payouts`,
    return_url: `${origin}/dashboard/payouts`,
    type: "account_onboarding",
  });

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
