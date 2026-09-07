import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LEDGER-1E-D-G: source-level regression coverage for the "Next payout
// cycle" notice on /dashboard/balance, following the same no-DOM-harness
// convention already established for Server Component pages (see
// src/app/(public)/dashboard/profile/page.test.ts) -- these assert
// directly on the real page.tsx text, not a rendered tree. The
// underlying date/gating LOGIC is already fully covered by
// src/lib/payout-cycle.test.ts (boundary/DST/rollover) and
// src/lib/payout-scheduler.test.ts (isSchedulerEnabled); this file only
// guards how page.tsx wires that already-tested logic into the UI.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("Dashboard Balance: payout-cycle notice", () => {
  it("imports isSchedulerEnabled and the payout-cycle helpers from their real modules (no reimplementation)", () => {
    expect(source).toContain('import { isSchedulerEnabled } from "@/lib/payout-scheduler";');
    expect(source).toContain(
      'import { computeNextPayoutCycleDate, formatPayoutCycleDate } from "@/lib/payout-cycle";',
    );
  });

  it("gates the notice on isSchedulerEnabled(process.env.PAYOUT_SCHEDULER_ENABLED) -- the same switch the scheduler route itself reads, never a second definition", () => {
    expect(source).toContain(
      "const schedulerEnabled = isSchedulerEnabled(process.env.PAYOUT_SCHEDULER_ENABLED);",
    );
  });

  it("shows the exact approved neutral disabled-state copy", () => {
    expect(source).toContain("Monthly payout scheduling is not yet active.");
  });

  it("the enabled-state heading is computed from the real helpers, never a hardcoded date", () => {
    expect(source).toContain(
      "`Next payout cycle: ${formatPayoutCycleDate(computeNextPayoutCycleDate())}`",
    );
  });

  it("the notice sits before the isEmpty branch, so it is always visible regardless of ledger activity", () => {
    const noticeIndex = source.indexOf("LEDGER-1E-D-G: forward-looking payout-cycle policy notice");
    const isEmptyIndex = source.indexOf("{isEmpty ? (");
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(isEmptyIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(isEmptyIndex);
  });

  it("never surfaces a specific clock time to the author -- the business promise is the date only (Section 9)", () => {
    const notice = source.slice(
      source.indexOf("LEDGER-1E-D-G: forward-looking payout-cycle policy notice"),
      source.indexOf("{isEmpty ? ("),
    );
    expect(notice).not.toMatch(/\b0?6:00\b/);
    expect(notice).not.toMatch(/\b0?7:00\b/);
    expect(notice).not.toMatch(/\b0?8:00\b/);
    expect(notice).not.toMatch(/UTC/);
  });

  it("never implies a bank-receipt or transfer date (Section 14's forbidden phrasing)", () => {
    const notice = source.slice(
      source.indexOf("LEDGER-1E-D-G: forward-looking payout-cycle policy notice"),
      source.indexOf("{isEmpty ? ("),
    );
    expect(notice.toLowerCase()).not.toContain("arrive");
    expect(notice.toLowerCase()).not.toContain("bank");
    expect(notice.toLowerCase()).not.toContain("your money");
    expect(notice).not.toContain("Payment date");
  });

  it("the page header description no longer claims a payout date is unscheduled once the scheduler is enabled (no future self-contradiction against the notice above)", () => {
    expect(source).toContain(
      `schedulerEnabled ? "." : " — an exact payout date isn't scheduled yet."`,
    );
  });
});
