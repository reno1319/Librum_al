import { describe, expect, it, vi } from "vitest";

// AUTHOR PAGES REDESIGN (Renato's Q13): the Stripe Payouts page was
// deleted; old links must land on Financial balance, not a 404.
vi.mock("@/lib/supabase/env-guard", () => ({ assertSupabaseEnvSafeForExecution: () => {} }));

const { default: nextConfig } = await import("../../next.config");

describe("next.config redirects", () => {
  it("/dashboard/payouts redirects permanently to /dashboard/balance", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual({
      source: "/dashboard/payouts",
      destination: "/dashboard/balance",
      permanent: true,
    });
  });
});
