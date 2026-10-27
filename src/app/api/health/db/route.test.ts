import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ALERTS-1: the database check uses the anon key only, never the
// service role, and its body is exactly {"ok":true|false} whatever the
// database says.
const state = vi.hoisted(() => ({
  calls: [] as { url: string; key: string; table: string; columns: string; options: unknown; limit: number }[],
  result: { error: null } as { error: { code?: string; message?: string } | null },
  throwOnCreate: false,
  hang: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("db health must never construct the service-role client");
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string) => {
    if (state.throwOnCreate) throw new Error("boom");
    return {
      from: (table: string) => ({
        select: (columns: string, options: unknown) => ({
          limit: (limit: number) => ({
            abortSignal: (signal: AbortSignal) => {
              state.calls.push({ url, key, table, columns, options, limit });
              if (!state.hang) return Promise.resolve(state.result);
              return new Promise((resolve) => {
                signal.addEventListener("abort", () =>
                  resolve({ error: { code: "", message: "AbortError: secret detail" } }),
                );
              });
            },
          }),
        }),
      }),
    };
  },
}));

beforeEach(() => {
  state.calls = [];
  state.result = { error: null };
  state.throwOnCreate = false;
  state.hang = false;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://erhzpapqwyfjotliqdjo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GET /api/health/db", () => {
  it("200 {ok:true} after one HEAD read of public_books with the anon key", async () => {
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(state.calls).toEqual([
      {
        url: "https://erhzpapqwyfjotliqdjo.supabase.co",
        key: "anon-test",
        table: "public_books",
        columns: "id",
        options: { head: true },
        limit: 1,
      },
    ]);
  });

  it("503 {ok:false} when the read fails, with no error text in the body", async () => {
    state.result = { error: { code: "PGRST000", message: "connection refused at 10.0.0.1" } };
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false });
    expect(text).not.toContain("refused");
    expect(console.error).toHaveBeenCalledWith("db health: read failed", { code: "PGRST000" });
  });

  it("503 {ok:false} when building the client throws", async () => {
    state.throwOnCreate = true;
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it("503 {ok:false} when the env guard refuses the project", async () => {
    // The production ref outside a Vercel production deployment.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://pwkukotgpsegieshulpj.supabase.co");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(state.calls).toEqual([]);
  });

  it("gives up after the timeout instead of hanging", async () => {
    state.hang = true;
    vi.useFakeTimers();
    const { GET, DB_HEALTH_TIMEOUT_MS } = await import("./route");
    const pending = GET();
    await vi.advanceTimersByTimeAsync(DB_HEALTH_TIMEOUT_MS);
    const response = await pending;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });
});
