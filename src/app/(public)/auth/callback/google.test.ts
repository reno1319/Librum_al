import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// K7: the callback's Google branch (google=1). finishGoogleSignIn() is
// tested in src/lib/google-sign-in.test.ts; here it is mocked.
const mockExchange = vi.fn();
const mockCreateClient = vi.fn(async () => ({ auth: { exchangeCodeForSession: mockExchange } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockFinish = vi.fn();
vi.mock("@/lib/google-sign-in", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-sign-in")>()),
  finishGoogleSignIn: (u: unknown, a: boolean, k: unknown) => mockFinish(u, a, k),
}));

const mockScheduleAuthorWelcome = vi.fn();
vi.mock("@/lib/author-welcome", () => ({ scheduleAuthorWelcome: (id: string) => mockScheduleAuthorWelcome(id) }));

const { GET } = await import("./route");
const BASE = "https://librum.example/auth/callback";
const USER = { id: "u1", identities: [{ provider: "google" }] };
const FAILED = encodeURIComponent("Hyrja me Google nuk u krye. Provoni përsëri.");

function get(query: string, cookie?: string) {
  return GET(new Request(`${BASE}?${query}`, cookie ? { headers: { cookie } } : undefined));
}
function hintCleared(res: Response) {
  return /librum_google_author=;[^,]*Path=\/auth\/callback/i.test(res.headers.get("set-cookie") ?? "");
}

beforeEach(() => {
  mockExchange.mockReset().mockResolvedValue({ data: { user: USER, session: {} }, error: null });
  mockFinish.mockReset().mockResolvedValue("reader");
  mockCreateClient.mockClear();
  mockScheduleAuthorWelcome.mockClear();
});

describe("GET /auth/callback?google=1", () => {
  it("reader: goes to next, clears a stale recovery marker and the hint, never sets recovery", async () => {
    const res = await get("google=1&code=c&next=/library");
    expect(res.headers.get("location")).toBe("https://librum.example/library");
    expect(mockFinish).toHaveBeenCalledWith(USER, false, "person");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain(RECOVERY_COOKIE_NAME);
    expect(sc).not.toContain(`${RECOVERY_COOKIE_NAME}=1`);
    expect(hintCleared(res)).toBe(true);
  });

  it("an unsafe next goes home", async () => {
    const res = await get(`google=1&code=c&next=${encodeURIComponent("//evil.example")}`);
    expect(res.headers.get("location")).toBe("https://librum.example/");
  });

  it("the author hint cookie is passed on; an author goes to the dashboard", async () => {
    mockFinish.mockResolvedValue("author");
    const res = await get("google=1&code=c", "a=b; librum_google_author=1");
    expect(mockFinish).toHaveBeenCalledWith(USER, true, "person");
    expect(res.headers.get("location")).toBe("https://librum.example/dashboard");
    expect(hintCleared(res)).toBe(true);
  });

  // BUILD 2a-1: the house hint ("house") asks for a house author account.
  it("the house hint is passed on as the publishing-house kind; it goes to the dashboard", async () => {
    mockFinish.mockResolvedValue("author");
    const res = await get("google=1&code=c", "librum_google_author=house");
    expect(mockFinish).toHaveBeenCalledWith(USER, true, "publishing_house");
    expect(res.headers.get("location")).toBe("https://librum.example/dashboard");
    expect(hintCleared(res)).toBe(true);
  });

  it("a hint with another value is no hint", async () => {
    await get("google=1&code=c", "librum_google_author=yes");
    expect(mockFinish).toHaveBeenCalledWith(USER, false, "person");
  });

  it("author_failed: to /account with the reader-account message", async () => {
    mockFinish.mockResolvedValue("author_failed");
    const res = await get("google=1&code=c", "librum_google_author=1");
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/account");
    expect(loc.searchParams.get("error")).toContain("Botoni librat tuaj");
  });

  it.each([
    ["a failed exchange", "google=1&code=c", { data: { user: null, session: null }, error: { message: "raw gotrue" } }],
    ["no code (cancelled on Google)", "google=1&error=access_denied&error_description=raw", null],
  ])("%s: /login with our Google message only, nothing finished, hint cleared", async (_l, q, answer) => {
    if (answer) mockExchange.mockResolvedValue(answer);
    const res = await get(q, "librum_google_author=1");
    expect(res.headers.get("location")).toBe(`https://librum.example/login?error=${FAILED}`);
    expect(res.headers.get("location")).not.toContain("raw");
    expect(mockFinish).not.toHaveBeenCalled();
    expect(hintCleared(res)).toBe(true);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(RECOVERY_COOKIE_NAME);
  });

  it("audit B1: a recovery code with google=1 keeps containment (marker set, /reset-password, nothing finished)", async () => {
    mockExchange.mockResolvedValue({ data: { user: USER, session: {}, redirectType: "recovery" }, error: null });
    const res = await get("google=1&code=c&next=/library", "librum_google_author=1");
    expect(res.headers.get("location")).toBe("https://librum.example/reset-password");
    expect(res.headers.get("set-cookie") ?? "").toContain(`${RECOVERY_COOKIE_NAME}=1`);
    expect(mockFinish).not.toHaveBeenCalled();
    expect(hintCleared(res)).toBe(true);
  });

  it("without google=1 the old path is used: finish never runs", async () => {
    await get("code=c&next=/");
    expect(mockFinish).not.toHaveBeenCalled();
  });
});

// AUTHOR-EMAILS: a finished Google sign-in asks for the author welcome
// AFTER finishGoogleSignIn() (so a new author already is one); a
// recovery or a failed exchange never does.
describe("GET /auth/callback?google=1: author welcome", () => {
  it("is scheduled after the sign-in is finished", async () => {
    mockFinish.mockResolvedValue("author");
    await get("google=1&code=c&next=/", "librum_google_author=1");
    expect(mockScheduleAuthorWelcome).toHaveBeenCalledExactlyOnceWith("u1");
    expect(mockFinish.mock.invocationCallOrder[0]).toBeLessThan(mockScheduleAuthorWelcome.mock.invocationCallOrder[0]);
  });

  it("is not scheduled for a recovery or a failed exchange", async () => {
    mockExchange.mockResolvedValue({ data: { user: USER, session: {}, redirectType: "recovery" }, error: null });
    await get("google=1&code=c&next=/");
    mockExchange.mockResolvedValue({ data: { user: null, session: null }, error: { message: "x" } });
    await get("google=1&code=c&next=/");
    expect(mockScheduleAuthorWelcome).not.toHaveBeenCalled();
  });
});
