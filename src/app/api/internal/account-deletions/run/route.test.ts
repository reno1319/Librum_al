import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// ALERTS-2: GET hands its response to the failure email; pass-through here.
const alertIfCronFailed = vi.hoisted(() => vi.fn(async (_path: string, response: Response) => response));
vi.mock("@/lib/error-alerts", () => ({ alertIfCronFailed }));

// DEL: the cron route only authenticates, honours maintenance and calls
// the job (src/lib/account-deletion.ts, tested on its own).
const runDue = vi.fn();
vi.mock("@/lib/account-deletion", () => ({
  runDueAccountDeletions: (...a: unknown[]) => runDue(...a),
}));
const adminClient = { marker: "service" };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));

const { GET } = await import("./route");

function request(secret: string | null = "test-cron-secret") {
  return new Request("http://localhost/api/internal/account-deletions/run", {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  runDue.mockReset();
  runDue.mockResolvedValue({ ok: true, counts: { deleted: 1 } });
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "");
  for (const m of ["error", "log"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("account-deletions cron route", () => {
  it("refuses everything without CRON_SECRET configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(request())).status).toBe(503);
    expect(runDue).not.toHaveBeenCalled();
  });

  it.each([[null], ["wrong"], ["test-cron-secre"]])("refuses a missing or wrong secret (%s)", async (secret) => {
    expect((await GET(request(secret))).status).toBe(401);
    expect(runDue).not.toHaveBeenCalled();
  });

  it("does nothing during maintenance", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(runDue).not.toHaveBeenCalled();
  });

  it("runs the job with the service client and returns its counts", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(runDue).toHaveBeenCalledWith(adminClient);
    expect(await res.json()).toEqual({ ok: true, counts: { deleted: 1 } });
  });

  it("answers 500 when the due list could not be read", async () => {
    runDue.mockResolvedValue({ ok: false });
    expect((await GET(request())).status).toBe(500);
  });
});

describe("ALERTS-2 failure email wiring", () => {
  it("passes the GET response to alertIfCronFailed with this job's path", async () => {
    alertIfCronFailed.mockClear();
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const response = await GET(new Request("http://localhost/api/internal/account-deletions/run"));
      expect(response.status).toBe(503);
      expect(alertIfCronFailed).toHaveBeenCalledTimes(1);
      expect(alertIfCronFailed).toHaveBeenCalledWith("/api/internal/account-deletions/run", response);
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
    }
  });
});
