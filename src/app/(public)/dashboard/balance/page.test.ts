import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// APP A CORRECTION 1: declared at module scope (not inside the describe
// block below) so vitest's vi.mock hoisting -- which moves the vi.mock
// calls themselves above every import, but never reorders these const
// declarations -- can never leave the mock factories referencing
// not-yet-initialized bindings.
const CREATE_CLIENT_SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn(() => {
  throw CREATE_CLIENT_SENTINEL;
});
const mockGetAuthorFinancialSummary = vi.fn();
const mockListAuthorFinancialActivity = vi.fn();
const mockGetAuthorPayoutOverview = vi.fn();
const mockListAuthorPayoutHistory = vi.fn();
const mockGetAuthorPayoutDestination = vi.fn();
const mockSaveAuthorPayoutDestination = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("./actions", () => ({
  getAuthorFinancialSummary: () => mockGetAuthorFinancialSummary(),
  listAuthorFinancialActivity: (...args: unknown[]) => mockListAuthorFinancialActivity(...args),
  getAuthorPayoutOverview: () => mockGetAuthorPayoutOverview(),
  listAuthorPayoutHistory: (...args: unknown[]) => mockListAuthorPayoutHistory(...args),
  getAuthorPayoutDestination: () => mockGetAuthorPayoutDestination(),
  saveAuthorPayoutDestination: (...args: unknown[]) => mockSaveAuthorPayoutDestination(...args),
}));

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
// Connect onboarding surface) must remain completely untouched by this
// rollout gate -- a durable regression guard against a future change
// accidentally touching it in the same pass as this feature.
//
// PR-G corrected the WORDING here, not the assertions. That page no
// longer gates paid-book publishing -- performPublish() reads no
// profiles row at all, and canPublishPaidTitle() is the sole gate. What
// the page still does is read and WRITE profiles.stripe_account_id and
// profiles.stripe_payouts_enabled against the real Stripe SDK, which is
// author-payout operational state that later payout work will need. The
// guard is kept for exactly that reason: its justification changed, the
// thing it guards did not.
// ---------------------------------------------------------------------
describe("Dashboard Balance: /dashboard/payouts (Stripe Connect) remains untouched", () => {
  const payoutsSource = readFileSync(
    path.join(__dirname, "..", "payouts", "page.tsx"),
    "utf8",
  );

  it("still imports and calls the real Stripe SDK -- no redirect/neutralization was introduced", () => {
    expect(payoutsSource).toContain('import { getStripe } from "@/lib/stripe"');
    expect(payoutsSource).toContain("getStripe().accounts.retrieve(");
  });

  it("still reads/writes stripe_account_id and stripe_payouts_enabled, the live author-payout state", () => {
    expect(payoutsSource).toContain("stripe_account_id");
    expect(payoutsSource).toContain("stripe_payouts_enabled");
  });

  it("does not import or reference anything from the new bank-destination module", () => {
    expect(payoutsSource).not.toContain("saveAuthorPayoutDestination");
    expect(payoutsSource).not.toContain("getAuthorPayoutDestination");
    expect(payoutsSource).not.toContain("isBankPayoutSetupEnabled");
  });
});

// APP A CORRECTION 1: schema-sensitive dashboard balance page (V3 §3) --
// unlike the source-string-matching convention this file otherwise uses
// throughout, this block actually imports and calls the page component
// with the real modules mocked, since "no page-level Supabase call
// occurs" is a runtime claim, not something a source-text match alone
// can prove.
describe("BalancePage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    mockGetAuthorFinancialSummary.mockClear();
    mockListAuthorFinancialActivity.mockClear();
    mockGetAuthorPayoutOverview.mockClear();
    mockListAuthorPayoutHistory.mockClear();
    mockGetAuthorPayoutDestination.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase/Server-Action calls", async () => {
    const { default: BalancePage } = await import("./page");
    const element = await BalancePage({ searchParams: Promise.resolve({}) });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockGetAuthorFinancialSummary).not.toHaveBeenCalled();
    expect(mockListAuthorFinancialActivity).not.toHaveBeenCalled();
    expect(mockGetAuthorPayoutOverview).not.toHaveBeenCalled();
    expect(mockListAuthorPayoutHistory).not.toHaveBeenCalled();
    expect(mockGetAuthorPayoutDestination).not.toHaveBeenCalled();
  });

  it("the notice contains no ledger amount, IBAN, or other configuration/identifier value", async () => {
    const { default: BalancePage } = await import("./page");
    const element = await BalancePage({ searchParams: Promise.resolve({}) });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html.toLowerCase()).not.toContain("iban");
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    const { default: BalancePage } = await import("./page");
    await expect(BalancePage({ searchParams: Promise.resolve({}) })).rejects.toBe(
      CREATE_CLIENT_SENTINEL,
    );
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});

