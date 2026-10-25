import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { PAYOUT_CYCLE_CRON_EXPRESSION } from "./payout-cycle";

// LEDGER-1E-D-G: vercel.json is static JSON, not code -- it cannot
// import PAYOUT_CYCLE_CRON_EXPRESSION from payout-cycle.ts, so the two
// are kept in sync manually. This test is the regression guard on that
// manual sync: it reads the real vercel.json directly (same technique
// already used by src/app/api/internal/payouts/run/route.test.ts's own
// source-guard tests) and locks in the cron entries structurally,
// rather than inventing a new config-testing framework for one file.
function readVercelConfig(): { crons: { path: string; schedule: string }[] } {
  const raw = readFileSync(path.join(process.cwd(), "vercel.json"), "utf8");
  return JSON.parse(raw);
}

describe("vercel.json cron configuration", () => {
  // STRIPE REMOVAL (pipeline item 10): the daily Stripe
  // reconcile-transfer-reversals cron and its route are gone.
  it("no longer registers the retired Stripe reconciliation cron", () => {
    const config = readVercelConfig();
    expect(config.crons.map((cron) => cron.path)).not.toContain(
      "/api/internal/reconcile-transfer-reversals",
    );
  });

  it("registers the payout scheduler cron with the exact approved schedule", () => {
    const config = readVercelConfig();
    const payout = config.crons.find((cron) => cron.path === "/api/internal/payouts/run");
    expect(payout).toBeDefined();
    expect(payout?.schedule).toBe("0 6 5 * *");
  });

  it("the payout cron schedule matches PAYOUT_CYCLE_CRON_EXPRESSION exactly (single source of truth)", () => {
    const config = readVercelConfig();
    const payout = config.crons.find((cron) => cron.path === "/api/internal/payouts/run");
    expect(payout?.schedule).toBe(PAYOUT_CYCLE_CRON_EXPRESSION);
  });

  it("contains exactly one cron entry -- no duplicate payout cron, nothing accidentally removed", () => {
    const config = readVercelConfig();
    expect(config.crons).toHaveLength(1);
  });

  it("no cron path appears more than once", () => {
    const config = readVercelConfig();
    const paths = config.crons.map((cron) => cron.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
