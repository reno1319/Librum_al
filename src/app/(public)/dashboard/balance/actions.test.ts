import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LEDGER-1D: same mocking convention as
// src/app/admin/(protected)/audit/actions.test.ts -- both server
// primitives here are plain reads (no redirect), always using the
// request-scoped RLS-respecting client.
//
// BANK-PAYOUT-1E: the destination read/write actions added below DO
// call auth.getUser()/from()/rpc() and redirect() -- the same
// RedirectSignal convention src/app/(public)/dashboard/profile/
// actions.test.ts already establishes for a Server Action that
// redirects on every path (success and error alike).
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
const mockRevalidatePath = vi.fn();
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

const mockRpc = vi.fn();
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockEqCurrency = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockEqAuthorId = vi.fn(() => ({ eq: mockEqCurrency }));
const mockSelect = vi.fn(() => ({ eq: mockEqAuthorId }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ rpc: mockRpc, auth: { getUser: mockGetUser }, from: mockFrom }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const AUTHOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const {
  getAuthorFinancialSummary,
  listAuthorFinancialActivity,
  getAuthorPayoutOverview,
  listAuthorPayoutHistory,
  getAuthorPayoutDestination,
  saveAuthorPayoutDestination,
} = await import("./actions");

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

describe("getAuthorPayoutOverview", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("calls get_author_payout_overview with no arguments (identity comes from auth.uid() alone)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAuthorPayoutOverview();
    expect(mockRpc).toHaveBeenCalledWith("get_author_payout_overview");
  });

  it("returns ok:true with the rows on success", async () => {
    const rows = [{ currency: "USD", available_for_payout_minor: 0 }];
    mockRpc.mockResolvedValue({ data: rows, error: null });
    const result = await getAuthorPayoutOverview();
    expect(result).toEqual({ ok: true, data: rows });
  });

  it("returns ok:true with an empty array when data is null", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const result = await getAuthorPayoutOverview();
    expect(result).toEqual({ ok: true, data: [] });
  });

  it("returns ok:false with a safe message on RPC error, never leaking the raw error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "internal detail" } });
    const result = await getAuthorPayoutOverview();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("internal detail");
    }
  });
});

describe("listAuthorPayoutHistory", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("defaults to limit 25 and null cursor", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listAuthorPayoutHistory();
    expect(mockRpc).toHaveBeenCalledWith("list_author_payout_history", {
      p_limit: 25,
      p_cursor_created_at: null,
      p_cursor_id: null,
    });
  });

  it("forwards an explicit limit and cursor", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listAuthorPayoutHistory({
      limit: 10,
      cursorCreatedAt: "2026-01-01T00:00:00Z",
      cursorId: "abc",
    });
    expect(mockRpc).toHaveBeenCalledWith("list_author_payout_history", {
      p_limit: 10,
      p_cursor_created_at: "2026-01-01T00:00:00Z",
      p_cursor_id: "abc",
    });
  });

  it("returns ok:false with a safe message on RPC error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "invalid cursor" } });
    const result = await listAuthorPayoutHistory();
    expect(result.ok).toBe(false);
  });
});

function formDataWith(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("getAuthorPayoutDestination", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEqAuthorId.mockClear();
    mockEqCurrency.mockClear();
    mockMaybeSingle.mockReset();
  });

  it("returns ok:false without querying the table when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const result = await getAuthorPayoutDestination();
    expect(result.ok).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("reads from author_payout_destinations, scoped to the caller's own author_id and currency ALL", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    await getAuthorPayoutDestination();

    expect(mockFrom).toHaveBeenCalledWith("author_payout_destinations");
    expect(mockEqAuthorId).toHaveBeenCalledWith("author_id", AUTHOR_ID);
    expect(mockEqCurrency).toHaveBeenCalledWith("currency", "ALL");
  });

  it("returns ok:true with null data when no destination exists yet", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await getAuthorPayoutDestination();
    expect(result).toEqual({ ok: true, data: null });
  });

  it("returns ok:true with the row when a destination exists", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    const row = {
      beneficiary_name: "Jane Author",
      iban: "AL47212110090000000235698741",
      currency: "ALL",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockMaybeSingle.mockResolvedValue({ data: row, error: null });
    const result = await getAuthorPayoutDestination();
    expect(result).toEqual({ ok: true, data: row });
  });

  it("returns ok:false with a safe message on a read error, never leaking the raw error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    mockMaybeSingle.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied for table" } });
    const result = await getAuthorPayoutDestination();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("permission denied");
    }
  });
});