// ALL-TXN-CURRENCY-4 (Patch 4): rendered proof that ledger balances,
// activity and payout history stay separated by the currency each row
// was booked in -- never combined, never a bare `$`, and a malformed
// currency is shown as unavailable rather than guessed. Payout logic is
// untouched; this only checks what the page displays.
describe("BalancePage: amounts are separated by currency (Patch 4)", () => {
  function summaryRow(currency: string, base: number) {
    return {
      currency,
      available_minor: base,
      pending_minor: base + 1,
      net_earnings_minor: base + 2,
      paid_out_minor: base + 3,
      lifetime_sale_minor: base + 4,
      lifetime_refund_minor: -(base + 5),
      lifetime_adjustment_minor: 0,
    };
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation((() => ({
      auth: { getUser: async () => ({ data: { user: { id: "author-1" } } }) },
    })) as never);
    mockGetAuthorFinancialSummary.mockResolvedValue({
      ok: true,
      data: [summaryRow("USD", 1000), summaryRow("ALL", 123400)],
    });
    mockListAuthorFinancialActivity.mockResolvedValue({
      ok: true,
      data: [
        { id: "e1", entry_type: "sale", book_title: "Alpha", created_at: "2026-09-20T10:00:00Z", amount_minor: 699, currency: "USD" },
        { id: "e2", entry_type: "sale", book_title: "Beta", created_at: "2026-09-21T10:00:00Z", amount_minor: 79920, currency: "ALL" },
        { id: "e3", entry_type: "refund", book_title: "Beta", created_at: "2026-09-22T10:00:00Z", amount_minor: -800, currency: "ALL" },
        { id: "e4", entry_type: "adjustment", book_title: null, created_at: "2026-09-22T11:00:00Z", amount_minor: 500, currency: "usd" },
      ],
    });
    mockGetAuthorPayoutOverview.mockResolvedValue({ ok: true, data: [] });
    mockListAuthorPayoutHistory.mockResolvedValue({
      ok: true,
      data: [
        { id: "po1", status: "paid", created_at: "2026-09-01T10:00:00Z", amount_minor: 2500, currency: "USD" },
        { id: "po2", status: "paid", created_at: "2026-09-02T10:00:00Z", amount_minor: 1000000, currency: "ALL" },
      ],
    });
    mockGetAuthorPayoutDestination.mockResolvedValue({ ok: true, data: null });
  });

  async function renderBalance() {
    const { default: BalancePage } = await import("./page");
    const element = await BalancePage({ searchParams: Promise.resolve({}) });
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  it("each currency gets its own section with its own amounts", async () => {
    const html = await renderBalance();
    expect(html).toContain(">USD</h2>");
    expect(html).toContain(">ALL</h2>");
    expect(html).toContain("USD 10.00"); // USD available
    expect(html).toContain("1.234,00 ALL"); // ALL available
    expect(html).toContain("-USD 10.05"); // USD lifetime refunds
    expect(html).toContain("-1.234,05 ALL"); // ALL lifetime refunds
    // A cross-currency sum of the two available balances appears nowhere.
    expect(html).not.toContain("1.244,00");
    expect(html).not.toContain("USD 1,244.00");
  });

  it("activity and payout rows each keep their own currency, qindarka included", async () => {
    const html = await renderBalance();
    expect(html).toContain("USD 6.99");
    expect(html).toContain("799,20 ALL");
    expect(html).toContain("-8,00 ALL");
    expect(html).toContain("USD 25.00");
    expect(html).toContain("10.000,00 ALL");
  });

  it("a malformed currency is shown as unavailable, never guessed as USD or ALL", async () => {
    const html = await renderBalance();
    expect(html).toContain("Amount unavailable (currency unknown)");
    expect(html).not.toContain("USD 5.00");
    expect(html).not.toContain("5,00 ALL");
  });

  it("no bare dollar sign appears anywhere on the page", async () => {
    const html = await renderBalance();
    expect(html).not.toMatch(/\$/);
  });
});
