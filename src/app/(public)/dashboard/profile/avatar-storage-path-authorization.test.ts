import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AVATAR-STORAGE-PATH-AUTH-1 (Patch 9): updateProfile writes
// profiles.avatar_path only through the trusted server-only writer, with a
// path the server derives, and fails closed on anything but exactly the
// caller's own row holding that path.
//
// The real Server Action runs against a small in-memory profiles table
// reached through two clients:
//
//   * the SESSION client enforces the authenticated role's column-level
//     UPDATE grant -- parsed from the real SQL files, in two modes: the
//     ACL before migration 20260924160846 (migrations 033 + 045) and the
//     ACL after it (the new migration) -- plus the RLS row rule
//     `auth.uid() = id`. A statement naming an ungranted column fails as a
//     whole with 42501, exactly as PostgREST reports it.
//   * the SERVICE client (createAdminClient, reached through
//     createProfileWriteClient) bypasses both, like the service role.
//
// Every Storage call is recorded with the client and bucket it went to,
// and every database write, Storage call and revalidation is appended to
// one ordered event log.

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
const { mockRevalidatePath } = vi.hoisted(() => ({ mockRevalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const MIGRATIONS = path.join(REPO_ROOT, "supabase/migrations");
const PATCH9_MIGRATION = path.join(MIGRATIONS, "20260924160846_avatar_storage_path_authorization.sql");
const SCHEMA_PATH = path.join(REPO_ROOT, "supabase/schema.sql");

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function authenticatedProfileUpdateColumns(sql: string): string[] {
  const pattern = /grant\s+update\s*\(([^)]*)\)\s*on\s+(?:table\s+)?public\.profiles\s+to\s+authenticated\s*;/gi;
  return [...stripSqlComments(sql).matchAll(pattern)].flatMap((m) =>
    m[1].split(",").map((c) => c.trim()).filter(Boolean),
  );
}

const PRE_PATCH9_UPDATE = [
  ...authenticatedProfileUpdateColumns(readFileSync(path.join(MIGRATIONS, "033_harden_profiles_acl.sql"), "utf8")),
  ...authenticatedProfileUpdateColumns(readFileSync(path.join(MIGRATIONS, "045_public_author_name.sql"), "utf8")),
];
const PATCH9_UPDATE = authenticatedProfileUpdateColumns(readFileSync(PATCH9_MIGRATION, "utf8"));

type AclMode = "pre-migration" | "migrated";
let aclMode: AclMode = "migrated";
function sessionUpdateGrant(): string[] {
  return aclMode === "migrated" ? PATCH9_UPDATE : PRE_PATCH9_UPDATE;
}

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AVATAR = `${OTHER_ID}/avatar.png`;

// A real PNG signature is all detectCoverImageKind() reads.
const REAL_PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const REAL_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0]);

type Row = Record<string, unknown>;
type Via = "session" | "service";
type DbWrite = {
  via: Via;
  payload: Row;
  filters: [string, unknown][];
  selected: string | null;
  denied: boolean;
  rowsChanged: number;
};
type StorageCall = { via: Via; bucket: string; op: string; args: unknown[] };

let profiles: Row[] = [];
let dbWrites: DbWrite[] = [];
let storageCalls: StorageCall[] = [];
let serviceClientsCreated = 0;
let authUser: { id: string } | null = { id: USER_ID };
let tempObjects: Record<string, Buffer> = {};
let uploadError: { message: string } | null = null;
// When set, replaces what the SERVICE update returns (after it has run).
let serviceUpdateOverride: null | ((real: { data: Row[] | null; error: unknown }) => { data: unknown; error: unknown }) = null;
// When true, the SERVICE update fails before touching any row.
let serviceUpdateFails = false;
// The same two hooks for the SESSION update (display_name, bio,
// public_author_name).
let sessionUpdateOverride: null | ((real: { data: Row[] | null; error: unknown }) => { data: unknown; error: unknown }) = null;
let sessionUpdateFails = false;
let events: string[] = [];

