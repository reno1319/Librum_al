import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// BD5: the cron route. createAdminClient() is mocked so every test stays
// offline; the fake bucket records which bucket was opened and every
// list/remove call.
const ACCOUNT = "a1b2c3d4-1111-4111-8111-abcdef111111";
const FILE = "0b8e6a52-6f0e-4d3c-9a61-2f4d8c1e7b90";
const OLD = "2020-01-01T00:00:00Z";

const calls = { buckets: [] as string[], lists: [] as string[], removes: [] as string[][] };
let removeError: unknown = null;

function listing(prefix: string) {
  if (prefix === "") return [{ name: ACCOUNT, id: null }];
  if (prefix === `${ACCOUNT}/tmp`) return [{ name: "epub", id: null }];
  if (prefix === `${ACCOUNT}/tmp/epub`)
    return [{ name: `${FILE}.epub`, id: "x", created_at: OLD, updated_at: OLD, metadata: { size: 5 } }];
  return [];
}

const mockCreateAdminClient = vi.fn(() => ({
  storage: {
    from(bucket: string) {
      calls.buckets.push(bucket);
      return {
        async list(prefix: string, opts: { offset: number; limit: number }) {
          calls.lists.push(prefix);
          return { data: listing(prefix).slice(opts.offset, opts.offset + opts.limit), error: null };
        },
        async remove(keys: string[]) {
          calls.removes.push(keys);
          return { data: null, error: removeError };
        },
      };
    },
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

const { GET } = await import("./route");

function request(secret: string | null = "test-cron-secret") {
  return new Request("http://localhost/api/internal/tmp-uploads/cleanup", {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  calls.buckets = [];
  calls.lists = [];
  calls.removes = [];
  removeError = null;
  mockCreateAdminClient.mockClear();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  vi.stubEnv("TMP_CLEANUP_OFF", "");
  vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/internal/tmp-uploads/cleanup", () => {
  it("refuses everything when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it.each([null, "wrong", "test-cron-secretx"])("refuses a missing or wrong secret (%s)", async (secret) => {
    const res = await GET(request(secret));
    expect(res.status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("does nothing while maintenance mode is on", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("does nothing when TMP_CLEANUP_OFF is set", async () => {
    vi.stubEnv("TMP_CLEANUP_OFF", "1");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, off: true });
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("cleans the manuscripts bucket and logs counts only, never a storage key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, removed: 1, accountsScanned: 1 });
    expect(calls.buckets).toEqual(["manuscripts"]);
    expect(calls.removes).toEqual([[`${ACCOUNT}/tmp/epub/${FILE}.epub`]]);
    const logged = JSON.stringify(log.mock.calls) + JSON.stringify(body);
    expect(logged).not.toContain(ACCOUNT);
    expect(logged).not.toContain(FILE);
  });

  it("answers 500 when a removal fails", async () => {
    removeError = new Error("storage down");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(JSON.stringify(err.mock.calls)).not.toContain(ACCOUNT);
  });

  it("has no POST handler and no other export that runs the job", async () => {
    const mod = await import("./route");
    expect(Object.keys(mod).sort()).toEqual(["GET", "maxDuration"]);
  });

  it("is a GET-only route guarded before any Supabase client is built (source)", () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    const get = source.slice(source.indexOf("export async function GET"));
    expect(get.indexOf("authenticate(request)")).toBeLessThan(get.indexOf("createAdminClient()"));
    expect(get.indexOf("TMP_CLEANUP_OFF_ENV")).toBeLessThan(get.indexOf("createAdminClient()"));
  });
});
