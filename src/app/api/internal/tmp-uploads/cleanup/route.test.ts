import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// ALERTS-2: GET hands its response to the failure email; pass-through here.
const alertIfCronFailed = vi.hoisted(() => vi.fn(async (_path: string, response: Response) => response));
vi.mock("@/lib/error-alerts", () => ({ alertIfCronFailed }));
import { readFileSync } from "node:fs";

// BD5: the cron route. createAdminClient() is mocked so every test stays
// offline; the fake bucket records which bucket was opened and every
// list/remove call.
const ACCOUNT = "a1b2c3d4-1111-4111-8111-abcdef111111";
const FILE = "0b8e6a52-6f0e-4d3c-9a61-2f4d8c1e7b90";
const OLD = "2020-01-01T00:00:00Z";

const calls = { buckets: [] as string[], lists: [] as string[], removes: [] as string[][] };
let removeError: unknown = null;

// G2 c1: the blog bucket's inline pictures and the posts' text.
const USED = "11111111-1111-4111-8111-111111111111";
const UNUSED = "22222222-2222-4222-8222-222222222222";
let postTexts: { content_markdown: string }[] = [];
let postsError: unknown = null;
// B1 (audit r1): a count that differs from the rows returned (partial read).
let postsCount: number | null = null;

function listing(prefix: string, bucket = "manuscripts") {
  if (bucket === "blog") {
    if (prefix !== "inline") return [];
    return [
      { name: `${USED}.jpg`, id: "u", created_at: OLD, updated_at: OLD },
      { name: `${UNUSED}.jpg`, id: "v", created_at: OLD, updated_at: OLD },
    ];
  }
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
          calls.lists.push(bucket === "blog" ? `blog:${prefix}` : prefix);
          return { data: listing(prefix, bucket).slice(opts.offset, opts.offset + opts.limit), error: null };
        },
        async remove(keys: string[]) {
          calls.removes.push(bucket === "blog" ? keys.map((k) => `blog:${k}`) : keys);
          return { data: null, error: removeError };
        },
      };
    },
  },
  from(table: string) {
    expect(table).toBe("blog_posts");
    return {
      select: (columns: string, opts: unknown) => {
        expect(columns).toBe("content_markdown");
        expect(opts).toEqual({ count: "exact" });
        return {
          range: async () =>
            postsError ? { data: null, error: postsError, count: null } : { data: postTexts, error: null, count: postsCount ?? postTexts.length },
        };
      },
    };
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
  postTexts = [{ content_markdown: `Tekst ![](https://x.supabase.co/storage/v1/object/public/blog/inline/${USED}.jpg)` }];
  postsError = null;
  postsCount = null;
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
    expect(calls.buckets).toEqual(["manuscripts", "blog"]);
    expect(calls.removes).toEqual([[`${ACCOUNT}/tmp/epub/${FILE}.epub`], [`blog:inline/${UNUSED}.jpg`]]);
    expect(body.blogImages).toMatchObject({ ok: true, posts: 1, pictures: 2, inUse: 1, removed: 1, removedKeys: [`inline/${UNUSED}.jpg`] });
    // n2 a: the removed blog picture is named in the job log (never the kept one).
    expect(JSON.stringify(log.mock.calls)).toContain(`inline/${UNUSED}.jpg`);
    expect(JSON.stringify(log.mock.calls)).not.toContain(USED);
    const logged = JSON.stringify(log.mock.calls) + JSON.stringify(body);
    expect(logged).not.toContain(ACCOUNT);
    expect(logged).not.toContain(FILE);
  });

  it("G2 c1: a failed posts read removes no blog picture and answers 500", async () => {
    postsError = { message: "db down" };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(calls.removes.flat().some((k) => k.startsWith("blog:"))).toBe(false);
    expect(JSON.stringify(err.mock.calls)).not.toContain(UNUSED);
  });

  it("G2 c1 (audit B1): a partial posts read (count above the rows returned) removes no blog picture and answers 500", async () => {
    postsCount = postTexts.length + 1;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect((await res.json()).blogImages).toMatchObject({ ok: false, error: "posts read failed", removed: 0 });
    expect(calls.removes.flat().some((k) => k.startsWith("blog:"))).toBe(false);
  });

  it("G2 c1 (audit B1): a post row whose text is not a string removes no blog picture and answers 500", async () => {
    postTexts = [...postTexts, { content_markdown: null as unknown as string }];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(calls.removes.flat().some((k) => k.startsWith("blog:"))).toBe(false);
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
    const get = source.slice(source.indexOf("async function runJob"));
    expect(get.indexOf("authenticate(request)")).toBeLessThan(get.indexOf("createAdminClient()"));
    expect(get.indexOf("TMP_CLEANUP_OFF_ENV")).toBeLessThan(get.indexOf("createAdminClient()"));
  });
});

describe("ALERTS-2 failure email wiring", () => {
  it("passes the GET response to alertIfCronFailed with this job's path", async () => {
    alertIfCronFailed.mockClear();
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const response = await GET(new Request("http://localhost/api/internal/tmp-uploads/cleanup"));
      expect(response.status).toBe(503);
      expect(alertIfCronFailed).toHaveBeenCalledTimes(1);
      expect(alertIfCronFailed).toHaveBeenCalledWith("/api/internal/tmp-uploads/cleanup", response);
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
    }
  });
});
