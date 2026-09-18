import { createPokClient, getPokConfig, uuid } from "@/lib/pok";
import { fulfillPokCheckout } from "@/lib/pok-checkout";
import { createPokRepository } from "@/lib/pok-repository";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { maintenanceHttpResponse } from "@/lib/maintenance-response";

export const runtime = "nodejs";
export async function POST(request: Request) {
  // ALL-CUTOVER APP-A: gated before any query parsing and before any
  // POK call. POK is not being retired -- this is a temporary,
  // retryable 503, matching the shape this route's own existing
  // "pending" branch already uses.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return maintenanceHttpResponse();
  }

  const query = new URL(request.url).searchParams;
  const intent = uuid.safeParse(query.get("intent"));
  const token = uuid.safeParse(query.get("token"));
  if (!intent.success || !token.success) return Response.json({ error: "Invalid callback" }, { status: 400 });
  try {
    const config = getPokConfig();
    // No documented signature contract is assumed. Ignore the entire body;
    // the unguessable per-order URL token permits only authenticated retrieval.
    const result = await fulfillPokCheckout({ intentId: intent.data, token: token.data, merchantId: config.merchantId },
      createPokRepository(), createPokClient(config));
    // Pending needs retry: never acknowledge it as fulfilled commerce.
    return Response.json({ received: true, status: result.status }, {
      status: result.status === "pending" ? 503 : 200, headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Do not print callback tokens, credentials, card payloads or provider bodies.
    return Response.json({ error: "Payment verification unavailable" }, { status: 503 });
  }
}