function seed() {
  profiles = [
    { id: USER_ID, role: "author", display_name: "Jane", bio: "old bio", avatar_path: null, public_author_name: "J. Pen", stripe_account_id: null },
    { id: OTHER_ID, role: "author", display_name: "Victim", bio: "victim bio", avatar_path: OTHER_AVATAR, public_author_name: "V. Pen", stripe_account_id: "acct_x" },
  ];
}

function snapshot(): string {
  return JSON.stringify(profiles);
}

function project(row: Row, columns: string | null): Row {
  if (!columns) return { ...row };
  return Object.fromEntries(columns.split(",").map((c) => c.trim()).map((c) => [c, row[c]]));
}

function makeUpdate(via: Via, table: string, payload: Row) {
  if (table !== "profiles") throw new Error(`unexpected table ${table}`);
  const filters: [string, unknown][] = [];
  let selected: string | null = null;
  const run = () => {
    const write: DbWrite = { via, payload, filters: [...filters], selected, denied: false, rowsChanged: 0 };
    dbWrites.push(write);
    events.push(`db:${via}:update`);
    if (via === "session") {
      const granted = sessionUpdateGrant();
      if (Object.keys(payload).some((column) => !granted.includes(column))) {
        write.denied = true;
        return { data: null, error: { code: "42501", message: "permission denied for table profiles" } };
      }
      if (sessionUpdateFails) {
        return { data: null, error: { code: "08006", message: "connection failure" } };
      }
    } else if (serviceUpdateFails) {
      return { data: null, error: { code: "08006", message: "connection failure" } };
    }
    const matching = profiles.filter(
      (row) =>
        filters.every(([column, value]) => row[column] === value) &&
        (via === "service" || (authUser !== null && row.id === authUser.id)),
    );
    for (const row of matching) Object.assign(row, payload);
    write.rowsChanged = matching.length;
    const result = { data: selected === null ? null : matching.map((row) => project(row, selected)), error: null };
    if (via === "service" && serviceUpdateOverride) return serviceUpdateOverride(result);
    if (via === "session" && sessionUpdateOverride) return sessionUpdateOverride(result);
    return result;
  };
  const builder = {
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    select(columns: string) {
      selected = columns;
      return builder;
    },
    then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) {
      return Promise.resolve().then(run).then(resolve, reject);
    },
  };
  return builder;
}

function makeTable(via: Via, table: string) {
  return {
    update: (payload: Row) => makeUpdate(via, table, payload),
    select: (columns: string) => ({
      eq: (column: string, value: unknown) => ({
        single: async () => {
          const row = profiles.find(
            (r) => r[column] === value && (via === "service" || (authUser !== null && r.id === authUser.id)),
          );
          return row ? { data: project(row, columns), error: null } : { data: null, error: { code: "PGRST116" } };
        },
      }),
    }),
  };
}

function makeStorage(via: Via) {
  return {
    from: (bucket: string) => ({
      download: async (key: string) => {
        events.push(`storage:${via}:${bucket}:download`);
        storageCalls.push({ via, bucket, op: "download", args: [key] });
        const bytes = tempObjects[key];
        return bytes
          ? { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }, error: null }
          : { data: null, error: { message: "not found" } };
      },
      upload: async (...args: unknown[]) => {
        events.push(`storage:${via}:${bucket}:upload`);
        storageCalls.push({ via, bucket, op: "upload", args });
        return { error: uploadError };
      },
      remove: async (...args: unknown[]) => {
        events.push(`storage:${via}:${bucket}:remove`);
        storageCalls.push({ via, bucket, op: "remove", args });
        return { error: null };
      },
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser } }) },
    from: (table: string) => makeTable("session", table),
    storage: makeStorage("session"),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    serviceClientsCreated += 1;
    return { from: (table: string) => makeTable("service", table), storage: makeStorage("service") };
  },
}));

