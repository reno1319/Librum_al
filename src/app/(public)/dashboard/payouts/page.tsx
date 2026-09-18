import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { openStripeExpressDashboard } from "./actions";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Payouts",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see V3 §3.
export const dynamic = "force-dynamic";

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive dashboard payouts page (V3 §3)
  // -- checked as the first statement, before any Supabase call and
  // before the real Stripe accounts.retrieve() call further below.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

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
    const account = await getStripe().accounts.retrieve(profile.stripe_account_id);
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
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Payouts"
          description={`Librum uses Stripe to pay you directly for every sale — Stripe handles identity verification and tax forms, and takes care of the actual bank transfer. You keep ${100 - PLATFORM_FEE_PERCENT}% of each sale.`}
        />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      <div className="mt-8 rounded-lg border border-border bg-surface p-6 shadow-sm">
        {!profile?.stripe_account_id ? (
          // STRIPE-DISABLE-1: connecting a new payout account is
          // temporarily unavailable (locked product decision) -- a
          // notice, not a working button. connectStripeAccount itself
          // also independently fails closed if invoked directly.
          <p className="text-sm text-muted">
            Connecting a payout account is temporarily unavailable. Please
            check back later.
          </p>
        ) : payoutsEnabled ? (
          <>
            <p className="text-sm font-medium text-green-700">
              Payouts are active — you&apos;ll be paid automatically for
              every sale. Bank-transfer timing depends on Stripe&apos;s own
              processing schedule, and refunded sales, or sales disputed and
              resolved against the payment, are adjusted accordingly.
            </p>
            <form action={openStripeExpressDashboard} className="mt-4">
              <button type="submit" className={buttonClasses("outline", "md")}>
                View Stripe dashboard
              </button>
            </form>
          </>
        ) : (
          // STRIPE-DISABLE-1: this author has an existing, not-yet-ready
          // Stripe account, but finishing that onboarding also runs
          // through the now-disabled connectStripeAccount -- same notice
          // as the unconnected case above, not a working button.
          <p className="text-sm text-muted">
            Finishing payout setup is temporarily unavailable. Please
            check back later.
          </p>
        )}
      </div>
    </main>
  );
}
