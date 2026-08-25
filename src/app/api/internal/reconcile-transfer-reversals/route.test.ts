import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";

// Same stub as src/app/api/webhooks/stripe/route.test.ts -- this route
// transitively imports route.ts (for reverseAuthorTransferForLostDispute),
// which imports @/lib/email at module scope.
vi.mock("@/lib/email", () => ({
  sendPurchaseEmails: vi.fn().mockResolvedValue(undefined),
  sendBundlePurchaseEmails: vi.fn().mockResolvedValue(undefined),
  sendSnapshotBundlePurchaseEmails: vi.fn().mockResolvedValue(undefined),
}));

// LAUNCH-1 P1-8 (Vercel Cron GET compatibility): the exported GET/POST
// handlers each call the real createAdminClient()/stripe imports
// internally before delegating to runTransferReversalReconciliation --
// unlike the rest of this file's tests (which call
// runTransferReversalReconciliation directly with fake clients), a test
// that invokes GET/POST themselves would otherwise reach real Supabase/
// Stripe network calls. These two module mocks stand in for both,
// keeping every "authenticated request" test below fully offline. Both
// factories are lazy (called fresh per invocation) so each test's own
// mockAdminTables mutation is picked up.
let mockAdminTables: Tables = {};
const mockCreateAdminClient = vi.fn(() => makeFakeSupabase(mockAdminTables));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    disputes: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
    transfers: { retrieve: vi.fn(), listReversals: vi.fn(), createReversal: vi.fn() },
  },
}));

const { GET, POST, runTransferReversalReconciliation, STALE_ATTEMPTING_THRESHOLD_MS } =
  await import("./route");

