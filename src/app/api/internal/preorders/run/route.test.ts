import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// ALERTS-2: GET hands its response to the failure email; pass-through here.
const alertIfCronFailed = vi.hoisted(() => vi.fn(async (_path: string, response: Response) => response));
vi.mock("@/lib/error-alerts", () => ({ alertIfCronFailed }));

// BD16 P5: the pre-order cron route. The job step and the emails are
// mocked; this proves the guards (secret, maintenance, off switch, the
// 08:00 Tirana clock) and that a failed step still sweeps the readers.

vi.mock("server-only", () => ({}));
const mockRun = vi.fn();
vi.mock("@/lib/preorder-job", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/preorder-job")>();
  return { ...real, runPreorderDay: (admin: unknown) => mockRun(admin) };
});
const mockEmails = vi.fn(async (_admin: unknown, _summary: unknown) => ({ released: 2, cancelled: 1 }));
vi.mock("@/lib/preorder-emails", () => ({
  sendPreorderJobEmails: (admin: unknown, summary: unknown) => mockEmails(admin, summary),
}));
const CLEANUP = { sent: 3, cancelled: 1, released: 0 };
const mockCleanup = vi.fn(async (_admin: unknown) => CLEANUP);
vi.mock("@/lib/preorder-notify-cleanup", () => ({
  deleteOldNotifyRequests: (admin: unknown) => mockCleanup(admin),
}));
const mockCreateAdminClient = vi.fn(() => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const { GET } = await import("./route");

function request(secret: string | null = "test-cron-secret") {
  return new Request("http://localhost/api/internal/preorders/run?at=0700", {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
}

const SUMMARY = {
  today: "2026-11-06",
  releasedBookIds: ["b1"],
  slipped: [],
  cancelledBookIds: [],
  overdueBookIds: [],
  failed: [],
};

beforeEach(() => {
  mockRun.mockReset().mockResolvedValue(SUMMARY);
  mockEmails.mockClear();
  mockCleanup.mockClear();
  mockCreateAdminClient.mockClear();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  vi.stubEnv("PREORDER_JOB_OFF", "");
  vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T07:05:00Z")); // 08:05 Tirana (UTC+1)
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/internal/preorders/run", () => {
  it("refuses everything when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(request())).status).toBe(503);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it.each([null, "wrong", "test-cron-secretx"])("refuses a missing or wrong secret (%s)", async (secret) => {
    expect((await GET(request(secret))).status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("answers maintenance after authentication, without running", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    expect((await GET(request())).status).toBe(503);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("does nothing when switched off", async () => {
    vi.stubEnv("PREORDER_JOB_OFF", "1");
    const res = await GET(request());
    expect(await res.json()).toEqual({ ok: true, off: true });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockEmails).not.toHaveBeenCalled();
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-11-06T06:05:00Z", false], // winter, 07:05 Tirana: the 06:00 UTC entry does nothing
    ["2026-11-06T07:05:00Z", true], // winter, 08:05 Tirana
    ["2026-07-06T06:05:00Z", true], // summer (UTC+2), 08:05 Tirana
    ["2026-07-06T07:05:00Z", true], // summer, second entry: runs again, changes nothing more
  ])("the Tirana clock: at %s it runs = %s", async (now, runs) => {
    vi.setSystemTime(new Date(now));
    const body = await (await GET(request())).json();
    expect(mockRun).toHaveBeenCalledTimes(runs ? 1 : 0);
    expect(mockCleanup).toHaveBeenCalledTimes(runs ? 1 : 0);
    if (!runs) expect(body).toEqual({ ok: true, tooEarly: true });
  });

  it("runs the day, then the emails with its summary, and answers counts only", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(mockEmails).toHaveBeenCalledWith(expect.anything(), SUMMARY);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      today: "2026-11-06",
      released: 1,
      slipped: 0,
      cancelled: 0,
      overdue: 0,
      failed: 0,
      readers: { released: 2, cancelled: 1 },
      notifyCleanup: CLEANUP,
    });
    expect(mockEmails.mock.invocationCallOrder[0]).toBeLessThan(mockCleanup.mock.invocationCallOrder[0]);
    expect(JSON.stringify(body)).not.toContain("b1");
  });

  it("audit r1 N2: a failed cleanup step gets its own error line; the run still answers ok", async () => {
    const failed = { sent: null, cancelled: 0, released: 0 };
    mockCleanup.mockResolvedValueOnce(failed as never);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).notifyCleanup).toEqual(failed);
    expect(console.error).toHaveBeenCalledWith("[preorders] notify cleanup failed", { notifyCleanup: failed });
  });

  it("no cleanup error line when every step worked", async () => {
    await GET(request());
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a failed database step answers 500 but still sweeps the readers' emails", async () => {
    mockRun.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(mockEmails).toHaveBeenCalledWith(expect.anything(), null);
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });
});

describe("ALERTS-2 failure email wiring", () => {
  it("passes the GET response to alertIfCronFailed with this job's path", async () => {
    alertIfCronFailed.mockClear();
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const response = await GET(new Request("http://localhost/api/internal/preorders/run"));
      expect(response.status).toBe(503);
      expect(alertIfCronFailed).toHaveBeenCalledTimes(1);
      expect(alertIfCronFailed).toHaveBeenCalledWith("/api/internal/preorders/run", response);
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
    }
  });
});
