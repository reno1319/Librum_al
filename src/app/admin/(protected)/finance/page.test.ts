import { describe, expect, it, vi, beforeEach } from "vitest";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import type {
  FinanceRefundReconciliationRow,
  FinanceDisputeRow,
  FinanceCheckoutExceptionRow,
  FinanceRefundEntitlementMismatchRow,
  FinanceSummaryCounts,
} from "@/lib/types";

// ADMIN-1D PART C: proves this page itself calls requireStaff
// ("finance.view") -- not merely admin.access -- and that a denial stops
// execution before ANY of the five finance RPC wrappers are called.
// Mirrors ../audit/page.test.ts exactly.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockGetFinanceSummaryCounts = vi.fn();
const mockListRefundReconciliationStates = vi.fn();
const mockListFinanceDisputes = vi.fn();
const mockListFinanceCheckoutExceptions = vi.fn();
const mockListFinanceRefundEntitlementMismatches = vi.fn();
vi.mock("./actions", () => ({
  getFinanceSummaryCounts: () => mockGetFinanceSummaryCounts(),
  listRefundReconciliationStates: (params: unknown) => mockListRefundReconciliationStates(params),
  listFinanceDisputes: (params: unknown) => mockListFinanceDisputes(params),
  listFinanceCheckoutExceptions: (params: unknown) => mockListFinanceCheckoutExceptions(params),
  listFinanceRefundEntitlementMismatches: (params: unknown) => mockListFinanceRefundEntitlementMismatches(params),
}));

const { default: AdminFinancePage } = await import("./page");

// Same plain "walk the returned element tree" technique as
// ../audit/page.test.ts -- see that file's own comment for the full
// reasoning (no DOM rendering; vitest runs in a plain node environment).
function expand(node: ReactNode): ReactNode {
  let current: ReactNode = node;
  for (let i = 0; i < 20; i++) {
    if (current === null || current === undefined || typeof current === "boolean") return current;
    if (typeof current === "string" || typeof current === "number") return current;
    if (Array.isArray(current)) return current;
    if (typeof current !== "object") return current;
    const element = current as ReactElement<Record<string, unknown>>;
    if (!("type" in element) || !("props" in element)) return current;
    if (typeof element.type === "function" && element.type !== Link) {
      current = (element.type as (props: Record<string, unknown>) => ReactNode)(element.props);
      continue;
    }
    return current;
  }
  return current;
}

function walkAll(node: ReactNode, visit: (n: ReactNode) => void) {
  const n = expand(node);
  if (n === null || n === undefined || typeof n === "boolean") return;
  if (typeof n === "string" || typeof n === "number") {
    visit(n);
    return;
  }
  if (Array.isArray(n)) {
    n.forEach((child) => walkAll(child, visit));
    return;
  }
  if (typeof n !== "object") return;
  visit(n);
  const element = n as ReactElement<{ children?: ReactNode }>;
  if ("props" in element) {
    walkAll(element.props.children, visit);
  }
}

function collectText(node: ReactNode): string[] {
  const texts: string[] = [];
  walkAll(node, (n) => {
    if (typeof n === "string" || typeof n === "number") texts.push(String(n));
  });
  return texts;
}

function findAllByTagName(node: ReactNode, tagName: string): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  walkAll(node, (n) => {
    if (typeof n === "object" && n !== null && "type" in (n as ReactElement) && (n as ReactElement).type === tagName) {
      found.push(n as ReactElement<Record<string, unknown>>);
    }
  });
  return found;
}

function collectHrefs(node: ReactNode): string[] {
  const hrefs: string[] = [];
  walkAll(node, (n) => {
    if (typeof n === "object" && n !== null && "props" in (n as ReactElement)) {
      const href = (n as ReactElement<{ href?: string }>).props.href;
      if (typeof href === "string") hrefs.push(href);
    }
  });
  return hrefs;
}

const SUMMARY: FinanceSummaryCounts = {
  refund_needs_attention_count: 0,
  dispute_needs_attention_count: 0,
  checkout_exception_count: 0,
  refund_entitlement_mismatch_count: 0,
};

