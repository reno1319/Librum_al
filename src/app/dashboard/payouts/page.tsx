import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { connectStripeAccount, openStripeExpressDashboard } from "./actions";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Payouts",
};

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/payouts");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_account_id, stripe_payouts_enabled")
    .eq("id", user.id)
    .single();

  let payoutsEnabled = profile?.stripe_payouts_enabled ?? false;

  // Refresh the cached status from Stripe on every visit, since Stripe
  // doesn't push updates to us unless we set up a webhook for it.
  if (profile?.stripe_account_id) {
    const account = await stripe.accounts.retrieve(profile.stripe_account_id);
    payoutsEnabled = !!account.payouts_enabled;

    if (payoutsEnabled !== profile.stripe_payouts_enabled) {
      const admin = createAdminClient();
      await admin
        .from("profiles")
        .update({ stripe_payouts_enabled: payoutsEnabled })
        .eq("id", user.id);
    }
  }

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Payouts</h1>
      <p className="mt-2 text-sm text-muted">
        Librum uses Stripe to pay you directly for every sale — Stripe
        handles identity verification and tax forms, and takes care of
        the actual bank transfer. You keep {100 - PLATFORM_FEE_PERCENT}%
        of each sale.
      </p>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-8 rounded-lg border border-border bg-surface p-6 shadow-sm">
        {!profile?.stripe_account_id ? (
          <>
            <p className="text-sm">
              You haven&apos;t connected a payout account yet. You&apos;ll
              need to do this before you can publish a paid book.
            </p>
            <form action={connectStripeAccount} className="mt-4">
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                Connect with Stripe
              </button>
            </form>
          </>
        ) : payoutsEnabled ? (
          <>
            <p className="text-sm font-medium text-green-700">
              Payouts are active — you&apos;ll be paid automatically for
              every sale. Bank-transfer timing depends on Stripe&apos;s own
              processing schedule, and refunded sales, or sales disputed and
              resolved against the payment, are adjusted accordingly.
            </p>
            <form action={openStripeExpressDashboard} className="mt-4">
              <button
                type="submit"
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover"
              >
                View Stripe dashboard
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-sm">
              You started connecting a payout account, but Stripe still
              needs a bit more information before you can get paid.
            </p>
            <form action={connectStripeAccount} className="mt-4">
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                Finish setting up payouts
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
