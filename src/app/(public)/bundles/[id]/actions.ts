"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { BUNDLE_CHECKOUT_UNAVAILABLE_MESSAGE } from "@/lib/connect-account";

export async function buyBundle(bundleId: string) {
  // LAUNCH-1 P1-11: defense-in-depth -- Proxy already blocks the
  // /bundles/[id] page itself while a recovery session is active, so
  // this is the second layer against a crafted direct POST. Runs before
  // any Supabase call below.
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/bundles/${bundleId}`);
  }

  // STRIPE-DISABLE-1: paid bundle checkout is unavailable under every
  // configuration until separate POK bundle support is designed and
  // reviewed (locked product decision -- POK phase one supports single
  // books only). This is a deliberately unconditional fail-closed exit:
  // no bundle row is fetched, no bundle_books membership is read, no
  // user_owns_book RPC runs, no create_bundle_checkout_snapshot RPC
  // runs, and no Stripe or POK call is ever reached, whether this action
  // is reached via the (now non-clickable) UI control or a direct/stale
  // invocation. The corresponding Stripe Checkout Session creation call
  // site that used to follow further down this function has been
  // removed entirely, not merely made unreachable.
  redirect(`/bundles/${bundleId}?error=${encodeURIComponent(BUNDLE_CHECKOUT_UNAVAILABLE_MESSAGE)}`);
}
