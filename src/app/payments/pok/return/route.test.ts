import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), getUser: vi.fn(), config: vi.fn(), fulfill: vi.fn(), repo: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (target: string) => { throw Object.assign(new Error("redirect"), { target }); } }));
vi.mock("@/lib/recovery-guard", () => ({ redirectIfRecoverySessionActive: mocks.guard }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/pok", async () => ({ ...(await vi.importActual<typeof import("@/lib/pok")>("@/lib/pok")), getPokConfig: mocks.config, createPokClient: () => ({}) }));
vi.mock("@/lib/pok-checkout", () => ({ fulfillPokCheckout: mocks.fulfill }));
vi.mock("@/lib/pok-repository", () => ({ createPokRepository: mocks.repo }));
import { GET } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const request = () => new Request(`https://librum.example/payments/pok/return?intent=${id}&token=${token}&isCompleted=true`);
describe("POK browser return", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "reader" } } });
    mocks.config.mockReturnValue({ merchantId: "merchant" }); mocks.repo.mockReturnValue({});
  });
  it("active recovery session stops before auth/payment calls", async () => {
    mocks.guard.mockRejectedValue(Object.assign(new Error("recovery"), { target: "/reset-password" }));
    await expect(GET(request())).rejects.toMatchObject({ target: "/reset-password" });
    expect(mocks.getUser).not.toHaveBeenCalled(); expect(mocks.fulfill).not.toHaveBeenCalled();
  });
  it("invalid return cannot reach privileged code", async () => {
    await expect(GET(new Request("https://librum.example/payments/pok/return"))).rejects.toMatchObject({ target: "/library?error=Invalid+payment+return" });
    expect(mocks.repo).not.toHaveBeenCalled(); expect(mocks.fulfill).not.toHaveBeenCalled();
  });
  it("unauthenticated return goes to login without fulfillment", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await expect(GET(request())).rejects.toMatchObject({ target: expect.stringContaining("/login?next=") });
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });
  it("binds original reader and only reports verified fulfillment", async () => {
    mocks.fulfill.mockResolvedValue({ status: "fulfilled", bookId: "book" });
    await expect(GET(request())).rejects.toMatchObject({ target: "/books/book?purchase=success" });
    expect(mocks.fulfill).toHaveBeenCalledWith({ intentId: id, token, merchantId: "merchant", readerId: "reader" }, {}, {});
  });
  it("browser success query does not make an unpaid verification successful", async () => {
    mocks.fulfill.mockResolvedValue({ status: "pending", bookId: "book" });
    await expect(GET(request())).rejects.toMatchObject({ target: "/books/book?error=Payment+verification+pending" });
  });
  // POK-FULFILMENT-1: four statuses, four DISTINCT destinations. Before
  // this, 'blocked' and 'closed_unpaid' both read as "verification
  // pending", so a reader whose payment needed a human -- or whose order
  // had died unpaid -- was told to keep waiting for something that was
  // never going to arrive.
  it.each([
    { status: "fulfilled", target: "/books/book?purchase=success" },
    { status: "pending", target: "/books/book?error=Payment+verification+pending" },
    { status: "closed_unpaid", target: "/books/book?error=Payment+was+not+completed" },
    { status: "blocked", target: "/books/book?error=Payment+needs+review" },
  ])("sends $status to its own destination", async ({ status, target }) => {
    mocks.fulfill.mockResolvedValue({ status, bookId: "book" });
    await expect(GET(request())).rejects.toMatchObject({ target });
  });
  it("gives the four statuses four distinct destinations", async () => {
    const targets = new Set<string>();
    for (const status of ["fulfilled", "pending", "closed_unpaid", "blocked"]) {
      mocks.fulfill.mockResolvedValue({ status, bookId: "book" });
      targets.add(await GET(request()).then(() => "", (err: { target: string }) => err.target));
    }
    expect(targets.size).toBe(4);
  });
  it("never puts a cause, an error code or a timestamp in the redirect", async () => {
    mocks.fulfill.mockResolvedValue({ status: "blocked", bookId: "book" });
    const target = await GET(request()).then(() => "", (err: { target: string }) => err.target);
    for (const secret of [token, "fulfilment_gap_", "fulfilment_blocked_", "2026-"]) {
      expect(target).not.toContain(secret);
    }
  });
  it("verification errors expose no private details", async () => {
    mocks.fulfill.mockRejectedValue(new Error("private secret"));
    await expect(GET(request())).rejects.toMatchObject({ target: "/library?error=Payment+verification+pending" });
  });
});

// ALL-CUTOVER APP-A: gated before any query parsing, before
// redirectIfRecoverySessionActive(), and before any Supabase/POK call.
// A stable 503 response, not a redirect -- POK is not being retired.
describe("POK browser return: maintenance-mode gate", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "reader" } } });
    mocks.config.mockReturnValue({ merchantId: "merchant" }); mocks.repo.mockReturnValue({});
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns 503 and never reaches the recovery guard, Supabase, or POK", async () => {
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves existing behavior", async () => {
    vi.unstubAllEnvs();
    mocks.fulfill.mockResolvedValue({ status: "fulfilled", bookId: "book" });
    await expect(GET(request())).rejects.toMatchObject({ target: "/books/book?purchase=success" });
  });
});
