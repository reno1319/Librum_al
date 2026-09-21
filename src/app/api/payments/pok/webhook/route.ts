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
    // POK-FULFILMENT-1: 'pending' is the ONLY status that asks POK to
    // call again, and it is returned only where a later retrieval of the
    // same order can genuinely change the answer -- an open order, an
    // unprovable status, or a completed order still inside the transient
    // optional-field window. The other three are terminal:
    //
    //   fulfilled      the reader owns the book.
    //   closed_unpaid  the order is dead and took no money.
    //   blocked        durably recorded; a human has to look.
    //
    // Acknowledging a terminal state with 200 is what stops the unbounded
    // 503 loop this repair exists to remove. The body carries the status
    // word and nothing else -- never a cause, a last_error_code, a
    // timestamp, an order id or a token.
    return Response.json({ received: true, status: result.status }, {
      status: result.status === "pending" ? 503 : 200, headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Do not print callback tokens, credentials, card payloads or provider bodies.
    return Response.json({ error: "Payment verification unavailable" }, { status: 503 });
  }
}
