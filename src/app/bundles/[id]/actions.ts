"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe";
import { platformFeeCents } from "@/lib/pricing";

type BundleForCheckout = {
  id: string;
  title: string;
  price_cents: number;
  status: string;
  author_id: string;
  profiles: {
    stripe_account_id: string | null;
    stripe_payouts_enabled: boolean;
  } | null;
};

export async function buyBundle(bundleId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/bundles/${bundleId}`);
  }

  const { data: bundle } = await supabase
    .from("bundles")
    .select(
      "id, title, price_cents, status, author_id, profiles(stripe_account_id, stripe_payouts_enabled)",
    )
    .eq("id", bundleId)
    .single<BundleForCheckout>();

  if (!bundle || bundle.status !== "published" || bundle.author_id === user.id) {
    redirect(`/bundles/${bundleId}`);
  }

  const authorAccount = bundle.profiles?.stripe_account_id;
  if (!bundle.profiles?.stripe_payouts_enabled || !authorAccount) {
    redirect(`/bundles/${bundleId}?error=This+bundle+isn%27t+available+for+purchase+right+now`);
  }

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

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: bundle.title },
          unit_amount: bundle.price_cents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: platformFeeCents(bundle.price_cents),
      transfer_data: {
        destination: authorAccount,
      },
    },
    success_url: `${origin}/bundles/${bundleId}?purchase=success`,
    cancel_url: `${origin}/bundles/${bundleId}?purchase=cancelled`,
    metadata: {
      bundle_id: bundleId,
      reader_id: user.id,
    },
  });

  if (!session.url) {
    redirect(`/bundles/${bundleId}?error=Could+not+start+checkout`);
  }

  redirect(session.url);
}
