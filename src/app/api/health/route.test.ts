import { describe, expect, it, vi } from "vitest";

// ALL-CUTOVER APP-A: proves the health route cannot even indirectly
// reach Supabase or a provider client -- every module capable of
// constructing one is mocked to throw synchronously on first use. If
// route.ts's GET() ever imported or called any of these, the test
// itself would fail (a thrown error), not just an assertion.
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => {
    throw new Error("health route must never construct a Supabase client");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("health route must never construct a Supabase admin client");
  },
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    throw new Error("health route must never construct a Stripe client");
  },
}));
vi.mock("@/lib/pok", () => ({
  createPokClient: () => {
    throw new Error("health route must never construct a POK client");
  },
  getPokConfig: () => {
    throw new Error("health route must never read POK config");
  },
}));

describe("GET /api/health", () => {
  it("returns a fixed 200 JSON body with no Supabase/provider construction", async () => {
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("response body contains no secret, environment, or configuration value", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["ok"]);
  });
});