describe("saveAuthorPayoutDestination", () => {
  const ORIGINAL_ENV = process.env.BANK_PAYOUT_SETUP_ENABLED;

  beforeEach(() => {
    mockGetUser.mockReset();
    mockRpc.mockReset();
    mockRedirect.mockClear();
    mockRevalidatePath.mockClear();
    // BANK-PAYOUT-1E.1 Section 7: this describe block covers the
    // ALREADY-REVIEWED enabled behavior from BANK-PAYOUT-1E, so the
    // rollout switch is explicitly armed here -- the disabled/fail-
    // closed path has its own dedicated describe block below, which
    // deliberately does NOT set this.
    process.env.BANK_PAYOUT_SETUP_ENABLED = "true";
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.BANK_PAYOUT_SETUP_ENABLED;
    } else {
      process.env.BANK_PAYOUT_SETUP_ENABLED = ORIGINAL_ENV;
    }
  });

  it("redirects to login when unauthenticated, without calling the RPC", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const formData = formDataWith({ beneficiaryName: "Jane Author", iban: "AL47212110090000000235698741" });

    await expect(saveAuthorPayoutDestination(formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects a submission missing beneficiaryName or iban without calling the RPC", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    const formData = formDataWith({ beneficiaryName: "", iban: "AL47212110090000000235698741" });

    const rejection = saveAuthorPayoutDestination(formData);
    await expect(rejection).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls set_author_payout_destination with currency hardcoded to ALL -- the caller cannot select or override it", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    mockRpc.mockResolvedValue({ error: null });
    // A malicious/crafted form submission cannot smuggle a different
    // currency in -- there is no "currency" field this action ever
    // reads from formData at all (verified by the source-guard test
    // below too).
    const formData = formDataWith({
      beneficiaryName: "Jane Author",
      iban: "AL47212110090000000235698741",
      currency: "EUR",
    });

    await expect(saveAuthorPayoutDestination(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRpc).toHaveBeenCalledWith("set_author_payout_destination", {
      p_currency: "ALL",
      p_beneficiary_name: "Jane Author",
      p_iban: "AL47212110090000000235698741",
    });
  });

  it("never accepts or forwards an author_id from the client -- the RPC call carries no such argument", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    mockRpc.mockResolvedValue({ error: null });
    const formData = formDataWith({
      beneficiaryName: "Jane Author",
      iban: "AL47212110090000000235698741",
      author_id: "00000000-0000-0000-0000-000000000000",
    });

    await expect(saveAuthorPayoutDestination(formData)).rejects.toBeInstanceOf(RedirectSignal);

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs).not.toHaveProperty("author_id");
    expect(rpcArgs).not.toHaveProperty("p_author_id");
  });

  it("on success, revalidates /dashboard/balance and redirects with a neutral (non-'verified') success message", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    mockRpc.mockResolvedValue({ error: null });
    const formData = formDataWith({ beneficiaryName: "Jane Author", iban: "AL47212110090000000235698741" });

    let redirectTarget = "";
    try {
      await saveAuthorPayoutDestination(formData);
    } catch (e) {
      redirectTarget = (e as RedirectSignal).target;
    }

    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/balance");
    expect(redirectTarget).toContain("/dashboard/balance");
    expect(redirectTarget).toContain(encodeURIComponent("Bank details saved."));
    expect(redirectTarget.toLowerCase()).not.toContain("verified");
  });

  it("on a checksum-validation RPC error, redirects back into edit mode with a safe, friendly message -- never the raw Postgres error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    mockRpc.mockResolvedValue({
      error: {
        code: "P0001",
        message:
          "set_author_payout_destination: iban fails checksum validation -- this only confirms the format is well-formed, never that the account exists or belongs to you",
      },
    });
    const formData = formDataWith({ beneficiaryName: "Jane Author", iban: "AL47212110090000000235698742" });

    let redirectTarget = "";
    try {
      await saveAuthorPayoutDestination(formData);
    } catch (e) {
      redirectTarget = (e as RedirectSignal).target;
    }

    expect(redirectTarget).toContain("editBank=1");
    expect(redirectTarget).not.toContain("set_author_payout_destination");
    expect(redirectTarget).not.toContain(encodeURIComponent("iban fails checksum validation"));
  });

  it("on an unrecognized/unexpected RPC error, redirects with the single generic fallback message, never the raw error text", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTHOR_ID } } });
    mockRpc.mockResolvedValue({ error: { code: "08006", message: "connection reset by peer" } });
    const formData = formDataWith({ beneficiaryName: "Jane Author", iban: "AL47212110090000000235698741" });

    let redirectTarget = "";
    try {
      await saveAuthorPayoutDestination(formData);
    } catch (e) {
      redirectTarget = (e as RedirectSignal).target;
    }

    expect(redirectTarget).not.toContain("connection reset by peer");
    expect(redirectTarget).toContain(encodeURIComponent("We couldn't save your bank details"));
  });
});

