import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const config = vi.hoisted(() => vi.fn());
const fulfill = vi.hoisted(() => vi.fn());
const repo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pok", async () => ({ ...(await vi.importActual<typeof import("@/lib/pok")>("@/lib/pok")),
  getPokConfig: config, createPokClient: vi.fn(() => ({})) }));
vi.mock("@/lib/pok-checkout", () => ({ fulfillPokCheckout: fulfill }));
vi.mock("@/lib/pok-repository", () => ({ createPokRepository: repo }));
import { POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const request = () => new Request(`https://librum.example/api/payments/pok/webhook?intent=${id}&token=${token}`, {
  method: "POST", body: JSON.stringify({ isCompleted: true, capturedAmount: 999, merchant: "forged" }),
});
describe("POK webhook", () => {
  beforeEach(() => { config.mockReset().mockReturnValue({ merchantId: "merchant" }); fulfill.mockReset(); repo.mockReset().mockReturnValue({}); });
  it("invalid callback parameters never reach privileged code", async () => {
    expect((await POST(new Request("https://librum.example/api/payments/pok/webhook", { method: "POST" }))).status).toBe(400);
    expect(config).not.toHaveBeenCalled(); expect(fulfill).not.toHaveBeenCalled(); expect(repo).not.toHaveBeenCalled();
  });
  it("only passes callback identity; body-supplied payment facts are ignored", async () => {
    fulfill.mockResolvedValue({ status: "fulfilled", bookId: "book" });
    expect((await POST(request())).status).toBe(200);
    expect(fulfill).toHaveBeenCalledWith({ intentId: id, token, merchantId: "merchant" }, {}, {});
  });
  it("unpaid verification requests retry without reporting success", async () => {
    fulfill.mockResolvedValue({ status: "pending" }); expect((await POST(request())).status).toBe(503);
  });
  it("terminal business blocks are acknowledged", async () => {
    fulfill.mockResolvedValue({ status: "blocked" }); expect((await POST(request())).status).toBe(200);
  });
  // POK-FULFILMENT-1: the complete status-to-code mapping, asserted as a
  // table so that adding a fifth status without deciding its HTTP answer
  // fails here. 'pending' is the only retry; everything else is
  // acknowledged, which is what bounds the 503 loop.
  it.each([
    { status: "fulfilled", code: 200 },
    { status: "pending", code: 503 },
    { status: "closed_unpaid", code: 200 },
    { status: "blocked", code: 200 },
  ])("answers $code for $status", async ({ status, code }) => {
    fulfill.mockResolvedValue({ status, bookId: "book" });
    expect((await POST(request())).status).toBe(code);
  });
  it("never leaks a cause, an error code, a timestamp, an order id or a token in the body", async () => {
    fulfill.mockResolvedValue({ status: "blocked", bookId: "book" });
    const body = await (await POST(request())).text();
    expect(JSON.parse(body)).toEqual({ received: true, status: "blocked" });
    for (const secret of [token, "fulfilment_gap_", "fulfilment_blocked_", "first_seen", "2026-"]) {
      expect(body).not.toContain(secret);
    }
  });
  it("configuration failure cannot reach DB or payment API", async () => {
    config.mockImplementation(() => { throw new Error("POK_STAGING_ONLY"); });
    const response = await POST(request()); expect(response.status).toBe(503);
    expect(repo).not.toHaveBeenCalled(); expect(fulfill).not.toHaveBeenCalled();
  });
  it("provider errors expose no secret diagnostics", async () => {
    fulfill.mockRejectedValue(new Error("private secret"));
    const response = await POST(request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private secret");
  });
});

// ALL-CUTOVER APP-A: gated before any query parsing and before any POK
// call -- POK is not being retired, so this is the same 503 shape the
// route's own "pending" branch already uses, not a permanent response.
describe("POK webhook: maintenance-mode gate", () => {
  beforeEach(() => {
    config.mockReset().mockReturnValue({ merchantId: "merchant" }); fulfill.mockReset(); repo.mockReset().mockReturnValue({});
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns 503 and never reaches POK config/repository/fulfillment", async () => {
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(config).not.toHaveBeenCalled(); expect(fulfill).not.toHaveBeenCalled(); expect(repo).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves existing behavior", async () => {
    vi.unstubAllEnvs();
    fulfill.mockResolvedValue({ status: "fulfilled", bookId: "book" });
    expect((await POST(request())).status).toBe(200);
    expect(fulfill).toHaveBeenCalled();
  });
});
