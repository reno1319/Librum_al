import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// G4 (g4q2 a, g4q7 a): one count-only alert to support, Production only,
// after the database claim; never throws.
vi.mock("server-only", () => ({}));
const mockSend = vi.fn(async (_to: string, _subject: string, _html: string) => undefined);
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: (to: string, subject: string, html: string) => mockSend(to, subject, html),
}));
vi.mock("@/lib/site-url", () => ({ resolveSiteOrigin: () => "https://librum.al" }));

const { alertPreorderEmailFailures, preorderFailureAlertEmail } = await import("./preorder-failure-alert");
const { SUPPORT_EMAIL } = await import("@/lib/contact");

function admin(result: unknown) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as never, rpc };
}

describe("preorder failure alert", () => {
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends one email to support with the claimed count", async () => {
    const { client, rpc } = admin({ data: 3, error: null });
    expect(await alertPreorderEmailFailures(client)).toBe(3);
    expect(rpc).toHaveBeenCalledWith("claim_preorder_failure_alert");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBe(SUPPORT_EMAIL);
    expect(mockSend.mock.calls[0][1]).toBe("Librum: 3 pre-order emails failed");
    expect(mockSend.mock.calls[0][2]).toContain("https://librum.al/admin");
  });

  it.each(["preview", "development", undefined])("does nothing outside Production (%s)", async (env) => {
    if (env === undefined) vi.stubEnv("VERCEL_ENV", "");
    else vi.stubEnv("VERCEL_ENV", env);
    const { client, rpc } = admin({ data: 3, error: null });
    expect(await alertPreorderEmailFailures(client)).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ["0 (none new or already sent today)", { data: 0, error: null }],
    ["a claim error", { data: null, error: { code: "42501" } }],
    ["a non-number", { data: "3", error: null }],
  ])("sends nothing on %s", async (_label, result) => {
    const { client } = admin(result);
    expect(await alertPreorderEmailFailures(client)).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never throws, even when the send throws", async () => {
    mockSend.mockRejectedValueOnce(new Error("resend down"));
    const { client } = admin({ data: 1, error: null });
    await expect(alertPreorderEmailFailures(client)).resolves.toBe(0);
  });

  it("says one email in the singular, and holds no address", () => {
    const { subject, html } = preorderFailureAlertEmail(1);
    expect(subject).toBe("Librum: 1 pre-order email failed");
    expect(html).not.toMatch(/@/);
  });
});