const { updateProfile } = await import("./actions");

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const TEMP_PNG = `${USER_ID}/tmp/avatar/5d6a1e36-cc5c-4a6d-8a51-6e7e1b1b0a01.png`;
const TEMP_JPG = `${USER_ID}/tmp/avatar/5d6a1e36-cc5c-4a6d-8a51-6e7e1b1b0a02.jpg`;

async function run(fields: Record<string, string>): Promise<string> {
  try {
    await updateProfile(form(fields));
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  throw new Error("updateProfile returned without redirecting");
}

const SAVE_PHOTO_ERROR = `/dashboard/profile?error=${encodeURIComponent("We couldn't save your profile photo. Please try again.")}`;
const SAVE_PROFILE_ERROR = `/dashboard/profile?error=${encodeURIComponent("We couldn't save your profile. Please try again.")}`;

function avatarWrites(): DbWrite[] {
  return dbWrites.filter((w) => "avatar_path" in w.payload);
}

beforeEach(() => {
  seed();
  dbWrites = [];
  storageCalls = [];
  serviceClientsCreated = 0;
  authUser = { id: USER_ID };
  tempObjects = { [TEMP_PNG]: REAL_PNG_BYTES, [TEMP_JPG]: REAL_JPEG_BYTES };
  uploadError = null;
  serviceUpdateOverride = null;
  serviceUpdateFails = false;
  sessionUpdateOverride = null;
  sessionUpdateFails = false;
  events = [];
  mockRevalidatePath.mockReset().mockImplementation(() => {
    events.push("revalidate");
  });
  aclMode = "migrated";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
});

// ============================================================
// 1. The modelled ACLs are the real ones.
// ============================================================
describe("the ACLs this suite models come from the real SQL", () => {
  it("before Patch 9 authenticated could UPDATE avatar_path; after it only display_name, bio and public_author_name", () => {
    expect([...PRE_PATCH9_UPDATE].sort()).toEqual(["avatar_path", "bio", "display_name", "public_author_name"]);
    expect([...PATCH9_UPDATE].sort()).toEqual(["bio", "display_name", "public_author_name"]);
  });

  it("schema.sql grants exactly what the migration grants", () => {
    expect(authenticatedProfileUpdateColumns(readFileSync(SCHEMA_PATH, "utf8")).sort()).toEqual([...PATCH9_UPDATE].sort());
  });

  it("the migration rebuilds the profiles ACL from a reset of PUBLIC, anon and authenticated, and names no other table", () => {
    const statements = stripSqlComments(readFileSync(PATCH9_MIGRATION, "utf8"))
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean);
    expect(statements).toEqual([
      "revoke all on public.profiles from public, anon, authenticated",
      "grant select on public.profiles to authenticated",
      "grant update (display_name, bio, public_author_name) on public.profiles to authenticated",
    ]);
  });
});

