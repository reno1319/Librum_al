import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// ADMIN-1D Part B: same mocking convention already established by
// ../audit/actions.test.ts -- requireStaff() is mocked directly (its own
// decision logic is already covered by src/lib/staff.test.ts). None of
// these functions redirect -- like listAdminAuditEvents(), each is a
// plain read primitive, not a redirect-driving Server Action -- so
// "authorization failure" here means requireStaff()'s own thrown
// redirect propagates.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockRpc = vi.fn();
const mockCreateClient = vi.fn(() => Promise.resolve({ rpc: mockRpc }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const {
  listRefundReconciliationStates,
  listFinanceDisputes,
  listFinanceCheckoutExceptions,
  listFinanceRefundEntitlementMismatches,
  getFinanceSummaryCounts,
  mapFinanceRpcError,
} = await import("./actions");

describe("finance server primitives: source-level guards", () => {
  it("never imports createAdminClient/the service-role client", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*createAdminClient[^}]*\}/);
    expect(source).not.toMatch(/from\s*"@\/lib\/supabase\/admin"/);
  });

  it("uses the normal request-scoped server client, not the admin one", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).toMatch(/import\s*\{\s*createClient\s*\}\s*from\s*"@\/lib\/supabase\/server"/);
  });

  it("never calls a Stripe API method anywhere in this file", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).not.toMatch(/stripe\.\w+\.\w+\(/);
    expect(source).not.toMatch(/from\s*"@\/lib\/stripe"/);
  });
});

beforeEach(() => {
  mockRequireStaff.mockReset();
  mockRpc.mockReset();
});

describe("listRefundReconciliationStates", () => {
  it("requires finance.view before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(listRefundReconciliationStates()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls list_refund_reconciliation_states with every param mapped to its exact p_ argument", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listRefundReconciliationStates({
      operationalState: "approved_attempt_unknown",
      needsAttention: true,
      cursorRequestedAt: "2026-01-15T00:00:00.000Z",
      cursorId: "cursor-1",
      limit: 50,
    });

    expect(mockRpc).toHaveBeenCalledWith("list_refund_reconciliation_states", {
      p_operational_state: "approved_attempt_unknown",
      p_needs_attention: true,
      p_cursor_requested_at: "2026-01-15T00:00:00.000Z",
      p_cursor_id: "cursor-1",
      p_limit: 50,
    });
  });

  it("defaults every unset param to null, and limit to 25", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listRefundReconciliationStates();

    expect(mockRpc).toHaveBeenCalledWith("list_refund_reconciliation_states", {
      p_operational_state: null,
      p_needs_attention: null,
      p_cursor_requested_at: null,
      p_cursor_id: null,
      p_limit: 25,
    });
  });

  it("returns the RPC's rows on success", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    const rows = [{ refund_request_id: "r1", operational_state: "approved_unattempted", needs_attention: false }];
    mockRpc.mockResolvedValue({ data: rows, error: null });

    const result = await listRefundReconciliationStates();

    expect(result).toEqual({ ok: true, data: rows });
  });

  it("returns an empty array (not undefined/null) when the RPC returns no data", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await listRefundReconciliationStates();

    expect(result).toEqual({ ok: true, data: [] });
  });

  it("maps a known RPC error to stable, non-leaking copy", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: { message: "invalid operational_state filter" } });

    const result = await listRefundReconciliationStates();

    expect(result).toEqual({ ok: false, error: "That's not a valid refund state filter." });
  });

  it("never leaks a raw/unrecognized RPC error message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'relation "public.refund_issuance_attempts" does not exist' },
    });

    const result = await listRefundReconciliationStates();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("refund_issuance_attempts");
      expect(result.error).not.toContain("relation");
    }
  });
});

describe("listFinanceDisputes", () => {
  it("requires finance.view before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(listFinanceDisputes()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls list_finance_disputes with every param mapped to its exact p_ argument", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listFinanceDisputes({
      needsAttention: true,
      cursorCreatedAt: "2026-01-15T00:00:00.000Z",
      cursorId: "cursor-1",
      limit: 10,
    });

    expect(mockRpc).toHaveBeenCalledWith("list_finance_disputes", {
      p_needs_attention: true,
      p_cursor_created_at: "2026-01-15T00:00:00.000Z",
      p_cursor_id: "cursor-1",
      p_limit: 10,
    });
  });

  it("defaults every unset param to null, and limit to 25", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listFinanceDisputes();

    expect(mockRpc).toHaveBeenCalledWith("list_finance_disputes", {
      p_needs_attention: null,
      p_cursor_created_at: null,
      p_cursor_id: null,
      p_limit: 25,
    });
  });

  it("returns rows on success, empty array when no data", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await listFinanceDisputes();

    expect(result).toEqual({ ok: true, data: [] });
  });

  it("never leaks a raw/unrecognized RPC error message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: { message: "column payment_disputes.foo does not exist" } });

    const result = await listFinanceDisputes();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("payment_disputes");
      expect(result.error).not.toContain("column");
    }
  });
});

