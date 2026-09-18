import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import RealStripe from "stripe";

// ALL-CUTOVER APP-A / STRIPE-RETIREMENT: exercises the real POST()
// handler end-to-end (not the individual fulfillment helpers, which the
// adjacent route.test.ts already covers in isolation and are unchanged
// by this patch). createAdminClient is mocked to THROW -- a passing
// test is itself the proof that POST() never reaches it for any
// verified event type.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("retired Stripe webhook must never construct a Supabase admin client");
  },
}));

const { POST } = await import("./route");

const PLATFORM_SECRET = "whsec_test_retirement_platform_secret_000000000000";
const signingClient = new RealStripe("sk_test_unused_signing_client_only");

function sign(payloadObject: Record<string, unknown>, secret: string) {
  const payload = JSON.stringify(payloadObject);
  const header = signingClient.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

function makeRequest(body: string, signature?: string) {
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: signature ? { "stripe-signature": signature } : {},
    body,
  });
}

describe("POST /api/webhooks/stripe (retired)", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unused_for_retirement_tests");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", PLATFORM_SECRET);
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a validly signed test-mode event returns 200 with a minimal sanitized log and makes zero Supabase calls", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const payload = {
      id: "evt_retirement_test_1",
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      data: { object: { id: "cs_retirement_test_1", object: "checkout.session" } },
    };
    const { payload: body, header } = sign(payload, PLATFORM_SECRET);

    const response = await POST(makeRequest(body, header));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, retired: true });

    // Exactly one log call, containing only the verified, redacted fields
    // -- never the raw event id, never anything from the request body
    // beyond what the code itself derived from the VERIFIED event.
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [label, fields] = logSpy.mock.calls[0];
    expect(label).toBe("stripe_webhook_retired");
    expect(fields).toMatchObject({ eventType: "checkout.session.completed", testMode: true });
    expect((fields as { eventIdRedacted: string }).eventIdRedacted).not.toBe(payload.id);
    expect(Object.keys(fields as object).sort()).toEqual(["eventIdRedacted", "eventType", "testMode"]);
    // createAdminClient throwing (see the module mock above) would have
    // made this test itself fail with an unhandled error -- reaching
    // this assertion at all is the proof no Supabase call occurred.
  });

  it("every verified event type returns 200 and retired: true, regardless of type", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const type of ["charge.refunded", "charge.dispute.created", "account.updated", "refund.failed"]) {
      const { payload: body, header } = sign(
        { id: `evt_${type}_1`, object: "event", type, livemode: false, data: { object: {} } },
        PLATFORM_SECRET,
      );
      const response = await POST(makeRequest(body, header));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ received: true, retired: true });
    }
    expect(logSpy).toHaveBeenCalledTimes(4);
  });

  it("missing signature preserves the existing 400 behavior, with no log of any payload field", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");

    const response = await POST(makeRequest(JSON.stringify({ type: "checkout.session.completed" })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Missing signature" });
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("invalid signature preserves the existing 400 behavior, with no attacker-controlled payload field logged", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");
    const attackerPayload = {
      id: "evt_attacker_supplied_id",
      object: "event",
      type: "account.updated",
      data: { object: {} },
    };
    const body = JSON.stringify(attackerPayload);

    const response = await POST(makeRequest(body, "t=1,v1=not_a_real_signature"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid signature" });
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