// ============================================================
// 2. The legitimate flow, under both ACLs (rollout compatibility).
// ============================================================
describe.each<AclMode>(["pre-migration", "migrated"])("legitimate avatar save under the %s ACL", (mode) => {
  beforeEach(() => {
    aclMode = mode;
  });

  it("uploads to the canonical key, writes avatar_path only through the trusted writer, the rest through the session, then removes the temp object", async () => {
    const target = await run({ displayName: "Jane Author", bio: "new bio", publicAuthorName: "J. Author", avatarStoragePath: TEMP_PNG });

    expect(target).toBe("/dashboard/profile?success=1");
    const own = profiles.find((r) => r.id === USER_ID)!;
    expect(own).toMatchObject({
      avatar_path: `${USER_ID}/avatar.png`,
      display_name: "Jane Author",
      bio: "new bio",
      public_author_name: "J. Author",
    });

    // The one avatar_path write: service client, payload avatar_path only,
    // filtered by the session user's id, returning id + avatar_path.
    expect(avatarWrites()).toEqual([
      {
        via: "service",
        payload: { avatar_path: `${USER_ID}/avatar.png` },
        filters: [["id", USER_ID]],
        selected: "id, avatar_path",
        denied: false,
        rowsChanged: 1,
      },
    ]);
    // The one session write: the ordinary fields only, filtered by the
    // session user's id, returning id, and it changed exactly one row.
    const sessionWrites = dbWrites.filter((w) => w.via === "session");
    expect(sessionWrites).toEqual([
      {
        via: "session",
        payload: { display_name: "Jane Author", bio: "new bio", public_author_name: "J. Author" },
        filters: [["id", USER_ID]],
        selected: "id",
        denied: false,
        rowsChanged: 1,
      },
    ]);
    expect(serviceClientsCreated).toBe(1);

    // Success is reported only after both writes proved their row; the
    // temp object is removed only after both writes.
    expect(events).toEqual([
      "storage:session:manuscripts:download",
      "storage:session:avatars:upload",
      "db:service:update",
      "db:session:update",
      "storage:session:manuscripts:remove",
      "revalidate",
    ]);
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");

    expect(storageCalls).toEqual([
      { via: "session", bucket: "manuscripts", op: "download", args: [TEMP_PNG] },
      {
        via: "session",
        bucket: "avatars",
        op: "upload",
        args: [`${USER_ID}/avatar.png`, expect.any(Buffer), { contentType: "image/png", upsert: true }],
      },
      { via: "session", bucket: "manuscripts", op: "remove", args: [[TEMP_PNG]] },
    ]);
    expect(profiles.find((r) => r.id === OTHER_ID)).toMatchObject({ avatar_path: OTHER_AVATAR, display_name: "Victim" });
  });

  it("the extension comes from the verified bytes: a JPEG saves as avatar.jpg", async () => {
    expect(await run({ displayName: "Jane", avatarStoragePath: TEMP_JPG })).toBe("/dashboard/profile?success=1");
    expect(profiles.find((r) => r.id === USER_ID)!.avatar_path).toBe(`${USER_ID}/avatar.jpg`);
    expect(avatarWrites()).toHaveLength(1);
    expect(avatarWrites()[0].via).toBe("service");
  });

  it("a save without a photo stays entirely on the session and never creates the trusted writer", async () => {
    expect(await run({ displayName: "Jane", bio: "b" })).toBe("/dashboard/profile?success=1");
    expect(serviceClientsCreated).toBe(0);
    expect(avatarWrites()).toEqual([]);
    expect(dbWrites).toEqual([
      {
        via: "session",
        payload: { display_name: "Jane", bio: "b" },
        filters: [["id", USER_ID]],
        selected: "id",
        denied: false,
        rowsChanged: 1,
      },
    ]);
    expect(storageCalls).toEqual([]);
    expect(events).toEqual(["db:session:update", "revalidate"]);
  });
});

