import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { connectStripeAccount, openStripeExpressDashboard } from "./actions";

export default async function PayoutsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_account_id, stripe_payouts_enabled")
    .eq("id", user!.id)
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
        .eq("id", user!.id);
    }
  }

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold">Payouts</h1>
      <p className="mt-2 text-sm text-gray-600">
        Dante uses Stripe to pay you directly for every sale — Stripe
        handles identity verification and tax forms, and takes care of
        the actual bank transfer. You keep {100 - PLATFORM_FEE_PERCENT}%
        of each sale.
      </p>

      <div className="mt-8 rounded-md border border-gray-200 p-6">
        {!profile?.stripe_account_id ? (
          <>
            <p className="text-sm text-gray-700">
              You haven&apos;t connected a payout account yet. You&apos;ll
              need to do this before you can publish a book.
            </p>
            <form action={connectStripeAccount} className="mt-4">
              <button
                type="submit"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
              >
                Connect with Stripe
              </button>
            </form>
          </>
        ) : payoutsEnabled ? (
          <>
            <p className="text-sm font-medium text-green-700">
              Payouts are active — you&apos;ll be paid automatically for
              every sale.
            </p>
            <form action={openStripeExpressDashboard} className="mt-4">
              <button
                type="submit"
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50"
              >
                View Stripe dashboard
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-700">
              You started connecting a payout account, but Stripe still
              needs a bit more information before you can get paid.
            </p>
            <form action={connectStripeAccount} className="mt-4">
              <button
                type="submit"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
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
