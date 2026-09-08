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

// ---------------------------------------------------------------------
// BANK-PAYOUT-1E: Payout setup section -- same source-level regression
// convention as the block above (no DOM harness for Server Component
// pages in this repo). The underlying logic (maskIban,
// PAYOUT_DESTINATION_CURRENCY) is unit-tested in balance-logic.test.ts;
// the Server Action itself in actions.test.ts. This file only guards
// how page.tsx wires that already-tested logic into the UI.
// ---------------------------------------------------------------------
describe("Dashboard Balance: Payout setup section", () => {
  it("imports the destination read/write primitives and maskIban from their real modules", () => {
    expect(source).toMatch(/getAuthorPayoutDestination,\s*\n\s*saveAuthorPayoutDestination,/);
    expect(source).toContain("maskIban,");
    expect(source).toContain("PAYOUT_DESTINATION_CURRENCY,");
  });

  it("fetches the destination via getAuthorPayoutDestination() only when the rollout switch is enabled", () => {
    expect(source).toMatch(/bankPayoutSetupEnabled\s*\n\s*\?\s*getAuthorPayoutDestination\(\)/);
  });

  it("never calls getAuthorPayoutDestination() unconditionally -- the disabled branch resolves without it (data-minimization, BANK-PAYOUT-1E.1 Section 8)", () => {
    expect(source).toContain(": Promise.resolve({ ok: true, data: null }");
    expect(source).not.toMatch(/^\s*getAuthorPayoutDestination\(\),\s*$/m);
  });

  it("imports and computes bankPayoutSetupEnabled from isBankPayoutSetupEnabled(process.env.BANK_PAYOUT_SETUP_ENABLED)", () => {
    expect(source).toContain("isBankPayoutSetupEnabled,");
    expect(source).toContain(
      "const bankPayoutSetupEnabled = isBankPayoutSetupEnabled(process.env.BANK_PAYOUT_SETUP_ENABLED);",
    );
  });

  it("the entire Payout setup section is gated on bankPayoutSetupEnabled -- omitted entirely while disabled, not merely a disabled form", () => {
    expect(source).toContain("{bankPayoutSetupEnabled && (");
  });

  it("renders the Payout setup section OUTSIDE the isEmpty ternary, so it is always visible", () => {
    const sectionIndex = source.indexOf('<h2 className="font-serif text-xl font-semibold">Payout setup</h2>');
    const ternaryCloseIndex = source.indexOf("        </>\n      )}\n\n      {/* BANK-PAYOUT-1E");
    expect(sectionIndex).toBeGreaterThan(-1);
    expect(ternaryCloseIndex).toBeGreaterThan(-1);
    expect(sectionIndex).toBeGreaterThan(ternaryCloseIndex);
  });

  it("no-destination state: shows the approved neutral setup prompt, no alarm styling implied", () => {
    expect(source).toContain(
      "Add a bank account to become eligible for payouts once payouts are activated.",
    );
  });

  it("configured-destination state: shows a compact '✓ Added' status with account holder, masked IBAN, and currency", () => {
    expect(source).toContain("&#10003; Added");
    expect(source).toContain("{destination.beneficiary_name}");
    expect(source).toContain("{destination.currency}");
  });

  it("the full IBAN is never rendered in the saved-state output -- only maskIban(destination.iban)", () => {
    expect(source).toContain("{maskIban(destination.iban)}");
    // The raw, unmasked field must never appear as its own rendered
    // expression anywhere in the file.
    expect(source).not.toMatch(/\{destination\.iban\}/);
  });

  it("the IBAN input is never prefilled with the existing value (no defaultValue anywhere on the page)", () => {
    expect(source).not.toContain("defaultValue");
  });

  it("provides a 'Change bank account' affordance when a destination already exists", () => {
    expect(source).toContain("Change bank account");
    expect(source).toContain('href="/dashboard/balance?editBank=1"');
  });

  it("explains that changing the bank account affects future payouts only, with the frozen-snapshot guarantee stated accurately", () => {
    expect(source).toContain(
      "Changing your bank account affects future payouts only. Any payout already being processed keeps the bank details frozen for that payout.",
    );
  });

  it("threshold unavailable state: shows the approved copy when no minimum policy is configured, without inventing a number", () => {
    expect(source).toContain(
      "Payout threshold will become available when Librum activates its minimum payout policy.",
    );
    // Never a hardcoded numeric threshold anywhere near this copy.
    const thresholdSectionIndex = source.indexOf("Payout threshold</h3>");
    const sectionSnippet = source.slice(thresholdSectionIndex, thresholdSectionIndex + 400);
    expect(sectionSnippet).not.toMatch(/\d+(?:\.\d+)?\s*(ALL|USD|EUR|Lek)/);
  });

  it("the threshold state is derived from get_author_payout_overview()'s own minimum_policy_configured field, never hardcoded to a single branch", () => {
    expect(source).toContain("minimum_policy_configured");
    expect(source).toContain("minimumPolicyConfigured");
  });

  it("currency is fixed/read-only in the form -- no <select> or editable currency input exists", () => {
    expect(source).not.toContain("<select");
    expect(source).not.toMatch(/name="currency"/);
  });

  it("the save form posts to saveAuthorPayoutDestination, never a raw fetch/RPC call from the client", () => {
    expect(source).toContain("<form action={saveAuthorPayoutDestination}");
  });

  it("only collects beneficiary name and IBAN -- no bank password/username/card-number/BIC/SWIFT/bank-name/KYC field exists", () => {
    // Scoped to the form fields ("name=" attributes) rather than the
    // whole file's prose, so this can never false-positive on an
    // unrelated existing identifier like the pre-existing BalanceCard
    // component (which legitimately contains "Card").
    const nameAttributes = source.match(/name="[a-zA-Z]+"/g) ?? [];
    for (const attr of nameAttributes) {
      expect(attr.toLowerCase()).not.toMatch(/password|username|card|bic|swift|kyc|bankname/);
    }
    expect(source.toLowerCase()).not.toContain("swift");
    expect(source.toLowerCase()).not.toContain(" bic ");
    expect(source.toLowerCase()).not.toContain("kyc");
    expect(source.toLowerCase()).not.toContain("bank password");
    expect(source.toLowerCase()).not.toContain("bank username");
  });

  it("never claims independent account-ownership verification -- 'format' is qualified, 'verified' alone about the account never appears", () => {
    expect(source).toContain("this confirms the format");
    expect(source).toContain("not that the account belongs to you");
    expect(source.toLowerCase()).not.toContain("account verified");
    expect(source.toLowerCase()).not.toContain("bank account verified");
  });

  it("this new section carries no Stripe-specific payout promise (distinct from the untouched /dashboard/payouts Stripe Connect page)", () => {
    const setupSectionIndex = source.indexOf('<h2 className="font-serif text-xl font-semibold">Payout setup</h2>');
    const finalAlertIndex = source.indexOf('Looking for unit sales and page views?');
    const setupSection = source.slice(setupSectionIndex, finalAlertIndex);
    expect(setupSection.toLowerCase()).not.toContain("stripe");
  });
});

