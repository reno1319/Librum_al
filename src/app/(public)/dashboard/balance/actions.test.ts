import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LEDGER-1D: same mocking convention as
// src/app/admin/(protected)/audit/actions.test.ts -- both server
// primitives here are plain reads (no redirect), always using the
// request-scoped RLS-respecting client.
const mockRpc = vi.fn();
const mockCreateClient = vi.fn(() => Promise.resolve({ rpc: mockRpc }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { getAuthorFinancialSummary, listAuthorFinancialActivity } = await import("./actions");

describe("balance server primitives: source-level guards", () => {
  it("never imports createAdminClient/the service-role client", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*createAdminClient[^}]*\}/);
    expect(source).not.toMatch(/from\s*"@\/lib\/supabase\/admin"/);
  });

  it("uses the normal request-scoped server client, not the admin one", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).toMatch(/import\s*\{\s*createClient\s*\}\s*from\s*"@\/lib\/supabase\/server"/);
  });
});

describe("getAuthorFinancialSummary", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("calls get_author_financial_summary with no arguments (identity comes from auth.uid() alone)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAuthorFinancialSummary();
    expect(mockRpc).toHaveBeenCalledWith("get_author_financial_summary");
  });

  it("returns ok:true with the rows on success", async () => {
    const rows = [{ currency: "USD", lifetime_sale_minor: 640 }];
    mockRpc.mockResolvedValue({ data: rows, error: null });
    const result = await getAuthorFinancialSummary();
    expect(result).toEqual({ ok: true, data: rows });
  });

  it("returns ok:true with an empty array when data is null (fresh production state)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const result = await getAuthorFinancialSummary();
    expect(result).toEqual({ ok: true, data: [] });
  });

  it("returns ok:false with a safe message on RPC error, never leaking the raw error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "internal detail" } });
    const result = await getAuthorFinancialSummary();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("internal detail");
    }
  });
});

describe("listAuthorFinancialActivity", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("defaults to limit 25 and null cursor", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listAuthorFinancialActivity();
    expect(mockRpc).toHaveBeenCalledWith("list_author_financial_activity", {
      p_limit: 25,
      p_cursor_created_at: null,
      p_cursor_id: null,
    });
  });

  it("forwards an explicit limit and cursor", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listAuthorFinancialActivity({
      limit: 10,
      cursorCreatedAt: "2026-01-01T00:00:00Z",
      cursorId: "abc",
    });
    expect(mockRpc).toHaveBeenCalledWith("list_author_financial_activity", {
      p_limit: 10,
      p_cursor_created_at: "2026-01-01T00:00:00Z",
      p_cursor_id: "abc",
    });
  });

  it("returns ok:false with a safe message on RPC error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "invalid cursor" } });
    const result = await listAuthorFinancialActivity();
    expect(result.ok).toBe(false);
  });
});