function makeRefundRow(overrides: Partial<FinanceRefundReconciliationRow> = {}): FinanceRefundReconciliationRow {
  return {
    refund_request_id: "a0000000-0000-0000-0000-000000000001",
    reader_id: "b0000000-0000-0000-0000-000000000001",
    reader_display_name: "Reader One",
    amount_cents: 1999,
    refund_request_status: "approved",
    requested_at: "2026-01-01T00:00:00.000Z",
    reviewed_at: "2026-01-01T01:00:00.000Z",
    latest_attempt_id: null,
    latest_attempt_status: null,
    latest_attempt_created_at: null,
    latest_attempt_updated_at: null,
    stripe_refund_id: null,
    stripe_status: null,
    operational_state: "approved_unattempted",
    needs_attention: true,
    ...overrides,
  };
}

function makeDisputeRow(overrides: Partial<FinanceDisputeRow> = {}): FinanceDisputeRow {
  return {
    id: "c0000000-0000-0000-0000-000000000001",
    stripe_dispute_id: "dp_abc123",
    stripe_payment_intent_id: "pi_abc123",
    reader_id: "b0000000-0000-0000-0000-000000000001",
    reader_display_name: "Reader One",
    status: "needs_response",
    reason: "fraudulent",
    amount_cents: 1999,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    transfer_reversal_status: "not_attempted",
    stripe_transfer_reversal_id: null,
    transfer_reversal_attempt_count: 0,
    transfer_reversal_attempted_at: null,
    transfer_reversal_succeeded_at: null,
    transfer_reversal_failure_code: null,
    needs_attention: true,
    ...overrides,
  };
}

function makeCheckoutRow(overrides: Partial<FinanceCheckoutExceptionRow> = {}): FinanceCheckoutExceptionRow {
  return {
    intent_id: "d0000000-0000-0000-0000-000000000001",
    book_id: "e0000000-0000-0000-0000-000000000001",
    book_title: "Some Book",
    reader_id: "b0000000-0000-0000-0000-000000000001",
    reader_display_name: "Reader One",
    price_cents_at_checkout: 999,
    stripe_checkout_session_id: "cs_abc123",
    stripe_payment_intent_id: "pi_abc123",
    completed_at: "2026-01-01T00:00:00.000Z",
    reconciliation_reason: "active_other_session",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMismatchRow(overrides: Partial<FinanceRefundEntitlementMismatchRow> = {}): FinanceRefundEntitlementMismatchRow {
  return {
    mismatch_type: "refunded_request_active_purchase",
    refund_request_id: "a0000000-0000-0000-0000-000000000001",
    purchase_id: "f0000000-0000-0000-0000-000000000001",
    bundle_checkout_snapshot_id: null,
    reader_id: "b0000000-0000-0000-0000-000000000001",
    reader_display_name: "Reader One",
    stripe_payment_intent_id: "pi_abc123",
    amount_cents: 1999,
    ...overrides,
  };
}

function setDefaultOkMocks() {
  mockGetFinanceSummaryCounts.mockResolvedValue({ ok: true, data: SUMMARY });
  mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: [] });
  mockListFinanceDisputes.mockResolvedValue({ ok: true, data: [] });
  mockListFinanceCheckoutExceptions.mockResolvedValue({ ok: true, data: [] });
  mockListFinanceRefundEntitlementMismatches.mockResolvedValue({ ok: true, data: [] });
}

