import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { createPokClient, getPokConfig, uuid } from "@/lib/pok";
import { fulfillPokCheckout } from "@/lib/pok-checkout";
import { createPokRepository } from "@/lib/pok-repository";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { maintenanceHttpResponse } from "@/lib/maintenance-response";

// Fixed reader-facing messages (the only text this route puts in a URL).
const INVALID_RETURN_MESSAGE = "Kthimi nga pagesa nuk është i vlefshëm.";
const PENDING_MESSAGE = "Pagesa po verifikohet ende.";
const NOT_COMPLETED_MESSAGE = "Pagesa nuk u krye.";
const NEEDS_REVIEW_MESSAGE = "Pagesa duhet të shqyrtohet nga ne.";

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
  if (!intent.success || !token.success) redirect(`/library?error=${encodeURIComponent(INVALID_RETURN_MESSAGE)}`);
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  // R3-ADDR: the login target is the resume page, not this route; see
  // ../resume/page.tsx for why. Only the two validated values are carried.
  if (!user) {
    const resume = new URLSearchParams({ intent: intent.data, token: token.data });
    redirect(`/login?next=${encodeURIComponent(`/payments/pok/resume?${resume}`)}`);
  }
  let destination = `/library?error=${encodeURIComponent(PENDING_MESSAGE)}`;
  try {
    const config = getPokConfig();
    const result = await fulfillPokCheckout({ intentId: intent.data, token: token.data, readerId: user.id, merchantId: config.merchantId },
      createPokRepository(), createPokClient(config));
    // POK-FULFILMENT-1: four statuses, four destinations. Before this,
    // 'blocked' and 'pending' were indistinguishable to the reader --
    // both said "verification pending", so someone whose payment needed a
    // human, or whose order had died unpaid, was told to keep waiting for
    // something that was never going to arrive.
    //
    // Each message is a fixed literal. No cause, no last_error_code, no
    // timestamp and no provider text ever reaches the query string.
    destination = result.status === "fulfilled" ? `/books/${result.bookId}?purchase=success`
      : result.status === "closed_unpaid" ? `/books/${result.bookId}?error=${encodeURIComponent(NOT_COMPLETED_MESSAGE)}`
      : result.status === "blocked" ? `/books/${result.bookId}?error=${encodeURIComponent(NEEDS_REVIEW_MESSAGE)}`
      : `/books/${result.bookId}?error=${encodeURIComponent(PENDING_MESSAGE)}`;
  } catch { /* generic, non-secret diagnostic only */ }
  redirect(destination);
}
