import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.hoisted(() => vi.fn(async (_to: string, _subject: string, _html: string) => {}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail,
}));

// N18: the shared count. By default the database cannot be asked, so
// every test above the N18 block exercises the per-instance fallback
// (e1 a), which is exactly the pre-N18 behaviour.
const rpc = vi.hoisted(() => vi.fn());
const abortSignal = vi.hoisted(() => vi.fn());
const createAdminClient = vi.hoisted(() => vi.fn(() => ({ rpc })));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import {
  ERROR_EMAIL_MIN_INTERVAL_MS,
  ERROR_EMAILS_PER_DAY,
  SHARED_CAP_TIMEOUT_MS,
  SHARED_REFUSAL_BACKOFF_MS,
  alertIfCronFailed,
  cleanPath,
  redactErrorMessage,
  reportServerError,
  resetErrorAlertThrottle,
} from "@/lib/error-alerts";

const REQUEST = { path: "/libra/abc?key=s3cret-key-value", method: "GET" };
const CONTEXT = { routePath: "/(public)/libra/[id]", routeType: "render" };
const T0 = Date.UTC(2026, 9, 27, 20, 0, 0);

beforeEach(() => {
  resetErrorAlertThrottle();
  sendEmail.mockClear();
  rpc.mockReset();
  abortSignal.mockReset();
  createAdminClient.mockClear();
  rpc.mockReturnValue({ abortSignal });
  abortSignal.mockRejectedValue(new Error("database unreachable"));
  vi.stubEnv("VERCEL_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reportServerError", () => {
  it("emails support with the route, error and digest, never the query string", async () => {
    const error = Object.assign(new TypeError("Cannot read properties of undefined"), { digest: "123456" });
    await reportServerError(error, REQUEST, CONTEXT, T0);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendEmail.mock.calls[0]!;
    expect(to).toBe("support@librum.al");
    expect(subject).toBe("Site error: render /(public)/libra/[id]");
    expect(html).toContain("2026-10-27T20:00:00.000Z");
    expect(html).toContain("GET /libra/abc<");
    expect(html).toContain("TypeError");
    expect(html).toContain("123456");
    expect(html).toContain("Cannot read properties of undefined");
    expect(html).not.toContain("s3cret");
    expect(html).not.toContain("key=");
  });

  it("sends nothing outside production", async () => {
    for (const env of ["preview", "development", ""]) {
      vi.stubEnv("VERCEL_ENV", env);
      await reportServerError(new Error("x"), REQUEST, CONTEXT, T0);
    }
    vi.unstubAllEnvs();
    await reportServerError(new Error("x"), REQUEST, CONTEXT, T0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each(["NEXT_REDIRECT;replace;/login;307;", "NEXT_NOT_FOUND", "NEXT_HTTP_ERROR_FALLBACK;404", "DYNAMIC_SERVER_USAGE"])(
    "ignores Next.js control flow (%s)",
    async (digest) => {
      await reportServerError(Object.assign(new Error(digest), { digest }), REQUEST, CONTEXT, T0);
      expect(sendEmail).not.toHaveBeenCalled();
    },
  );

  it("one email per hour; the next one counts the errors in between", async () => {
    expect(ERROR_EMAIL_MIN_INTERVAL_MS).toBe(60 * 60 * 1000);
    await reportServerError(new Error("first"), REQUEST, CONTEXT, T0);
    await reportServerError(new Error("second"), REQUEST, CONTEXT, T0 + 1000);
    await reportServerError(new Error("third"), REQUEST, CONTEXT, T0 + ERROR_EMAIL_MIN_INTERVAL_MS - 1);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    await reportServerError(new Error("fourth"), REQUEST, CONTEXT, T0 + ERROR_EMAIL_MIN_INTERVAL_MS);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const html = sendEmail.mock.calls[1]![2];
    expect(html).toContain("fourth");
    expect(html).toContain(
      "2 more server errors on this server since the last email were not emailed (at most one email an hour and 3 a day on this server, as the shared count could not be reached).",
    );

    await reportServerError(new Error("fifth"), REQUEST, CONTEXT, T0 + 2 * ERROR_EMAIL_MIN_INTERVAL_MS);
    expect(sendEmail.mock.calls[2]![2]).not.toContain("more server error");
  });

  it("at most 3 emails per UTC day, counting resumes the next day", async () => {
    expect(ERROR_EMAILS_PER_DAY).toBe(3);
    const hour = ERROR_EMAIL_MIN_INTERVAL_MS;
    // 2026-10-27 00:30Z, then every hour until 23:30Z: 24 errors.
    const dayStart = Date.UTC(2026, 9, 27, 0, 30, 0);
    for (let i = 0; i < 24; i += 1) {
      await reportServerError(new Error(`e${i}`), REQUEST, CONTEXT, dayStart + i * hour);
    }
    expect(sendEmail).toHaveBeenCalledTimes(3);

    await reportServerError(new Error("next day"), REQUEST, CONTEXT, dayStart + 24 * hour);
    expect(sendEmail).toHaveBeenCalledTimes(4);
    expect(sendEmail.mock.calls[3]![2]).toContain("21 more server errors");
  });

  it("escapes HTML from the path and the message", async () => {
    await reportServerError(new Error("<img src=x onerror=alert(1)>"), { path: "/<script>", method: "POST" }, CONTEXT, T0);
    const html = sendEmail.mock.calls[0]![2];
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles thrown non-Error values", async () => {
    await reportServerError("plain string", REQUEST, CONTEXT, T0);
    expect(sendEmail.mock.calls[0]![2]).toContain("plain string");
  });

  it("never throws, even when sending throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error("resend down"));
    await expect(reportServerError(new Error("x"), REQUEST, CONTEXT, T0)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("reportServerError failed", { error: "Error" });
  });
});

describe("redactErrorMessage", () => {
  it("blanks email addresses and long tokens, keeps the rest", () => {
    expect(redactErrorMessage("user ana@example.com not found")).toBe("user [email] not found");
    expect(redactErrorMessage("bad jwt eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz.x")).toBe("bad jwt [token].x");
    expect(redactErrorMessage("relation \"books\" does not exist")).toBe("relation \"books\" does not exist");
  });

  it("cuts long messages", () => {
    const out = redactErrorMessage("word ".repeat(200));
    expect(out.length).toBe(301);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("cleanPath", () => {
  it("drops the query and fragment", () => {
    expect(cleanPath("/unlock?key=abc")).toBe("/unlock");
    expect(cleanPath("/a#b")).toBe("/a");
    expect(cleanPath("/plain")).toBe("/plain");
  });

  it("blanks emails (also percent-encoded), ids, tokens and hex runs in the path", () => {
    expect(cleanPath("/autore/ana@example.com")).toBe("/autore/[email]");
    expect(cleanPath("/autore/ana%40example.com/books")).toBe("/autore/[email]/books");
    expect(cleanPath("/admin/people/123e4567-e89b-12d3-a456-426614174000")).toBe("/admin/people/[token]");
    expect(cleanPath("/x/abcdefghijklmnopqrstuvwxyzABCDEF012345")).toBe("/x/[token]");
    expect(cleanPath("/x/deadbeefdeadbeef/y")).toBe("/x/[hex]/y");
    expect(cleanPath("/libra/new")).toBe("/libra/new");
  });

  it("keeps a malformed path as it is, still cleaned", () => {
    expect(cleanPath("/bad%E0%A4%A/ana@example.com")).toBe("/bad%E0%A4%A/[email]");
  });

  it("cuts long paths", () => {
    const out = cleanPath(`/${"a/".repeat(200)}`);
    expect(out.length).toBe(201);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ALERTS-2: nightly job failures (they answer 5xx instead of throwing).
describe("alertIfCronFailed", () => {
  const PATH = "/api/internal/account-deletions/run";

  it("emails a 500 or 503 with only the job path and status, and returns the response unchanged", async () => {
    for (const status of [500, 503]) {
      resetErrorAlertThrottle();
      sendEmail.mockClear();
      const response = new Response(JSON.stringify({ ok: false, secretish: "do-not-email" }), { status });
      expect(await alertIfCronFailed(PATH, response, T0)).toBe(response);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      const [to, subject, html] = sendEmail.mock.calls[0]!;
      expect(to).toBe("support@librum.al");
      expect(subject).toBe(`Site error: cron ${PATH}`);
      expect(html).toContain(`GET ${PATH}<`);
      expect(html).toContain("CronJobFailed");
      expect(html).toContain(`Nightly job answered HTTP ${status}`);
      expect(html).not.toContain("do-not-email");
    }
  });

  it.each([200, 401, 404])("does not email a %i", async (status) => {
    const response = new Response(null, { status });
    expect(await alertIfCronFailed(PATH, response, T0)).toBe(response);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not email while maintenance mode is on (every job answers 503 on purpose)", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    await alertIfCronFailed(PATH, new Response(null, { status: 503 }), T0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not email outside Production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    await alertIfCronFailed(PATH, new Response(null, { status: 500 }), T0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("shares the cap with every other server error", async () => {
    await reportServerError(new Error("page"), REQUEST, CONTEXT, T0);
    await alertIfCronFailed(PATH, new Response(null, { status: 500 }), T0 + 1000);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// N18 (Renato 11-21): one shared count across instances.
describe("shared count (N18)", () => {
  const shared = (answer: { data: unknown; error: unknown }) => abortSignal.mockResolvedValue(answer);

  it("asks the database with the same limits, and sends when it allows", async () => {
    shared({ data: true, error: null });
    await reportServerError(new Error("x"), REQUEST, CONTEXT, T0);
    expect(rpc).toHaveBeenCalledWith("claim_error_email_slot", { p_per_day: 3, p_min_interval_seconds: 3600 });
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when another instance used the shared allowance, and counts it on the next email", async () => {
    shared({ data: false, error: null });
    await reportServerError(new Error("refused"), REQUEST, CONTEXT, T0);
    expect(sendEmail).not.toHaveBeenCalled();

    // The refusal gave the hour reservation back: once the back-off is
    // over this instance may ask again, and the shared count now allows it.
    shared({ data: true, error: null });
    await reportServerError(new Error("allowed"), REQUEST, CONTEXT, T0 + SHARED_REFUSAL_BACKOFF_MS);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const html = sendEmail.mock.calls[0]![2];
    expect(html).toContain("1 more server error on this server");
    expect(html).toContain("3 a day for the whole site).");
  });

  it("after a refusal, does not ask the database again for 5 minutes (audit M1)", async () => {
    expect(SHARED_REFUSAL_BACKOFF_MS).toBe(5 * 60 * 1000);
    shared({ data: false, error: null });
    await reportServerError(new Error("refused"), REQUEST, CONTEXT, T0);
    for (let i = 1; i <= 50; i += 1) {
      await reportServerError(new Error(`storm ${i}`), REQUEST, CONTEXT, T0 + i * 1000);
    }
    await reportServerError(new Error("almost"), REQUEST, CONTEXT, T0 + SHARED_REFUSAL_BACKOFF_MS - 1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();

    await reportServerError(new Error("asks again"), REQUEST, CONTEXT, T0 + SHARED_REFUSAL_BACKOFF_MS);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("the email names the per-server limit when the shared count could not be reached (audit L1)", async () => {
    // Database unreachable (the default): one sent, one skipped, then the next hour.
    await reportServerError(new Error("first"), REQUEST, CONTEXT, T0);
    await reportServerError(new Error("skipped"), REQUEST, CONTEXT, T0 + 1000);
    await reportServerError(new Error("next"), REQUEST, CONTEXT, T0 + ERROR_EMAIL_MIN_INTERVAL_MS);
    const html = sendEmail.mock.calls[1]![2];
    expect(html).toContain("3 a day on this server, as the shared count could not be reached).");
    expect(html).not.toContain("whole site");
  });

  it("gives the database 3 seconds, then falls back when the request is aborted (audit L2)", async () => {
    expect(SHARED_CAP_TIMEOUT_MS).toBe(3000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    // A fake RPC that never answers until its signal aborts.
    abortSignal.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const controller = new AbortController();
    timeout.mockReturnValue(controller.signal);
    const pending = reportServerError(new Error("x"), REQUEST, CONTEXT, T0);
    expect(timeout).toHaveBeenCalledWith(3000);
    expect(sendEmail).not.toHaveBeenCalled();
    controller.abort(new DOMException("timed out", "TimeoutError"));
    await pending;
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not ask the database when this instance's own count already says no", async () => {
    shared({ data: true, error: null });
    await reportServerError(new Error("first"), REQUEST, CONTEXT, T0);
    await reportServerError(new Error("second"), REQUEST, CONTEXT, T0 + 1000);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a second error on the same instance while the database is answering is skipped", async () => {
    let answer!: (value: { data: boolean; error: null }) => void;
    abortSignal.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const first = reportServerError(new Error("first"), REQUEST, CONTEXT, T0);
    await reportServerError(new Error("second"), REQUEST, CONTEXT, T0 + 10);
    answer({ data: true, error: null });
    await first;
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a database error", { data: null, error: { message: "function does not exist" } }],
    ["an unexpected answer", { data: "yes", error: null }],
  ])("falls back to this instance's own count on %s (e1 a)", async (_label, answer) => {
    shared(answer);
    await reportServerError(new Error("x"), REQUEST, CONTEXT, T0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("falls back when the admin client cannot even be made (e1 a)", async () => {
    createAdminClient.mockImplementationOnce(() => {
      throw new Error("env guard");
    });
    await reportServerError(new Error("x"), REQUEST, CONTEXT, T0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("nightly-job failures go through the same shared count (e2 a)", async () => {
    shared({ data: false, error: null });
    await alertIfCronFailed("/api/internal/payouts/run", new Response(null, { status: 500 }), T0);
    expect(rpc).toHaveBeenCalledWith("claim_error_email_slot", { p_per_day: 3, p_min_interval_seconds: 3600 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never asks the database outside Production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    await reportServerError(new Error("x"), REQUEST, CONTEXT, T0);
    expect(rpc).not.toHaveBeenCalled();
  });
});