// ============================================================
// 3. Refusals happen before any privileged authority exists.
// ============================================================
describe("a refused request never creates the trusted writer", () => {
  it("unauthenticated: redirected to /login with no database or Storage call", async () => {
    authUser = null;
    expect(await run({ displayName: "Jane", avatarStoragePath: TEMP_PNG })).toBe("/login");
    expect(serviceClientsCreated).toBe(0);
    expect(dbWrites).toEqual([]);
    expect(storageCalls).toEqual([]);
  });

  it.each([
    ["another user's temp namespace", { avatarStoragePath: `${OTHER_ID}/tmp/avatar/x.png` }],
    ["a path outside tmp/avatar", { avatarStoragePath: `${USER_ID}/avatar.png` }],
    ["an unsupported extension", { avatarStoragePath: `${USER_ID}/tmp/avatar/x.gif` }],
    ["an empty display name", { displayName: "", avatarStoragePath: TEMP_PNG }],
  ])("%s", async (_label, fields) => {
    const before = snapshot();
    const target = await run({ displayName: "Jane", ...fields });
    expect(target).toContain("/dashboard/profile?error=");
    expect(serviceClientsCreated).toBe(0);
    expect(dbWrites).toEqual([]);
    expect(storageCalls.filter((c) => c.op !== "download")).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("bytes that are not a JPEG/PNG", async () => {
    tempObjects[TEMP_PNG] = Buffer.from("not an image at all");
    expect(await run({ displayName: "Jane", avatarStoragePath: TEMP_PNG })).toContain(encodeURIComponent("valid JPEG or PNG"));
    expect(serviceClientsCreated).toBe(0);
    expect(storageCalls.map((c) => c.op)).toEqual(["download"]);
  });

  it("bytes over 5 MB", async () => {
    tempObjects[TEMP_PNG] = Buffer.concat([REAL_PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    expect(await run({ displayName: "Jane", avatarStoragePath: TEMP_PNG })).toContain(encodeURIComponent("5 MB"));
    expect(serviceClientsCreated).toBe(0);
    expect(storageCalls.map((c) => c.op)).toEqual(["download"]);
  });

  it("a failed temp download", async () => {
    delete tempObjects[TEMP_PNG];
    expect(await run({ displayName: "Jane", avatarStoragePath: TEMP_PNG })).toContain("error=");
    expect(serviceClientsCreated).toBe(0);
  });

  it("a failed canonical upload: no writer, no profile change, no removal", async () => {
    uploadError = { message: "upload failed" };
    const before = snapshot();
    expect(await run({ displayName: "Changed", avatarStoragePath: TEMP_PNG })).toContain(encodeURIComponent("couldn't upload"));
    expect(serviceClientsCreated).toBe(0);
    expect(dbWrites).toEqual([]);
    expect(storageCalls.filter((c) => c.op === "remove")).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

// ============================================================
// 4. Identity and path come only from the server.
// ============================================================
describe("hostile FormData cannot choose the identity or the path", () => {
  const HOSTILE = {
    id: OTHER_ID,
    userId: OTHER_ID,
    user_id: OTHER_ID,
    profileId: OTHER_ID,
    avatarPath: OTHER_AVATAR,
    avatar_path: OTHER_AVATAR,
    finalAvatarPath: OTHER_AVATAR,
    avatarBucket: "manuscripts",
    role: "admin",
  };

  it.each<AclMode>(["pre-migration", "migrated"])("under the %s ACL the write targets only the session user's row with the derived path", async (mode) => {
    aclMode = mode;
    expect(await run({ displayName: "Jane", avatarStoragePath: TEMP_PNG, ...HOSTILE })).toBe("/dashboard/profile?success=1");

    expect(avatarWrites()).toHaveLength(1);
    expect(avatarWrites()[0]).toMatchObject({
      via: "service",
      payload: { avatar_path: `${USER_ID}/avatar.png` },
      filters: [["id", USER_ID]],
    });
    expect(storageCalls.find((c) => c.op === "upload")!.args[0]).toBe(`${USER_ID}/avatar.png`);
    expect(storageCalls.find((c) => c.op === "upload")!.bucket).toBe("avatars");
    for (const w of dbWrites) {
      expect(w.payload).not.toHaveProperty("role");
      expect(w.payload).not.toHaveProperty("id");
      expect(w.filters).toEqual([["id", USER_ID]]);
    }
    expect(profiles.find((r) => r.id === OTHER_ID)).toMatchObject({ avatar_path: OTHER_AVATAR, display_name: "Victim", role: "author" });
    expect(profiles.find((r) => r.id === USER_ID)!.role).toBe("author");
  });

  it("a raw avatar File field still goes through the same derivation", async () => {
    const fd = form({ displayName: "Jane", ...HOSTILE });
    fd.set("avatar", new File([new Uint8Array(REAL_PNG_BYTES)], "../../evil.svg", { type: "image/svg+xml" }));
    await expect(updateProfile(fd)).rejects.toMatchObject({ target: "/dashboard/profile?success=1" });
    expect(avatarWrites()).toHaveLength(1);
    expect(avatarWrites()[0]).toMatchObject({ via: "service", payload: { avatar_path: `${USER_ID}/avatar.png` }, filters: [["id", USER_ID]] });
  });
});

// ============================================================
// 5. The trusted write fails closed.
// ============================================================
describe("the trusted avatar_path write fails closed", () => {
  function expectFailedClosed(target: string, before: Row) {
    expect(target).toBe(SAVE_PHOTO_ERROR);
    // Nothing on the profile other than what the trusted write itself did
    // changed: the session write of name/bio/pen name never ran.
    expect(dbWrites.filter((w) => w.via === "session")).toEqual([]);
    const own = profiles.find((r) => r.id === USER_ID)!;
    expect({ display_name: own.display_name, bio: own.bio, public_author_name: own.public_author_name, role: own.role }).toEqual({
      display_name: before.display_name,
      bio: before.bio,
      public_author_name: before.public_author_name,
      role: before.role,
    });
    // No Storage removal of any kind -- the temp object is kept and the
    // canonical key (which may be the photo already shown) is untouched.
    expect(storageCalls.filter((c) => c.op === "remove")).toEqual([]);
    expect(profiles.find((r) => r.id === OTHER_ID)).toMatchObject({ avatar_path: OTHER_AVATAR, display_name: "Victim" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  }

  const cases: [string, () => void][] = [
    ["a database error", () => { serviceUpdateFails = true; }],
    ["zero returned rows", () => { serviceUpdateOverride = () => ({ data: [], error: null }); }],
    ["null data", () => { serviceUpdateOverride = () => ({ data: null, error: null }); }],
    ["two returned rows", () => {
      serviceUpdateOverride = () => ({ data: [{ id: USER_ID, avatar_path: `${USER_ID}/avatar.png` }, { id: USER_ID, avatar_path: `${USER_ID}/avatar.png` }], error: null });
    }],
    ["a mismatched returned id", () => { serviceUpdateOverride = () => ({ data: [{ id: OTHER_ID, avatar_path: `${USER_ID}/avatar.png` }], error: null }); }],
    ["a mismatched returned avatar_path", () => { serviceUpdateOverride = () => ({ data: [{ id: USER_ID, avatar_path: OTHER_AVATAR }], error: null }); }],
    ["a returned row missing avatar_path", () => { serviceUpdateOverride = () => ({ data: [{ id: USER_ID }], error: null }); }],
    ["a non-array response", () => { serviceUpdateOverride = () => ({ data: { id: USER_ID, avatar_path: `${USER_ID}/avatar.png` }, error: null }); }],
    ["an error alongside a plausible row", () => {
      serviceUpdateOverride = () => ({ data: [{ id: USER_ID, avatar_path: `${USER_ID}/avatar.png` }], error: { message: "boom" } });
    }],
  ];

  it.each(cases)("%s", async (_label, arrange) => {
    arrange();
    const before = { ...profiles.find((r) => r.id === USER_ID)! };
    const target = await run({ displayName: "Changed", bio: "changed", publicAuthorName: "Changed Pen", avatarStoragePath: TEMP_PNG });
    expectFailedClosed(target, before);
    expect(console.error).toHaveBeenCalledWith("updateProfile: trusted avatar_path write failed:", expect.anything());
  });

  it("the trusted write is the only avatar write and happens before any other profile write", async () => {
    await run({ displayName: "Jane", avatarStoragePath: TEMP_PNG });
    expect(dbWrites.map((w) => w.via)).toEqual(["service", "session"]);
  });
});

// ============================================================
// 5b. The session metadata write fails closed too, in both branches.
// ============================================================
// display_name, bio and public_author_name stay on the session client and
// are checked with the same exact-row classifier. On any failure the
// action reports a profile-save error -- never success -- and does
// nothing further: no revalidation, no temp removal, no further privileged
// call, no compensating rollback. In the photo branch the trusted
// avatar_path write has ALREADY happened, so the new avatar_path and
// canonical object may stay in place; these tests pin that honestly.
const METADATA_FAILURES: [string, () => void][] = [
  ["a database error", () => { sessionUpdateFails = true; }],
  ["zero returned rows", () => { sessionUpdateOverride = () => ({ data: [], error: null }); }],
  ["null data", () => { sessionUpdateOverride = () => ({ data: null, error: null }); }],
  ["two returned rows", () => { sessionUpdateOverride = () => ({ data: [{ id: USER_ID }, { id: USER_ID }], error: null }); }],
  ["a mismatched returned id", () => { sessionUpdateOverride = () => ({ data: [{ id: OTHER_ID }], error: null }); }],
  ["a returned row missing id", () => { sessionUpdateOverride = () => ({ data: [{}], error: null }); }],
  ["a non-array response", () => { sessionUpdateOverride = () => ({ data: { id: USER_ID }, error: null }); }],
  ["a malformed row (null)", () => { sessionUpdateOverride = () => ({ data: [null], error: null }); }],
  ["an error alongside a plausible own row", () => {
    sessionUpdateOverride = () => ({ data: [{ id: USER_ID }], error: { code: "XX000", message: "boom" } });
  }],
];

const METADATA_FIELDS = { displayName: "Changed Name", bio: "changed bio", publicAuthorName: "Changed Pen" };

function expectStableMetadataDiagnostic() {
  const calls = vi.mocked(console.error).mock.calls.filter((c) => c[0] === "updateProfile: profile details update failed");
  expect(calls).toHaveLength(1);
  const detail = calls[0][1] as Record<string, unknown>;
  expect(Object.keys(detail).sort()).toEqual(["code", "rows"]);
  // No profile value reaches any log line.
  const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
  for (const value of Object.values(METADATA_FIELDS)) expect(logged).not.toContain(value);
}

describe.each<AclMode>(["pre-migration", "migrated"])("a failed metadata write after the trusted avatar write (%s ACL)", (mode) => {
  beforeEach(() => {
    aclMode = mode;
  });

  it.each(METADATA_FAILURES)("%s", async (_label, arrange) => {
    arrange();
    const otherBefore = JSON.stringify(profiles.find((r) => r.id === OTHER_ID));
    const ownBefore = { ...profiles.find((r) => r.id === USER_ID)! };

    const target = await run({ ...METADATA_FIELDS, avatarStoragePath: TEMP_PNG });

    // Failure is reported, never success, and nothing is revalidated.
    expect(target).toBe(SAVE_PROFILE_ERROR);
    expect(target).not.toContain("success");
    expect(mockRevalidatePath).not.toHaveBeenCalled();

    // The trusted avatar_path write had already happened (and is NOT
    // rolled back): the new canonical path may stay on the own row.
    expect(avatarWrites()).toEqual([
      {
        via: "service",
        payload: { avatar_path: `${USER_ID}/avatar.png` },
        filters: [["id", USER_ID]],
        selected: "id, avatar_path",
        denied: false,
        rowsChanged: 1,
      },
    ]);
    expect(profiles.find((r) => r.id === USER_ID)!.avatar_path).toBe(`${USER_ID}/avatar.png`);

    // Exactly one session metadata attempt, on the own row only, then stop:
    // no additional service-role write, no second writer, no Storage
    // removal of any kind (the temp object is kept), no service Storage.
    expect(dbWrites.map((w) => w.via)).toEqual(["service", "session"]);
    expect(dbWrites[1]).toMatchObject({ filters: [["id", USER_ID]], selected: "id", denied: false });
    expect(serviceClientsCreated).toBe(1);
    expect(storageCalls.filter((c) => c.via === "service")).toEqual([]);
    expect(storageCalls.filter((c) => c.op === "remove")).toEqual([]);
    expect(events).toEqual([
      "storage:session:manuscripts:download",
      "storage:session:avatars:upload",
      "db:service:update",
      "db:session:update",
    ]);

    // Nothing else moved: the other user's row is byte-identical and the
    // own row's other columns are untouched.
    expect(JSON.stringify(profiles.find((r) => r.id === OTHER_ID))).toBe(otherBefore);
    const own = profiles.find((r) => r.id === USER_ID)!;
    expect({ role: own.role, stripe_account_id: own.stripe_account_id, id: own.id }).toEqual({
      role: ownBefore.role,
      stripe_account_id: ownBefore.stripe_account_id,
      id: ownBefore.id,
    });
    expectStableMetadataDiagnostic();
  });
});

describe.each<AclMode>(["pre-migration", "migrated"])("a failed metadata write without a photo (%s ACL)", (mode) => {
  beforeEach(() => {
    aclMode = mode;
  });

  it.each(METADATA_FAILURES)("%s", async (_label, arrange) => {
    arrange();
    const otherBefore = JSON.stringify(profiles.find((r) => r.id === OTHER_ID));
    const ownBefore = { ...profiles.find((r) => r.id === USER_ID)! };

    const target = await run(METADATA_FIELDS);

    expect(target).toBe(SAVE_PROFILE_ERROR);
    expect(target).not.toContain("success");
    expect(mockRevalidatePath).not.toHaveBeenCalled();

    // No trusted writer, no Storage operation, exactly one session write.
    expect(serviceClientsCreated).toBe(0);
    expect(storageCalls).toEqual([]);
    expect(dbWrites).toHaveLength(1);
    expect(dbWrites[0]).toMatchObject({
      via: "session",
      payload: { display_name: "Changed Name", bio: "changed bio", public_author_name: "Changed Pen" },
      filters: [["id", USER_ID]],
      selected: "id",
      denied: false,
    });
    expect(events).toEqual(["db:session:update"]);

    // No unrelated mutation.
    expect(JSON.stringify(profiles.find((r) => r.id === OTHER_ID))).toBe(otherBefore);
    const own = profiles.find((r) => r.id === USER_ID)!;
    expect({ role: own.role, avatar_path: own.avatar_path, stripe_account_id: own.stripe_account_id }).toEqual({
      role: ownBefore.role,
      avatar_path: ownBefore.avatar_path,
      stripe_account_id: ownBefore.stripe_account_id,
    });
    expectStableMetadataDiagnostic();
  });
});

// ============================================================
// 6. Structural boundaries of the trusted writer.
// ============================================================
describe("the trusted profile writer's boundary", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it("profile-write-client imports server-only and nothing but the admin factory", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/lib/profile-write-client.ts"), "utf8");
    expect(source).toMatch(/^import "server-only";/);
    expect(source.match(/^import .*$/gm)).toEqual([
      'import "server-only";',
      'import { createAdminClient } from "@/lib/supabase/admin";',
    ]);
  });

  it("only updateProfile's module uses the profile writer, and no client component imports it", () => {
    const files = sourceFiles(path.join(REPO_ROOT, "src"));
    const users = files
      .filter((file) => /from\s+["']@\/lib\/profile-write-client["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(users).toEqual(["src/app/(public)/dashboard/profile/actions.ts"]);
    const clientOffenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return /^\s*["']use client["']/.test(source) && /from\s+["']@\/lib\/(profile-write-client|supabase\/admin)["']/.test(source);
    });
    expect(clientOffenders).toEqual([]);
  });

  it("no application code writes avatar_path through anything but the one trusted update", () => {
    const writers = sourceFiles(path.join(REPO_ROOT, "src")).filter((file) => {
      const source = readFileSync(file, "utf8");
      return /avatar_path\s*:/.test(source) && /\.(update|insert|upsert)\(/.test(source);
    });
    expect(writers.map((file) => path.relative(REPO_ROOT, file))).toEqual(["src/app/(public)/dashboard/profile/actions.ts"]);
    const actions = readFileSync(path.join(REPO_ROOT, "src/app/(public)/dashboard/profile/actions.ts"), "utf8");
    expect(actions.match(/avatar_path\s*:/g)).toHaveLength(1);
  });
});