describe("AdminFinancePage", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockGetFinanceSummaryCounts.mockReset();
    mockListRefundReconciliationStates.mockReset();
    mockListFinanceDisputes.mockReset();
    mockListFinanceCheckoutExceptions.mockReset();
    mockListFinanceRefundEntitlementMismatches.mockReset();
  });

  it("calls requireStaff('finance.view') and never queries any finance data when denied", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/?denied=finance.view");
    });

    await expect(
      AdminFinancePage({ searchParams: Promise.resolve({}) }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRequireStaff).toHaveBeenCalledWith("finance.view");
    expect(mockGetFinanceSummaryCounts).not.toHaveBeenCalled();
    expect(mockListRefundReconciliationStates).not.toHaveBeenCalled();
    expect(mockListFinanceDisputes).not.toHaveBeenCalled();
    expect(mockListFinanceCheckoutExceptions).not.toHaveBeenCalled();
    expect(mockListFinanceRefundEntitlementMismatches).not.toHaveBeenCalled();
  });

  it("renders exactly one H1, titled 'Finance', with a Stripe-Dashboard-replacement disclaimer", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();

    const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
    const h1s = findAllByTagName(page, "h1");
    const text = collectText(page).join(" | ");

    expect(h1s).toHaveLength(1);
    expect(collectText(h1s[0])).toContain("Finance");
    expect(text).toContain("not a Stripe Dashboard replacement");
  });

  it("requests refund/dispute/checkout with FINANCE_DISPLAY_PAGE_SIZE + 1 (26) as the lookahead limit, and mismatches with 25 (no +1, no pagination)", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();

    await AdminFinancePage({ searchParams: Promise.resolve({}) });

    expect(mockListRefundReconciliationStates).toHaveBeenCalledWith(expect.objectContaining({ limit: 26 }));
    expect(mockListFinanceDisputes).toHaveBeenCalledWith(expect.objectContaining({ limit: 26 }));
    expect(mockListFinanceCheckoutExceptions).toHaveBeenCalledWith(expect.objectContaining({ limit: 26 }));
    expect(mockListFinanceRefundEntitlementMismatches).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it("defaults the refund and dispute attention filter to true (needsAttention: true) with no query params", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();

    await AdminFinancePage({ searchParams: Promise.resolve({}) });

    expect(mockListRefundReconciliationStates).toHaveBeenCalledWith(expect.objectContaining({ needsAttention: true }));
    expect(mockListFinanceDisputes).toHaveBeenCalledWith(expect.objectContaining({ needsAttention: true }));
  });

  it("refund_attention=all passes needsAttention: null (no filter) to the RPC wrapper", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();

    await AdminFinancePage({ searchParams: Promise.resolve({ refund_attention: "all" }) });

    expect(mockListRefundReconciliationStates).toHaveBeenCalledWith(expect.objectContaining({ needsAttention: null }));
  });

  it("renders summary cards from the RPC-supplied counts only, with no invented monetary total", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();
    mockGetFinanceSummaryCounts.mockResolvedValue({
      ok: true,
      data: {
        refund_needs_attention_count: 3,
        dispute_needs_attention_count: 1,
        checkout_exception_count: 2,
        refund_entitlement_mismatch_count: 4,
      },
    });

    const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("3");
    expect(text).toContain("1");
    expect(text).toContain("2");
    expect(text).toContain("4");
    expect(text).not.toMatch(/\$\d/);
  });

  it("summary cards link to each section's anchor, with the attention-needing ones pre-filtered to attention=true", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();

    const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
    const hrefs = collectHrefs(page);

    expect(hrefs).toContain("/admin/finance?refund_attention=true#refunds");
    expect(hrefs).toContain("/admin/finance?dispute_attention=true#disputes");
    expect(hrefs).toContain("/admin/finance#checkout");
    expect(hrefs).toContain("/admin/finance#mismatches");
  });

  it("renders a controlled Alert for a summary RPC error, never a raw DB error string", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();
    mockGetFinanceSummaryCounts.mockResolvedValue({ ok: false, error: "Something went wrong. Please try again." });

    const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Something went wrong. Please try again.");
    expect(text).not.toMatch(/relation|SQLSTATE|postgres|finance_reconciliation/i);
  });

  describe("refund section", () => {
    it("renders the exact required copy per operational_state", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({
        ok: true,
        data: [
          makeRefundRow({ refund_request_id: "r1", operational_state: "approved_unattempted" }),
          makeRefundRow({ refund_request_id: "r2", operational_state: "approved_attempt_initiated" }),
          makeRefundRow({ refund_request_id: "r3", operational_state: "approved_attempt_stale_initiated" }),
          makeRefundRow({ refund_request_id: "r4", operational_state: "approved_attempt_unknown" }),
          makeRefundRow({ refund_request_id: "r5", operational_state: "approved_attempt_failed" }),
          makeRefundRow({ refund_request_id: "r6", operational_state: "approved_attempt_submitted" }),
          makeRefundRow({ refund_request_id: "r7", operational_state: "refunded" }),
        ],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");

      expect(text).toContain("Approved — awaiting issuance");
      expect(text).toContain("Attempt in progress");
      expect(text).toContain("Attempt outcome needs reconciliation");
      expect(text).toContain("Previous attempt failed");
      expect(text).toContain("Submitted to Stripe — awaiting finalization");
      expect(text).toContain("Refund completed");
    });

    it("never labels approved_unattempted with fail/overdue/broken language", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({
        ok: true,
        data: [makeRefundRow({ operational_state: "approved_unattempted" })],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      // Scoped to the rendered ROW text only -- the filter dropdown
      // legitimately lists "Previous attempt failed" as an option for a
      // DIFFERENT state, which would otherwise false-positive this check.
      const tables = findAllByTagName(page, "table");
      const rowText = collectText(tables[0]).join(" | ").toLowerCase();

      expect(rowText).toContain("approved — awaiting issuance".toLowerCase());
      expect(rowText).not.toContain("fail");
      expect(rowText).not.toContain("overdue");
      expect(rowText).not.toContain("broken");
    });

    it("renders a text 'Needs attention' badge, not color-only, when needs_attention is true", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({
        ok: true,
        data: [makeRefundRow({ needs_attention: true })],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("Needs attention");
    });

    it("renders 'OK' when needs_attention is false", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({
        ok: true,
        data: [makeRefundRow({ needs_attention: false })],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("OK");
    });

    it("links each refund row to the existing /admin/refunds/[id] detail page, and adds no new issuance/retry button", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({
        ok: true,
        data: [makeRefundRow({ refund_request_id: "a0000000-0000-0000-0000-000000000099" })],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const hrefs = collectHrefs(page);
      const text = collectText(page).join(" | ").toLowerCase();

      expect(hrefs).toContain("/admin/refunds/a0000000-0000-0000-0000-000000000099");
      expect(text).not.toContain("issue refund");
      expect(text).not.toContain("retry");
      expect(text).not.toContain("reconcile");
    });

    it("resolves a deleted reader account distinctly from a merely-nameless one", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({
        ok: true,
        data: [
          makeRefundRow({ refund_request_id: "r1", reader_id: null, reader_display_name: null }),
          makeRefundRow({ refund_request_id: "r2", reader_id: "b1", reader_display_name: null }),
        ],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");

      expect(text).toContain("Deleted account");
      expect(text).toContain("Unknown reader");
    });

    it("shows the attention-first empty state with no filters active", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("No refunds require attention.");
    });

    it("shows a distinct empty state when a state filter is active and nothing matches", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();

      const page = await AdminFinancePage({ searchParams: Promise.resolve({ refund_state: "rejected" }) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("No refunds match these filters.");
    });

    it("renders a controlled Alert for a refund RPC error, never a raw DB error string", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({ ok: false, error: "Something went wrong. Please try again." });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("Something went wrong. Please try again.");
    });

    function rowsOf(n: number) {
      return Array.from({ length: n }, (_, i) =>
        makeRefundRow({
          refund_request_id: `a0000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
          requested_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }

    it("exactly 25 rows: displays all 25, shows NO Next", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: rowsOf(25) });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const hrefs = collectHrefs(page);
      expect(hrefs.some((h) => h.includes("refund_cursor="))).toBe(false);
    });

    it("26 rows: displays only 25, shows Next with refund_cursor, and never renders the 26th row", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      const rows = rowsOf(26);
      mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: rows });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const hrefs = collectHrefs(page);
      const text = collectText(page).join(" | ");

      expect(hrefs.some((h) => h.includes("refund_cursor="))).toBe(true);
      expect(text).not.toContain(rows[25].refund_request_id);
    });

    it("0 and 1 row cases render without a Next link", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: rowsOf(0) });
      let page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      expect(collectHrefs(page).some((h) => h.includes("refund_cursor="))).toBe(false);

      mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: rowsOf(1) });
      page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      expect(collectHrefs(page).some((h) => h.includes("refund_cursor="))).toBe(false);
    });

    it("24 rows render without a Next link", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: rowsOf(24) });
      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      expect(collectHrefs(page).some((h) => h.includes("refund_cursor="))).toBe(false);
    });

    it("Next preserves other sections' state alongside the refund cursor", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: rowsOf(26) });

      const page = await AdminFinancePage({
        searchParams: Promise.resolve({ dispute_attention: "false", refund_state: "approved_unattempted" }),
      });
      const hrefs = collectHrefs(page);
      const nextHref = hrefs.find((h) => h.includes("refund_cursor="));

      expect(nextHref).toContain("dispute_attention=false");
      expect(nextHref).toContain("refund_state=approved_unattempted");
    });
  });

  describe("dispute section", () => {
    it("renders the dispute-specific attention filter labels correctly (no leftover no-op string mangling)", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const selects = findAllByTagName(page, "select");
      const disputeSelect = selects.find((s) => s.props.id === "dispute-attention");
      const options = findAllByTagName(disputeSelect, "option").map((o) => collectText(o).join(""));

      expect(options).toContain("Needs attention only");
      expect(options).toContain("No attention flag");
      expect(options).toContain("All disputes");
      expect(options).not.toContain("All refunds");
    });

    it("labels a non-terminal dispute status as open, never with an evidence deadline", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceDisputes.mockResolvedValue({ ok: true, data: [makeDisputeRow({ status: "needs_response" })] });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");

      expect(text).toContain("Open dispute — review in Stripe");
      expect(text.toLowerCase()).not.toContain("evidence due");
      expect(text.toLowerCase()).not.toContain("response required by");
    });

    it("renders transfer-reversal status using only the real DB vocabulary, with no Retry button", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceDisputes.mockResolvedValue({
        ok: true,
        data: [makeDisputeRow({ transfer_reversal_status: "failed", transfer_reversal_failure_code: "insufficient_funds" })],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");

      expect(text).toContain("Reversal failed");
      expect(text).toContain("insufficient_funds");
      expect(text.toLowerCase()).not.toContain("retry");
    });

    it("renders no dedicated dispute-detail link -- disputes carry no per-row href", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceDisputes.mockResolvedValue({ ok: true, data: [makeDisputeRow({ id: "dispute-xyz" })] });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const hrefs = collectHrefs(page);
      expect(hrefs.some((h) => h.includes("dispute-xyz"))).toBe(false);
      expect(hrefs.some((h) => h.startsWith("/admin/disputes"))).toBe(false);
    });

    it("shows the attention-first empty state with no filters active", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("No disputes require attention.");
    });

    it("renders a controlled Alert for a dispute RPC error", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceDisputes.mockResolvedValue({ ok: false, error: "Something went wrong. Please try again." });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("Something went wrong. Please try again.");
    });
  });

  describe("checkout exception section", () => {
    it("renders friendly copy plus the raw reconciliation_reason as a secondary tag, never a replay call to action", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceCheckoutExceptions.mockResolvedValue({
        ok: true,
        data: [makeCheckoutRow({ reconciliation_reason: "disputed_lost" })],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");

      expect(text).toContain("needs investigation");
      expect(text).toContain("disputed_lost");
      expect(text.toLowerCase()).not.toContain("replay");
    });

    it("states that bundle reconciliation is not included in this view", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("Bundle reconciliation is not included in this view.");
    });

    it("has no filter form -- unfiltered by design", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceCheckoutExceptions.mockResolvedValue({ ok: true, data: [makeCheckoutRow()] });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const selects = findAllByTagName(page, "select");
      // only the refund-state, refund-attention, and dispute-attention
      // selects should exist -- none belonging to the checkout section.
      expect(selects).toHaveLength(3);
    });

    it("renders a distinct empty state", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("No checkout exceptions found.");
    });

    it("renders a controlled Alert for a checkout RPC error", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceCheckoutExceptions.mockResolvedValue({ ok: false, error: "Something went wrong. Please try again." });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("Something went wrong. Please try again.");
    });

    function rowsOf(n: number) {
      return Array.from({ length: n }, (_, i) =>
        makeCheckoutRow({
          intent_id: `d0000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
          completed_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }

    it("26 rows: displays only 25, shows Next with checkout_cursor", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceCheckoutExceptions.mockResolvedValue({ ok: true, data: rowsOf(26) });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const hrefs = collectHrefs(page);
      expect(hrefs.some((h) => h.includes("checkout_cursor="))).toBe(true);
    });

    it("exactly 25 rows: no Next", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceCheckoutExceptions.mockResolvedValue({ ok: true, data: rowsOf(25) });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const hrefs = collectHrefs(page);
      expect(hrefs.some((h) => h.includes("checkout_cursor="))).toBe(false);
    });
  });

  describe("mismatch section", () => {
    it("uses 'Potential consistency issue' framing, never implying a determined repair", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceRefundEntitlementMismatches.mockResolvedValue({ ok: true, data: [makeMismatchRow()] });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("Potential consistency issue");
    });

    it("every mismatch row with a refund_request_id links to /admin/refunds/[id]", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceRefundEntitlementMismatches.mockResolvedValue({
        ok: true,
        data: [makeMismatchRow({ refund_request_id: "a0000000-0000-0000-0000-000000000042" })],
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const hrefs = collectHrefs(page);
      expect(hrefs).toContain("/admin/refunds/a0000000-0000-0000-0000-000000000042");
    });

    it("has no pagination controls (bounded fetch only, matching Part B's no-pagination design)", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceRefundEntitlementMismatches.mockResolvedValue({
        ok: true,
        data: Array.from({ length: 25 }, (_, i) => makeMismatchRow({ refund_request_id: `r${i}`, purchase_id: `p${i}` })),
      });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const hrefs = collectHrefs(page);
      expect(hrefs.some((h) => h.includes("mismatch_cursor="))).toBe(false);
    });

    it("renders a distinct empty state", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("No refund/entitlement consistency issues found.");
    });

    it("renders a controlled Alert for a mismatch RPC error", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      setDefaultOkMocks();
      mockListFinanceRefundEntitlementMismatches.mockResolvedValue({ ok: false, error: "Something went wrong. Please try again." });

      const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
      const text = collectText(page).join(" | ");
      expect(text).toContain("Something went wrong. Please try again.");
    });
  });

  it("one section's RPC failure does not prevent the other sections from rendering (per-section, not whole-page, error architecture)", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();
    mockListFinanceDisputes.mockResolvedValue({ ok: false, error: "Something went wrong. Please try again." });
    mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: [makeRefundRow()] });

    const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Approved — awaiting issuance");
    expect(text).toContain("Something went wrong. Please try again.");
  });

  it("renders both a desktop table and a mobile card list for the refund section (responsive structure)", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();
    mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: [makeRefundRow()] });

    const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
    const tables = findAllByTagName(page, "table");
    const uls = findAllByTagName(page, "ul");

    expect(tables.length).toBeGreaterThanOrEqual(1);
    const desktopWrapper = findAllByTagName(page, "div").find((d) =>
      typeof d.props.className === "string" &&
      d.props.className.includes("hidden") &&
      d.props.className.includes("md:block") &&
      d.props.className.includes("overflow-x-auto"),
    );
    expect(desktopWrapper).toBeTruthy();

    const mobileList = uls.find(
      (ul) => typeof ul.props.className === "string" && ul.props.className.includes("md:hidden"),
    );
    expect(mobileList).toBeTruthy();
  });

  it("every filter select has an associated label", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();

    const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
    const labels = findAllByTagName(page, "label");
    const controls = [...findAllByTagName(page, "select"), ...findAllByTagName(page, "input")];
    const labelFor = new Set(labels.map((l) => l.props.htmlFor));

    for (const control of controls) {
      expect(labelFor.has(control.props.id)).toBe(true);
    }
  });

  it("never renders a staff email address anywhere on the page", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    setDefaultOkMocks();
    mockListRefundReconciliationStates.mockResolvedValue({ ok: true, data: [makeRefundRow()] });
    mockListFinanceDisputes.mockResolvedValue({ ok: true, data: [makeDisputeRow()] });

    const page = await AdminFinancePage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");
    expect(text).not.toContain("@");
  });

  it("never imports createAdminClient/the service-role client or a Stripe SDK", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*createAdminClient[^}]*\}/);
    expect(source).not.toMatch(/from\s*"@\/lib\/supabase\/admin"/);
    expect(source).not.toMatch(/from\s*"@\/lib\/supabase\/server"/);
    expect(source).not.toMatch(/from\s*"stripe"/);
    expect(source).not.toContain("new Stripe(");
  });

  it("never defines or imports a Server Action of its own -- no \"use server\" in this file", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toContain('"use server"');
  });
});
