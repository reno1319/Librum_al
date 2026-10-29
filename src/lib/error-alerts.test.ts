import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.hoisted(() => vi.fn(async (_to: string, _subject: string, _html: string) => {}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail,
}));

import {
  ERROR_EMAIL_MIN_INTERVAL_MS,
  ERROR_EMAILS_PER_DAY,
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
      "2 more server errors on this server since the last email were not emailed (at most one email an hour and 3 a day).",
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
