import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { createPokClient, getPokConfig, uuid } from "@/lib/pok";
import { fulfillPokCheckout } from "@/lib/pok-checkout";
import { createPokRepository } from "@/lib/pok-repository";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { maintenanceHttpResponse } from "@/lib/maintenance-response";

export const runtime = "nodejs";
export async function GET(request: Request) {
  // ALL-CUTOVER APP-A: gated before any query parsing, before
  // redirectIfRecoverySessionActive(), before any Supabase call, and
  // before any POK call. POK is not being retired -- this is a
  // temporary, retryable 503, not a permanent redirect.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return maintenanceHttpResponse();
  }

  await redirectIfRecoverySessionActive();
  const query = new URL(request.url).searchParams;
  const intent = uuid.safeParse(query.get("intent"));
  const token = uuid.safeParse(query.get("token"));
  if (!intent.success || !token.success) redirect("/library?error=Invalid+payment+return");
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/payments/pok/return?${query}`)}`);
  let destination = "/library?error=Payment+verification+pending";
  try {
    const config = getPokConfig();
    const result = await fulfillPokCheckout({ intentId: intent.data, token: token.data, readerId: user.id, merchantId: config.merchantId },
      createPokRepository(), createPokClient(config));
    destination = result.status === "fulfilled" ? `/books/${result.bookId}?purchase=success`
      : `/books/${result.bookId}?error=Payment+verification+pending`;
  } catch { /* generic, non-secret diagnostic only */ }
  redirect(destination);
}