describe("listFinanceCheckoutExceptions", () => {
  it("requires finance.view before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(listFinanceCheckoutExceptions()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls list_finance_checkout_exceptions with every param mapped to its exact p_ argument", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listFinanceCheckoutExceptions({
      cursorCompletedAt: "2026-01-15T00:00:00.000Z",
      cursorId: "cursor-1",
      limit: 10,
    });

    expect(mockRpc).toHaveBeenCalledWith("list_finance_checkout_exceptions", {
      p_cursor_completed_at: "2026-01-15T00:00:00.000Z",
      p_cursor_id: "cursor-1",
      p_limit: 10,
    });
  });

  it("defaults every unset param to null, and limit to 25", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listFinanceCheckoutExceptions();

    expect(mockRpc).toHaveBeenCalledWith("list_finance_checkout_exceptions", {
      p_cursor_completed_at: null,
      p_cursor_id: null,
      p_limit: 25,
    });
  });

  it("returns rows on success, empty array when no data", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await listFinanceCheckoutExceptions();

    expect(result).toEqual({ ok: true, data: [] });
  });
});

describe("listFinanceRefundEntitlementMismatches", () => {
  it("requires finance.view before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(listFinanceRefundEntitlementMismatches()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls list_finance_refund_entitlement_mismatches with p_limit only -- no cursor params", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listFinanceRefundEntitlementMismatches({ limit: 10 });

    expect(mockRpc).toHaveBeenCalledWith("list_finance_refund_entitlement_mismatches", {
      p_limit: 10,
    });
  });

  it("defaults limit to 25", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listFinanceRefundEntitlementMismatches();

    expect(mockRpc).toHaveBeenCalledWith("list_finance_refund_entitlement_mismatches", {
      p_limit: 25,
    });
  });

  it("returns rows on success, empty array when no data", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await listFinanceRefundEntitlementMismatches();

    expect(result).toEqual({ ok: true, data: [] });
  });
});

describe("getFinanceSummaryCounts", () => {
  it("requires finance.view before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(getFinanceSummaryCounts()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls get_finance_summary_counts with no parameters", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({
      data: [
        {
          refund_needs_attention_count: 2,
          dispute_needs_attention_count: 1,
          checkout_exception_count: 0,
          refund_entitlement_mismatch_count: 0,
        },
      ],
      error: null,
    });

    await getFinanceSummaryCounts();

    expect(mockRpc).toHaveBeenCalledWith("get_finance_summary_counts");
  });

  it("returns the single summary row on success", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    const row = {
      refund_needs_attention_count: 2,
      dispute_needs_attention_count: 1,
      checkout_exception_count: 3,
      refund_entitlement_mismatch_count: 0,
    };
    mockRpc.mockResolvedValue({ data: [row], error: null });

    const result = await getFinanceSummaryCounts();

    expect(result).toEqual({ ok: true, data: row });
  });

  it("treats a missing/empty result as a generic failure, never fabricating zero counts", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    const result = await getFinanceSummaryCounts();

    expect(result.ok).toBe(false);
  });

  it("maps a known RPC error to stable, non-leaking copy", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: { message: "not authorized" } });

    const result = await getFinanceSummaryCounts();

    expect(result).toEqual({ ok: false, error: "You don't have permission to view finance data." });
  });
});

describe("mapFinanceRpcError", () => {
  it("returns the generic message for a null/undefined/empty error", () => {
    expect(mapFinanceRpcError(null)).toBe("Something went wrong. Please try again.");
    expect(mapFinanceRpcError(undefined)).toBe("Something went wrong. Please try again.");
    expect(mapFinanceRpcError({ message: "" })).toBe("Something went wrong. Please try again.");
  });

  it("maps every known RPC exception string to stable copy", () => {
    expect(mapFinanceRpcError({ message: "not authorized" })).toBe("You don't have permission to view finance data.");
    expect(mapFinanceRpcError({ message: "invalid operational_state filter" })).toBe(
      "That's not a valid refund state filter.",
    );
    expect(mapFinanceRpcError({ message: "invalid cursor" })).toBe("That pagination link is no longer valid.");
  });

  it("never passes through an unrecognized message verbatim", () => {
    const result = mapFinanceRpcError({ message: "duplicate key value violates unique constraint" });
    expect(result).toBe("Something went wrong. Please try again.");
  });
});