// ---------------------------------------------------------------------
// A minimal in-memory fake, deliberately scoped to exactly what
// runTransferReversalReconciliation's own call shapes need against
// payment_disputes: .select/.eq/.lt/.order/.limit for candidate
// selection, plus whatever reverseAuthorTransferForLostDispute itself
// needs (re-implemented independently here rather than importing the
// Stripe webhook's own FakeQuery, to keep this route's test suite
// self-contained).
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const DEFAULT_DISPUTE_COLUMNS = {
  transfer_reversal_status: "not_attempted",
  transfer_reversal_attempt_count: 0,
  stripe_transfer_id: null,
  stripe_transfer_reversal_id: null,
  transfer_reversal_amount_cents: null,
  transfer_reversal_attempted_at: null,
  transfer_reversal_succeeded_at: null,
  transfer_reversal_failure_code: null,
  transfer_reversal_failure_message: null,
};

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; val: unknown; op: "eq" | "lt" }[] = [];
  private op: "select" | "update" = "select";
  private payload: Row | undefined;
  private wantReturnRows = false;
  private orderSpec: { col: string; ascending: boolean } | undefined;
  private limitCount: number | undefined;

  constructor(
    private tables: Tables,
    private table: string,
  ) {}

  select() {
    if (this.op !== "select") this.wantReturnRows = true;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, val, op: "eq" });
    return this;
  }

  lt(col: string, val: unknown) {
    this.filters.push({ col, val, op: "lt" });
    return this;
  }

  order(col: string, options?: { ascending?: boolean }) {
    this.orderSpec = { col, ascending: options?.ascending ?? true };
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  private rows(): Row[] {
    return (this.tables[this.table] ??= []);
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.op === "lt") {
        const rowVal = row[f.col];
        if (rowVal === null || rowVal === undefined) return false;
        return String(rowVal) < String(f.val);
      }
      return row[f.col] === f.val;
    });
  }

  private execute(): { data: unknown; error: unknown } {
    const rows = this.rows();

    if (this.op === "select") {
      let result = rows.filter((r) => this.matches(r));
      if (this.orderSpec) {
        const { col, ascending } = this.orderSpec;
        result = [...result].sort((a, b) => {
          const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
          return ascending ? cmp : -cmp;
        });
      }
      if (this.limitCount !== undefined) result = result.slice(0, this.limitCount);
      return { data: result, error: null };
    }

    // update
    const matched = rows.filter((r) => this.matches(r));
    for (const row of matched) Object.assign(row, this.payload);
    return { data: this.wantReturnRows ? matched : null, error: null };
  }

  maybeSingle() {
    const { data, error } = this.execute();
    const arr = data as Row[];
    return Promise.resolve({ data: arr?.[0] ?? null, error });
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

function makeFakeSupabase(tables: Tables) {
  return { from: (table: string) => new FakeQuery(tables, table) };
}

function disputeRow(disputeId: string, overrides: Row = {}): Row {
  return {
    stripe_dispute_id: disputeId,
    stripe_payment_intent_id: `pi_${disputeId}`,
    status: "lost",
    reason: "fraudulent",
    amount_cents: 500,
    ...DEFAULT_DISPUTE_COLUMNS,
    ...overrides,
  };
}

function makeFakeStripeClient(params: {
  disputes?: Record<string, Partial<Stripe.Dispute>>;
  createReversalResult?: Partial<Stripe.TransferReversal>;
} = {}) {
  const disputesRetrieve = vi.fn((id: string) =>
    Promise.resolve({
      id,
      object: "dispute",
      status: "lost",
      reason: "fraudulent",
      amount: 500,
      payment_intent: `pi_${id}`,
      charge: `ch_${id}`,
      ...params.disputes?.[id],
    } as Stripe.Dispute),
  );

  const chargesRetrieve = vi.fn((chargeId: string) =>
    Promise.resolve({
      id: chargeId,
      object: "charge",
      amount: 500,
      transfer: `tr_${chargeId}`,
    } as Stripe.Charge),
  );

  const transfersRetrieve = vi.fn((transferId: string) =>
    Promise.resolve({
      id: transferId,
      object: "transfer",
      amount: 400,
      amount_reversed: 0,
    } as Stripe.Transfer),
  );

  const listReversals = vi.fn(() => ({ autoPagingToArray: () => Promise.resolve([]) }));

  const createReversal = vi.fn(() =>
    Promise.resolve({
      id: "trr_reconciled",
      object: "transfer_reversal",
      amount: 400,
      currency: "usd",
      metadata: {},
      ...params.createReversalResult,
    } as Stripe.TransferReversal),
  );

  return {
    disputes: { retrieve: disputesRetrieve },
    charges: { retrieve: chargesRetrieve },
    transfers: { retrieve: transfersRetrieve, listReversals, createReversal },
  };
}

describe("runTransferReversalReconciliation", () => {
  it("stale 'attempting' row is automatically reconciled", async () => {
    const staleAttemptedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const tables: Tables = {
      payment_disputes: [
        disputeRow("dp_stale", {
          transfer_reversal_status: "attempting",
          transfer_reversal_attempted_at: staleAttemptedAt,
          transfer_reversal_attempt_count: 1,
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeStripeClient();

    const summary = await runTransferReversalReconciliation(supabase as never, stripeClient as never);

    expect(summary.candidateCount).toBe(1);
    expect(summary.outcomes.reversed).toBe(1);
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("succeeded");
  });

  it("fresh 'attempting' row (inside the stale window) is not touched", async () => {
    const freshAttemptedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const tables: Tables = {
      payment_disputes: [
        disputeRow("dp_fresh", {
          transfer_reversal_status: "attempting",
          transfer_reversal_attempted_at: freshAttemptedAt,
          transfer_reversal_attempt_count: 1,
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeStripeClient();

    const summary = await runTransferReversalReconciliation(supabase as never, stripeClient as never);

    expect(summary.candidateCount).toBe(0);
    expect(stripeClient.disputes.retrieve).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("attempting");
  });

  it("'failed' row is retried", async () => {
    const tables: Tables = {
      payment_disputes: [
        disputeRow("dp_failed", {
          transfer_reversal_status: "failed",
          transfer_reversal_attempt_count: 1,
          transfer_reversal_failure_message: "prior failure",
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeStripeClient();

    const summary = await runTransferReversalReconciliation(supabase as never, stripeClient as never);

    expect(summary.outcomes.reversed).toBe(1);
    expect(tables.payment_disputes[0].transfer_reversal_attempt_count).toBe(2);
  });

  it("two reconciliation runs over the same state converge rather than duplicate -- safe to replay", async () => {
    const tables: Tables = {
      payment_disputes: [
        disputeRow("dp_replay", { transfer_reversal_status: "failed", transfer_reversal_attempt_count: 1 }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeStripeClient();

    const first = await runTransferReversalReconciliation(supabase as never, stripeClient as never);
    const second = await runTransferReversalReconciliation(supabase as never, stripeClient as never);

    expect(first.outcomes.reversed).toBe(1);
    expect(second.outcomes.reversed).toBe(0);
    expect(second.candidateCount).toBe(0); // already 'succeeded' -- no longer a candidate at all
    expect(stripeClient.transfers.createReversal).toHaveBeenCalledOnce();
  });

  // LAUNCH-1 P1-8: simulates two "overlapping" reconciler invocations by
  // having the SAME candidate already claimed ('attempting', fresh) by
  // the time this run's own claim executes -- exactly what a second,
  // concurrently-running invocation would have caused. The candidate
  // SELECT (advisory only) can still surface it, but the underlying
  // compare-and-swap claim (already covered directly in route.test.ts)
  // is what actually prevents a double-claim; this test checks the
  // reconciliation pass as a whole tolerates that outcome cleanly.
  it("a candidate already claimed by a concurrent run yields not_claimed, not an error", async () => {
    const tables: Tables = {
      payment_disputes: [
        disputeRow("dp_racing", {
          transfer_reversal_status: "failed",
          transfer_reversal_attempt_count: 1,
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeStripeClient();

    // Simulate the race precisely: candidate SELECTION (still 'failed')
    // succeeds normally, then -- exactly between selection and this
    // run's own internal claim, at the point reverseAuthorTransfer
    // ForLostDispute re-fetches the live dispute -- a concurrent
    // worker's own successful claim lands first, flipping the row to a
    // fresh 'attempting'. This run's own claim (a compare-and-swap on
    // the row's PRE-flip status) must then correctly find zero rows and
    // yield not_claimed, never a duplicate reversal or a thrown error.
    stripeClient.disputes.retrieve.mockImplementationOnce((id: string) => {
      tables.payment_disputes[0].transfer_reversal_status = "attempting";
      tables.payment_disputes[0].transfer_reversal_attempted_at = new Date().toISOString();
      return Promise.resolve({
        id,
        object: "dispute",
        status: "lost",
        reason: "fraudulent",
        amount: 500,
        payment_intent: `pi_${id}`,
        charge: `ch_${id}`,
      } as Stripe.Dispute);
    });

    const summary = await runTransferReversalReconciliation(supabase as never, stripeClient as never);

    expect(summary.candidateCount).toBe(1);
    expect(summary.outcomes.not_claimed).toBe(1);
    expect(summary.outcomes.error).toBe(0);
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("STALE_ATTEMPTING_THRESHOLD_MS is exactly 10 minutes, as approved", () => {
    expect(STALE_ATTEMPTING_THRESHOLD_MS).toBe(10 * 60 * 1000);
  });
});

describe("POST /api/internal/reconcile-transfer-reversals: authentication", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await POST(
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a request with the wrong bearer token", async () => {
    const response = await POST(
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("fails closed (503) when CRON_SECRET is not configured at all", async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", {
        method: "POST",
        headers: { authorization: "Bearer anything" },
      }),
    );
    expect(response.status).toBe(503);
  });

  it("accepts a correctly-authenticated request and executes reconciliation exactly once", async () => {
    mockAdminTables = {};
    mockCreateAdminClient.mockClear();
    const response = await POST(
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", {
        method: "POST",
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ received: true, candidateCount: 0 });
    // createAdminClient() is the one thing handleReconciliationRequest
    // calls immediately before its single runTransferReversalReconciliation
    // call -- exactly one call proves reconciliation ran exactly once,
    // not zero or duplicated, for this one request.
    expect(mockCreateAdminClient).toHaveBeenCalledOnce();
  });
});

// LAUNCH-1 P1-8: Vercel Cron Jobs invoke the configured path with GET,
// not POST -- see the deployment/scheduler audit. GET must be
// authenticated identically to POST and must delegate to the exact same
// reconciliation implementation, never a duplicated copy.
describe("GET /api/internal/reconcile-transfer-reversals: authentication", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await GET(
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", { method: "GET" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a request with the wrong bearer token", async () => {
    const response = await GET(
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", {
        method: "GET",
        headers: { authorization: "Bearer wrong-secret" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("fails closed (503) when CRON_SECRET is not configured at all", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", {
        method: "GET",
        headers: { authorization: "Bearer anything" },
      }),
    );
    expect(response.status).toBe(503);
  });

  it("accepts a correctly-authenticated request and executes reconciliation exactly once", async () => {
    mockAdminTables = {};
    mockCreateAdminClient.mockClear();
    const response = await GET(
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", {
        method: "GET",
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ received: true, candidateCount: 0 });
    expect(mockCreateAdminClient).toHaveBeenCalledOnce();
  });
});

describe("GET and POST return identical response shapes for equivalent authenticated requests", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    mockAdminTables = {};
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it("empty-batch GET and POST bodies are structurally identical", async () => {
    const authedRequest = (method: "GET" | "POST") =>
      new Request("http://localhost/api/internal/reconcile-transfer-reversals", {
        method,
        headers: { authorization: "Bearer test-cron-secret" },
      });

    const getResponse = await GET(authedRequest("GET"));
    const postResponse = await POST(authedRequest("POST"));

    expect(getResponse.status).toBe(postResponse.status);
    const [getBody, postBody] = await Promise.all([getResponse.json(), postResponse.json()]);
    expect(getBody).toEqual(postBody);
  });
});
