import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Same isolation convention as
// src/app/api/internal/reconcile-transfer-reversals/route.test.ts:
// createAdminClient() is mocked so every "authenticated request" test
// below stays fully offline, driven entirely by a controllable fake
// .rpc() implementation. Lazy factory so each test's own rpc
// implementation is picked up fresh.
type FakeRpc = (name: string, params?: unknown) => Promise<{ data: unknown; error: unknown }>;
// Wrapping every vi.fn() creation through this helper pins the mock's
// inferred type to FakeRpc regardless of what a given test's own
// implementation happens to return -- otherwise each reassignment
// below would infer its own narrower return type and fail to
// typecheck against the others.
function fakeRpcFn(impl: FakeRpc) {
  return vi.fn(impl);
}
let fakeRpc = fakeRpcFn(async () => ({ data: [], error: null }));
const mockCreateAdminClient = vi.fn(() => ({ rpc: fakeRpc }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

const { GET, POST } = await import("./route");

function authedRequest(method: "GET" | "POST", body?: unknown, secret = "test-cron-secret") {
  return new Request("http://localhost/api/internal/payouts/run", {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function runningRow(overrides: Record<string, unknown> = {}) {
  return {
    payout_run_id: "run-1",
    payout_run_key: "monthly:2026-10",
    payout_run_scheduled_for: "2026-10-01",
    payout_run_status: "running",
    payout_run_started_at: "2026-10-01T00:00:00Z",
    payout_run_completed_at: null,
    is_new: true,
    ...overrides,
  };
}

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    author_id: "author-1",
    currency: "USD",
    ledger_available_minor: 100,
    reserved_minor: 0,
    payoutable_minor: 100,
    threshold_configured: true,
    threshold_minor: 50,
    active_reservation: false,
    eligible: true,
    ineligible_reason: null,
    ...overrides,
  };
}

function ineligibleRow(reason: string, overrides: Record<string, unknown> = {}) {
  return {
    author_id: "author-2",
    currency: "USD",
    ledger_available_minor: 10,
    reserved_minor: 0,
    payoutable_minor: 10,
    threshold_configured: true,
    threshold_minor: 50,
    active_reservation: reason === "active_reservation",
    eligible: false,
    ineligible_reason: reason,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Section 37: authentication.
// ---------------------------------------------------------------------
describe("authentication", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalEnabled = process.env.PAYOUT_SCHEDULER_ENABLED;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.PAYOUT_SCHEDULER_ENABLED;
    mockCreateAdminClient.mockClear();
    fakeRpc = fakeRpcFn(async () => ({ data: [], error: null }));
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    process.env.PAYOUT_SCHEDULER_ENABLED = originalEnabled;
  });

  it("fails closed (503) when CRON_SECRET is not configured, for both GET and POST", async () => {
    delete process.env.CRON_SECRET;
    const getResponse = await GET(authedRequest("GET"));
    const postResponse = await POST(authedRequest("POST", { mode: "dry-run" }));
    expect(getResponse.status).toBe(503);
    expect(postResponse.status).toBe(503);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("rejects a request with no Authorization header (401)", async () => {
    const response = await GET(
      new Request("http://localhost/api/internal/payouts/run", { method: "GET" }),
    );
    expect(response.status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong bearer token (401)", async () => {
    const response = await GET(authedRequest("GET", undefined, "wrong-secret"));
    expect(response.status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("does not accept the secret via a query string", async () => {
    const response = await GET(
      new Request("http://localhost/api/internal/payouts/run?secret=test-cron-secret", { method: "GET" }),
    );
    expect(response.status).toBe(401);
  });

  it("does not accept the secret via the request body", async () => {
    const response = await POST(
      new Request("http://localhost/api/internal/payouts/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "dry-run", secret: "test-cron-secret" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("a correctly-authenticated request continues past auth (no financial RPC before that point, but proceeds afterward)", async () => {
    const response = await POST(authedRequest("POST", { mode: "dry-run" }));
    expect(response.status).toBe(200);
    expect(mockCreateAdminClient).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------
// Section 38/39: feature switch + disabled GET.
// ---------------------------------------------------------------------
describe("PAYOUT_SCHEDULER_ENABLED switch (reserve mode)", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalEnabled = process.env.PAYOUT_SCHEDULER_ENABLED;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    mockCreateAdminClient.mockClear();
    fakeRpc = fakeRpcFn(async () => ({ data: [], error: null }));
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    process.env.PAYOUT_SCHEDULER_ENABLED = originalEnabled;
  });

  const disabledCases: (string | undefined)[] = [undefined, "", "false", "1", "yes", "random", "True"];
  for (const value of disabledCases) {
    it(`GET is a safe disabled no-op when PAYOUT_SCHEDULER_ENABLED=${JSON.stringify(value)}`, async () => {
      if (value === undefined) delete process.env.PAYOUT_SCHEDULER_ENABLED;
      else process.env.PAYOUT_SCHEDULER_ENABLED = value;

      const response = await GET(authedRequest("GET"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("reserve");
      expect(body.enabled).toBe(false);
      expect(body.targetMonth).toMatch(/^\d{4}-\d{2}-01$/);
      // Section 39: disabled means zero DB surface -- not even an
      // admin client is created, let alone any RPC.
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    });
  }

  it("GET performs the full reserve orchestration when PAYOUT_SCHEDULER_ENABLED='true'", async () => {
    process.env.PAYOUT_SCHEDULER_ENABLED = "true";
    fakeRpc = fakeRpcFn(async (name: string) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow({ payout_run_status: "completed" })], error: null };
      throw new Error(`unexpected RPC: ${name}`);
    });
    const response = await GET(authedRequest("GET"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, mode: "reserve", enabled: true, alreadyCompleted: true });
    expect(mockCreateAdminClient).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------
// Section 40: POST dry-run, allowed even while scheduler disabled.
// ---------------------------------------------------------------------
describe("POST dry-run mode", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalEnabled = process.env.PAYOUT_SCHEDULER_ENABLED;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.PAYOUT_SCHEDULER_ENABLED;
    mockCreateAdminClient.mockClear();
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    process.env.PAYOUT_SCHEDULER_ENABLED = originalEnabled;
  });

  it("is allowed while the scheduler switch is disabled, and calls only dry_run_scheduled_payouts", async () => {
    const rows = [eligibleRow(), ineligibleRow("below_threshold")];
    fakeRpc = fakeRpcFn(async (name: string) => {
      if (name === "dry_run_scheduled_payouts") return { data: rows, error: null };
      throw new Error(`unexpected RPC: ${name}`);
    });

    const response = await POST(authedRequest("POST", { mode: "dry-run" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      mode: "dry-run",
      candidateCount: 2,
      eligibleCount: 1,
      ineligibleCount: 1,
    });
    expect(fakeRpc).toHaveBeenCalledOnce();
    expect(fakeRpc).toHaveBeenCalledWith("dry_run_scheduled_payouts");
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await POST(
      new Request("http://localhost/api/internal/payouts/run", {
        method: "POST",
        headers: { authorization: "Bearer test-cron-secret", "content-type": "application/json" },
        body: "{not valid json",
      }),
    );
    expect(response.status).toBe(400);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode with 400", async () => {
    const response = await POST(authedRequest("POST", { mode: "execute-payouts-now" }));
    expect(response.status).toBe(400);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("rejects a missing mode field with 400", async () => {
    const response = await POST(authedRequest("POST", {}));
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------
// Section 41: strict targetMonth validation for POST reserve.
// ---------------------------------------------------------------------
describe("POST reserve mode: targetMonth validation", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalEnabled = process.env.PAYOUT_SCHEDULER_ENABLED;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.PAYOUT_SCHEDULER_ENABLED = "true";
    mockCreateAdminClient.mockClear();
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    process.env.PAYOUT_SCHEDULER_ENABLED = originalEnabled;
  });

  const invalidMonths = ["2026-10", "2026/10/01", "2026-10-02", "not-a-date", "", 123, null, undefined];
  for (const targetMonth of invalidMonths) {
    it(`rejects targetMonth=${JSON.stringify(targetMonth)} with 400, before touching the DB`, async () => {
      const response = await POST(authedRequest("POST", { mode: "reserve", targetMonth }));
      expect(response.status).toBe(400);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    });
  }

  it("accepts a well-formed targetMonth and proceeds", async () => {
    fakeRpc = fakeRpcFn(async (name: string) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow({ payout_run_status: "completed" })], error: null };
      throw new Error(`unexpected RPC: ${name}`);
    });
    const response = await POST(authedRequest("POST", { mode: "reserve", targetMonth: "2026-10-01" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.targetMonth).toBe("2026-10-01");
  });
});

// ---------------------------------------------------------------------
// Section 42: completed-run behavior via the full route.
// ---------------------------------------------------------------------
describe("POST reserve mode: already-completed run", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalEnabled = process.env.PAYOUT_SCHEDULER_ENABLED;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.PAYOUT_SCHEDULER_ENABLED = "true";
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    process.env.PAYOUT_SCHEDULER_ENABLED = originalEnabled;
  });

  it("returns a safe already-completed response with no scan/reserve/complete calls", async () => {
    fakeRpc = fakeRpcFn(async (name: string) => {
      if (name === "start_scheduled_payout_run") {
        return { data: [runningRow({ payout_run_status: "completed", payout_run_id: "run-done" })], error: null };
      }
      throw new Error(`unexpected RPC: ${name}`);
    });

    const response = await POST(authedRequest("POST", { mode: "reserve", targetMonth: "2026-09-01" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, mode: "reserve", enabled: true, alreadyCompleted: true, runId: "run-done" });
    expect(fakeRpc).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------
// Section 43: a full successful run through the route.
// ---------------------------------------------------------------------
describe("POST reserve mode: successful run", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalEnabled = process.env.PAYOUT_SCHEDULER_ENABLED;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.PAYOUT_SCHEDULER_ENABLED = "true";
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    process.env.PAYOUT_SCHEDULER_ENABLED = originalEnabled;
  });

  it("start -> scan -> reserve each eligible candidate exactly once -> complete", async () => {
    const candidates = [
      eligibleRow({ author_id: "author-a", currency: "USD", payoutable_minor: 100 }),
      ineligibleRow("below_threshold", { author_id: "author-b" }),
    ];
    const reserveCalls: unknown[] = [];
    fakeRpc = fakeRpcFn(async (name: string, params?: unknown) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "reserve_author_payout") {
        reserveCalls.push(params);
        return { data: [{ payout_id: "p1", amount_minor: 100, currency: "USD" }], error: null };
      }
      if (name === "complete_scheduled_payout_run") return { data: [runningRow({ payout_run_status: "completed" })], error: null };
      throw new Error(`unexpected RPC: ${name}`);
    });

    const response = await POST(authedRequest("POST", { mode: "reserve", targetMonth: "2026-10-01" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      mode: "reserve",
      enabled: true,
      alreadyCompleted: false,
      candidateCount: 2,
      eligibleCount: 1,
      reservedCount: 1,
      skippedCount: 0,
    });
    expect(reserveCalls).toHaveLength(1);
    expect(fakeRpc).toHaveBeenCalledWith("complete_scheduled_payout_run", { p_run_id: "run-1" });
  });
});

// ---------------------------------------------------------------------
// Section 44: state-change / no-reservation is not an error.
// ---------------------------------------------------------------------
describe("POST reserve mode: state change between scan and reserve", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalEnabled = process.env.PAYOUT_SCHEDULER_ENABLED;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.PAYOUT_SCHEDULER_ENABLED = "true";
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    process.env.PAYOUT_SCHEDULER_ENABLED = originalEnabled;
  });

  it("dry-run eligible but reserve returns zero rows successfully: skipped, not an error, run still completes", async () => {
    const candidates = [eligibleRow({ author_id: "author-a" })];
    fakeRpc = fakeRpcFn(async (name: string) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "reserve_author_payout") return { data: [], error: null };
      if (name === "complete_scheduled_payout_run") return { data: [runningRow({ payout_run_status: "completed" })], error: null };
      throw new Error(`unexpected RPC: ${name}`);
    });

    const response = await POST(authedRequest("POST", { mode: "reserve", targetMonth: "2026-10-01" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, reservedCount: 0, skippedCount: 1 });
    expect(fakeRpc).toHaveBeenCalledWith("complete_scheduled_payout_run", { p_run_id: "run-1" });
  });
});

// ---------------------------------------------------------------------
// Section 45: an unexpected candidate error fails the whole HTTP
// response, without blocking evaluation of other candidates.
// ---------------------------------------------------------------------
describe("POST reserve mode: candidate error", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalEnabled = process.env.PAYOUT_SCHEDULER_ENABLED;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.PAYOUT_SCHEDULER_ENABLED = "true";
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    process.env.PAYOUT_SCHEDULER_ENABLED = originalEnabled;
  });

  it("returns 500, never calls complete_scheduled_payout_run, but still evaluates every candidate", async () => {
    const candidates = [
      eligibleRow({ author_id: "author-fail" }),
      eligibleRow({ author_id: "author-ok" }),
    ];
    let completeCalled = false;
    fakeRpc = fakeRpcFn(async (name: string, params?: unknown) => {
      if (name === "start_scheduled_payout_run") return { data: [runningRow()], error: null };
      if (name === "dry_run_scheduled_payouts") return { data: candidates, error: null };
      if (name === "reserve_author_payout") {
        const p = params as { p_author_id: string };
        if (p.p_author_id === "author-fail") return { data: null, error: { message: "boom" } };
        return { data: [{ payout_id: "p-ok", amount_minor: 5, currency: "USD" }], error: null };
      }
      if (name === "complete_scheduled_payout_run") {
        completeCalled = true;
        return { data: [runningRow({ payout_run_status: "completed" })], error: null };
      }
      throw new Error(`unexpected RPC: ${name}`);
    });

    const response = await POST(authedRequest("POST", { mode: "reserve", targetMonth: "2026-10-01" }));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("candidate_errors");
    expect(completeCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Section 46/54: no application-level lock/mutex; no direct financial
// DML; no payout-lifecycle execution RPC; no provider/Stripe imports;
// no secret logging; no query-string secret support (source review).
// ---------------------------------------------------------------------
describe("source-level guards", () => {
  const routeSource = readFileSync(path.join(__dirname, "route.ts"), "utf8");
  const libSource = readFileSync(
    path.join(__dirname, "..", "..", "..", "..", "..", "lib", "payout-scheduler.ts"),
    "utf8",
  );
  const combined = `${routeSource}\n${libSource}`;

  it("never references an in-memory lock/mutex/semaphore mechanism", () => {
    expect(combined).not.toMatch(/mutex/i);
    expect(combined).not.toMatch(/semaphore/i);
    expect(combined).not.toMatch(/advisory_lock|pg_advisory/i);
  });

  it("never performs direct INSERT/UPDATE/DELETE on the financial tables", () => {
    for (const table of ["payout_runs", "author_payouts", "author_ledger_entries"]) {
      expect(combined).not.toMatch(new RegExp(`\\.from\\(["']${table}["']\\)`));
    }
  });

  it("never calls a payout-lifecycle execution RPC", () => {
    for (const rpcName of ["start_author_payout", "finalize_author_payout", "fail_author_payout", "cancel_author_payout", "mark_author_payout_reconciling"]) {
      expect(combined).not.toContain(`"${rpcName}"`);
    }
  });

  it("only calls the four migration-053 scheduler RPCs, by exact name", () => {
    const calledRpcNames = [...combined.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const allowed = new Set([
      "dry_run_scheduled_payouts",
      "start_scheduled_payout_run",
      "reserve_author_payout",
      "complete_scheduled_payout_run",
    ]);
    for (const name of calledRpcNames) {
      expect(allowed.has(name)).toBe(true);
    }
  });

  it("never imports a payment-provider SDK or Stripe", () => {
    expect(combined).not.toMatch(/from ["']stripe["']/);
    expect(combined).not.toMatch(/from ["']@\/lib\/stripe["']/);
    expect(combined).not.toMatch(/paypal|paysera/i);
  });

  it("never logs the secret-bearing variables (configuredSecret/expected/authHeader)", () => {
    // The literal string "CRON_SECRET" naming the env var in an
    // operational message (e.g. "CRON_SECRET is not configured") is
    // fine and expected -- what must never happen is a console call
    // receiving one of the variables that actually HOLDS the secret
    // value or the raw Authorization header.
    expect(routeSource).not.toMatch(/console\.(log|error|warn)\([^)]*configuredSecret/);
    expect(routeSource).not.toMatch(/console\.(log|error|warn)\([^)]*\bexpected\b/);
    expect(routeSource).not.toMatch(/console\.(log|error|warn)\([^)]*authHeader/);
  });

  it("never reads the secret from a query string or request body", () => {
    expect(routeSource).not.toMatch(/searchParams.*secret/i);
    expect(routeSource).not.toMatch(/body\.secret/);
  });

  // LEDGER-1E-D-G: this route's cron entry was deliberately registered
  // in vercel.json once the monthly payout schedule was approved --
  // full structural validation (exact schedule, no duplicates, existing
  // reconciliation cron preserved) lives in
  // src/lib/vercel-cron-config.test.ts. This guard is narrower: it only
  // confirms cron registration didn't silently regress back to absent.
  it("has a cron entry registered in vercel.json (see vercel-cron-config.test.ts for full validation)", () => {
    const vercelJson = readFileSync(path.join(process.cwd(), "vercel.json"), "utf8");
    expect(vercelJson).toContain("/api/internal/payouts/run");
  });
});