// ---------------------------------------------------------------------
// BANK-PAYOUT-1E.1 Section 11: /dashboard/payouts (the live Stripe
// Connect onboarding surface that still gates real paid-book
// publishing via profiles.stripe_payouts_enabled) must remain
// completely untouched by this rollout gate -- a durable regression
// guard against a future change accidentally touching it in the same
// pass as this feature.
// ---------------------------------------------------------------------
describe("Dashboard Balance: /dashboard/payouts (Stripe Connect) remains untouched", () => {
  const payoutsSource = readFileSync(
    path.join(__dirname, "..", "payouts", "page.tsx"),
    "utf8",
  );

  it("still imports and calls the real Stripe SDK -- no redirect/neutralization was introduced", () => {
    expect(payoutsSource).toContain('import { stripe } from "@/lib/stripe"');
    expect(payoutsSource).toContain("stripe.accounts.retrieve(");
  });

  it("still reads/writes stripe_account_id and stripe_payouts_enabled, the live publishing gate", () => {
    expect(payoutsSource).toContain("stripe_account_id");
    expect(payoutsSource).toContain("stripe_payouts_enabled");
  });

  it("does not import or reference anything from the new bank-destination module", () => {
    expect(payoutsSource).not.toContain("saveAuthorPayoutDestination");
    expect(payoutsSource).not.toContain("getAuthorPayoutDestination");
    expect(payoutsSource).not.toContain("isBankPayoutSetupEnabled");
  });
});
