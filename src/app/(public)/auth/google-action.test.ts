import { describe, expect, it, vi, beforeEach } from "vitest";

// K7: signInWithGoogle(). Supabase, cookies and redirect are mocked at
// the same boundary as actions.test.ts.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
const mockOAuth = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signInWithOAuth: mockOAuth } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const { signInWithGoogle, signUpWithGoogle } = await import("./actions");
const { AUTHOR_AGE_REQUIRED_MESSAGE } = await import("@/lib/author-age-statement");

async function run(fields: Record<string, string>): Promise<string> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await (fields.google_from === "signup" ? signUpWithGoogle : signInWithGoogle)(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
  throw new Error("no redirect");
}

const GOOGLE_URL = "https://erhzpapqwyfjotliqdjo.supabase.co/auth/v1/authorize?provider=google";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://librum.example";
  mockOAuth.mockReset().mockResolvedValue({ data: { url: GOOGLE_URL, provider: "google" }, error: null });
  cookieStore.set.mockClear();
  cookieStore.delete.mockClear();
});

function redirectTo(): URL {
  return new URL(mockOAuth.mock.calls[0][0].options.redirectTo);
}

describe("signInWithGoogle", () => {
  it("login: Google with redirectTo = our callback, google=1 and a safe next; no author hint", async () => {
    expect(await run({ google_from: "login", next: "/library" })).toBe(GOOGLE_URL);
    expect(mockOAuth.mock.calls[0][0].provider).toBe("google");
    expect(mockOAuth.mock.calls[0][0].options.queryParams).toEqual({ prompt: "select_account" });
    const to = redirectTo();
    expect(`${to.origin}${to.pathname}`).toBe("https://librum.example/auth/callback");
    const { GOOGLE_CALLBACK_PARAM } = await import("@/lib/google-sign-in");
    expect(to.searchParams.get(GOOGLE_CALLBACK_PARAM)).toBe("1");
    expect(to.searchParams.get("next")).toBe("/library");
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(cookieStore.delete).toHaveBeenCalledWith({ name: "librum_google_author", path: "/auth/callback" });
  });

  it("login: an unsafe next is dropped", async () => {
    await run({ google_from: "login", next: "https://evil.example/x" });
    expect(redirectTo().searchParams.get("next")).toBeNull();
  });

  it("signup as reader: no author hint, no next, account chooser shown", async () => {
    expect(await run({ google_from: "signup", role: "reader", next: "/x" })).toBe(GOOGLE_URL);
    expect(mockOAuth.mock.calls[0][0].options.queryParams).toEqual({ prompt: "select_account" });
    expect(redirectTo().searchParams.get("next")).toBeNull();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("signup as author with the 18+ tick: short-lived httpOnly hint scoped to the callback", async () => {
    expect(await run({ google_from: "signup", role: "author", confirm_author_age: "on" })).toBe(GOOGLE_URL);
    expect(cookieStore.set).toHaveBeenCalledWith("librum_google_author", "1", expect.objectContaining({
      httpOnly: true,
      sameSite: "lax",
      path: "/auth/callback",
      maxAge: 600,
    }));
  });

  // BUILD 2a-1 (h2 b): a house needs no 18+ tick; the hint value is "house".
  it("signup as publishing house: the house hint, no tick needed", async () => {
    expect(await run({ google_from: "signup", role: "publishing_house" })).toBe(GOOGLE_URL);
    expect(cookieStore.set).toHaveBeenCalledWith("librum_google_author", "house", expect.objectContaining({
      httpOnly: true,
      sameSite: "lax",
      path: "/auth/callback",
      maxAge: 600,
    }));
  });

  it("login never sets the house hint, whatever the form says", async () => {
    await run({ google_from: "login", role: "publishing_house" });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("signup as author WITHOUT the 18+ tick: the form's refusal, Google never started", async () => {
    const to = await run({ google_from: "signup", role: "author" });
    expect(to).toBe(`/signup?role=author&error=${encodeURIComponent(AUTHOR_AGE_REQUIRED_MESSAGE)}`);
    expect(mockOAuth).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("a crafted role (admin) is a reader: no hint", async () => {
    await run({ google_from: "signup", role: "admin", confirm_author_age: "on" });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("the author choice is ignored from /login", async () => {
    await run({ google_from: "login", role: "author", confirm_author_age: "on" });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it.each([
    ["login", { data: { url: null }, error: { message: "x" } }, "/login?error="],
    ["signup", { data: { url: null }, error: null }, "/signup?error="],
  ])("%s: Supabase refusal gets our Google message, never Supabase's text", async (from, answer, prefix) => {
    mockOAuth.mockResolvedValue(answer);
    const to = await run({ google_from: from, role: "reader" });
    expect(to.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(to)).toContain("Hyrja me Google nuk u krye. Provoni përsëri.");
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});
