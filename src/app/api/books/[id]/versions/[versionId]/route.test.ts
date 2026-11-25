import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// FV1 (fv2 a, fv3 a): "Shkarko" on an earlier file in the author's
// Content tab. Signed-in author of this book only (own session, RLS and
// author_id); a 5-minute signed URL only for a replaced row of this book
// whose key is the book's own; never cached; nothing else reaches Storage.

let recoveryActive = false;
const mockCookieStore = {
  get: (name: string) => (name === RECOVERY_COOKIE_NAME && recoveryActive ? { value: "1" } : undefined),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

type Result = { data: unknown; error: unknown };
let user: { id: string } | null;
let ownResult: Result;
let versionResult: Result;
const sessionReads: [string, unknown][][] = [];
const adminReads: [string, unknown][][] = [];
const mockSign = vi.fn();

function chain(result: () => Result, record: [string, unknown][][]) {
  const filters: [string, unknown][] = [];
  const c = {
    select: () => c,
    eq: (column: string, value: unknown) => (filters.push([column, value]), c),
    maybeSingle: async () => (record.push(filters), result()),
  };
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      if (table !== "books") throw new Error(`unexpected session table ${table}`);
      return chain(() => ownResult, sessionReads);
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "book_file_versions") throw new Error(`unexpected admin table ${table}`);
      return chain(() => versionResult, adminReads);
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (path: string, seconds: number, options: unknown) => mockSign(bucket, path, seconds, options),
      }),
    },
  }),
}));

const { GET, HEAD } = await import("./route");

const AUTHOR = "66666666-6666-4666-8666-666666666666";
const OTHER_AUTHOR = "77777777-7777-4777-8777-777777777777";
const BOOK = "22222222-2222-4222-8222-222222222222";
const VERSION = "55555555-5555-4555-8555-555555555555";
const FILE = `${AUTHOR}/${BOOK}/0f0e0d0c-0b0a-4908-8706-050403020100.epub`;
const SIGNED = "https://storage.example/signed?token=abc";
const VERSION_ROW = { id: VERSION, file_path: FILE, live_from: "2026-10-05T10:00:00Z", replaced_at: "2026-11-02T10:00:00Z" };

function call(versionId = VERSION, id = BOOK) {
  return GET(new Request(`https://librum.example/api/books/${id}/versions/${versionId}`), {
    params: Promise.resolve({ id, versionId }),
  });
}

function target(response: Response): string {
  const location = response.headers.get("location") ?? "";
  if (location.startsWith("https://librum.example")) {
    const url = new URL(location);
    return decodeURIComponent(`${url.pathname}${url.search}`);
  }
  return location;
}

const UNAVAILABLE = `/dashboard/books/${BOOK}/editor?tab=content&error=Ky skedar nuk është i disponueshëm.`;

beforeEach(() => {
  recoveryActive = false;
  user = { id: AUTHOR };
  ownResult = { data: { id: BOOK }, error: null };
  versionResult = { data: { ...VERSION_ROW }, error: null };
  sessionReads.length = 0;
  adminReads.length = 0;
  mockSign.mockReset().mockResolvedValue({ data: { signedUrl: SIGNED }, error: null });
});

describe("GET /api/books/[id]/versions/[versionId]", () => {
  it("the book's author gets a 5-minute signed download of the earlier file, never cached", async () => {
    const response = await call();
    expect(response.status).toBe(307);
    expect(target(response)).toBe(SIGNED);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(mockSign).toHaveBeenCalledWith("manuscripts", FILE, 300, { download: true });
    expect(sessionReads).toEqual([[["id", BOOK], ["author_id", AUTHOR]]]);
    expect(adminReads).toEqual([[["id", VERSION], ["book_id", BOOK]]]);
  });

  it("a recovery session gets a 403, before any read", async () => {
    recoveryActive = true;
    const response = await call();
    expect(response.status).toBe(403);
    expect(sessionReads).toEqual([]);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("signed out: to the login page, no read", async () => {
    user = null;
    expect(target(await call())).toBe("/login");
    expect(sessionReads).toEqual([]);
  });

  it("not the author (or the read fails): back to the dashboard, no admin read, no Storage call", async () => {
    for (const result of [
      { data: null, error: null },
      { data: { id: BOOK }, error: { code: "57014" } },
      { data: { id: "someone-else" }, error: null },
    ]) {
      ownResult = result;
      adminReads.length = 0;
      expect(target(await call())).toBe("/dashboard");
      expect(adminReads).toEqual([]);
      expect(mockSign).not.toHaveBeenCalled();
    }
  });

  it("bad ids: back to the dashboard, no read", async () => {
    expect(target(await call("nope"))).toBe("/dashboard");
    expect(target(await call(VERSION, "nope"))).toBe("/dashboard");
    expect(sessionReads).toEqual([]);
  });

  it("a row that is not this book's earlier own file is 'not available', with no Storage call", async () => {
    for (const result of [
      { data: null, error: null },
      { data: { ...VERSION_ROW }, error: { code: "57014" } },
      { data: { ...VERSION_ROW, replaced_at: null }, error: null },
      { data: { ...VERSION_ROW, file_path: `${OTHER_AUTHOR}/${BOOK}.epub` }, error: null },
    ]) {
      versionResult = result;
      expect(target(await call())).toBe(UNAVAILABLE);
      expect(mockSign).not.toHaveBeenCalled();
    }
  });

  it("a failed signing is 'not available'", async () => {
    mockSign.mockResolvedValue({ data: null, error: { message: "nope" } });
    expect(target(await call())).toBe(UNAVAILABLE);
  });

  it("HEAD is refused", () => {
    expect(HEAD().status).toBe(405);
  });
});