// BANK-PAYOUT-1E.1 Section 13: the rollout switch must be re-checked
// independently inside the Server Action itself -- a hidden/absent form
// is not the enforcement boundary. This block explicitly does NOT set
// BANK_PAYOUT_SETUP_ENABLED (or sets it to something other than the
// exact string "true"), so it exercises the real default-off state a
// fresh deploy would actually run under.
describe("saveAuthorPayoutDestination: fails closed when BANK_PAYOUT_SETUP_ENABLED is not exactly 'true'", () => {
  const ORIGINAL_ENV = process.env.BANK_PAYOUT_SETUP_ENABLED;

  beforeEach(() => {
    mockGetUser.mockReset();
    mockRpc.mockReset();
    mockRedirect.mockClear();
    mockRevalidatePath.mockClear();
    delete process.env.BANK_PAYOUT_SETUP_ENABLED;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.BANK_PAYOUT_SETUP_ENABLED;
    } else {
      process.env.BANK_PAYOUT_SETUP_ENABLED = ORIGINAL_ENV;
    }
  });

  it("redirects with a safe message and calls neither auth.getUser() nor the RPC when the switch is unset", async () => {
    const formData = formDataWith({ beneficiaryName: "Jane Author", iban: "AL47212110090000000235698741" });

    await expect(saveAuthorPayoutDestination(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("never writes anything when the switch is 'false'", async () => {
    process.env.BANK_PAYOUT_SETUP_ENABLED = "false";
    const formData = formDataWith({ beneficiaryName: "Jane Author", iban: "AL47212110090000000235698741" });

    await expect(saveAuthorPayoutDestination(formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("never writes anything for a truthy-but-not-exact value ('1', 'yes', 'True') -- same fail-closed contract as isBankPayoutSetupEnabled", async () => {
    for (const value of ["1", "yes", "True", "TRUE"]) {
      process.env.BANK_PAYOUT_SETUP_ENABLED = value;
      const formData = formDataWith({ beneficiaryName: "Jane Author", iban: "AL47212110090000000235698741" });
      await expect(saveAuthorPayoutDestination(formData)).rejects.toBeInstanceOf(RedirectSignal);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("redirects to a safe, non-database-error message, never the raw internals", async () => {
    const formData = formDataWith({ beneficiaryName: "Jane Author", iban: "AL47212110090000000235698741" });

    let redirectTarget = "";
    try {
      await saveAuthorPayoutDestination(formData);
    } catch (e) {
      redirectTarget = (e as RedirectSignal).target;
    }

    expect(redirectTarget).toContain("/dashboard/balance");
    expect(redirectTarget).not.toContain("beneficiaryName");
    expect(redirectTarget).not.toContain("iban");
  });
});

describe("BANK-PAYOUT-1E: bank-data logging safety (source-level guard)", () => {
  it("actions.ts never logs the submitted beneficiaryName/iban values, only safe markers (error.code)", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    // Every console.error call in this file must reference only a safe
    // field (the destructured error/message/code identifiers), never
    // the local `beneficiaryName`/`iban` variables this file also
    // declares.
    const consoleErrorCalls = source.match(/console\.error\([^)]*\)/g) ?? [];
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
    for (const call of consoleErrorCalls) {
      expect(call).not.toMatch(/\bbeneficiaryName\b/);
      expect(call).not.toMatch(/\biban\b/);
    }
  });

  it("never reads a currency field from the submitted formData in saveAuthorPayoutDestination", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).not.toMatch(/formData\.get\("currency"\)/);
  });
});
