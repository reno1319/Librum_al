import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate on this
// schema-sensitive dashboard payouts page (V3 §3) -- this page makes a
// REAL outbound Stripe call (accounts.retrieve) and a real Supabase
// admin write directly at render time when an account is on file, so
// this is the strongest case among the eight gated pages for proving
// zero provider/DB calls while maintenance is active.
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn(() => {
  throw SENTINEL;
});
const mockCreateAdminClient = vi.fn(() => { throw new Error("ADMIN_CLIENT_CALLED"); });
const mockGetStripe = vi.fn(() => { throw new Error("GET_STRIPE_CALLED"); });
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => mockGetStripe() }));
vi.mock("./actions", () => ({ openStripeExpressDashboard: vi.fn() }));

const { default: PayoutsPage } = await import("./page");

function pageArgs() {
  return { searchParams: Promise.resolve({}) };
}

describe("PayoutsPage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockGetStripe.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase or Stripe calls", async () => {
    const element = await PayoutsPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockGetStripe).not.toHaveBeenCalled();
  });

  it("the notice contains no Stripe account id or other configuration/identifier value", async () => {
    const element = await PayoutsPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html.toLowerCase()).not.toContain("stripe");
    expect(html.toLowerCase()).not.toContain("acct_");
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(PayoutsPage(pageArgs())).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});
