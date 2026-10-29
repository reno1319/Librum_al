import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AVATAR-STORAGE-PATH-AUTH-1 (Patch 9), revised by PEN-NAMES-1 r4 (owner
// decision 18a): Dashboard > Profile no longer edits a photo or a bio, so
// updateProfile writes NO avatar_path and NO bio at all -- only
// display_name and (for an author) public_author_name, on the session
// client -- and never touches Storage or the service role. The trusted
// profile writer (src/lib/profile-write-client.ts) is gone; nothing in
// the application writes profiles.avatar_path any more.
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

const SAVE_PROFILE_ERROR = `/dashboard/profile?error=${encodeURIComponent("Profili nuk u ruajt dot. Provoni përsëri.")}`;

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

  // PEN-NAMES-2 (E3, migration 20261019222500): bio left the grant too
  // (a pen name's bio lives on pen_names), so schema.sql grants the Patch 9
  // columns minus bio.
  it("schema.sql grants exactly what the migrations grant (Patch 9, then E3 drops bio)", () => {
    expect(authenticatedProfileUpdateColumns(readFileSync(SCHEMA_PATH, "utf8")).sort()).toEqual(
      [...PATCH9_UPDATE].filter((c) => c !== "bio").sort(),
    );
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
// 2. PEN-NAMES-1 r4 (18a): updateProfile writes no photo and no bio.
// ============================================================
describe.each<AclMode>(["pre-migration", "migrated"])("updateProfile under the %s ACL", (mode) => {
  beforeEach(() => {
    aclMode = mode;
  });

  it("saves display_name and public_author_name on the session, alone, filtered by the caller's id", async () => {
    expect(await run({ displayName: "Jane B", publicAuthorName: "J. Pen" })).toBe("/dashboard/profile?success=1");
    expect(dbWrites).toHaveLength(1);
    expect(dbWrites[0]).toMatchObject({
      via: "session",
      payload: { display_name: "Jane B", public_author_name: "J. Pen" },
      filters: [["id", USER_ID]],
      denied: false,
      rowsChanged: 1,
    });
    expect(serviceClientsCreated).toBe(0);
    expect(storageCalls).toEqual([]);
  });

  it("a photo reference, a raw avatar File or a bio in the request is ignored: no Storage call, no avatar_path or bio write", async () => {
    const fd = form({ displayName: "Jane", publicAuthorName: "J. Pen", avatarStoragePath: TEMP_PNG, bio: "new bio" });
    fd.set("avatar", new File([new Uint8Array(REAL_PNG_BYTES)], "a.png", { type: "image/png" }));
    let target = "";
    try {
      await updateProfile(fd);
    } catch (error) {
      if (error instanceof RedirectSignal) target = error.target;
      else throw error;
    }
    expect(target).toBe("/dashboard/profile?success=1");
    expect(storageCalls).toEqual([]);
    expect(serviceClientsCreated).toBe(0);
    expect(avatarWrites()).toEqual([]);
    expect(dbWrites.every((w) => !("bio" in w.payload))).toBe(true);
    const own = profiles.find((r) => r.id === USER_ID)!;
    expect(own.bio).toBe("old bio");
    expect(own.avatar_path).toBeNull();
  });

  it("another user's row, bio and avatar are never touched", async () => {
    const before = JSON.stringify(profiles.find((r) => r.id === OTHER_ID));
    await run({ displayName: "Jane", id: OTHER_ID, avatar_path: OTHER_AVATAR, avatarStoragePath: `${OTHER_ID}/tmp/avatar/x.png` });
    expect(JSON.stringify(profiles.find((r) => r.id === OTHER_ID))).toBe(before);
    expect(storageCalls).toEqual([]);
  });
});

describe("updateProfile fails closed", () => {
  it("unauthenticated: redirected to /login with no database or Storage call", async () => {
    authUser = null;
    const before = snapshot();
    expect(await run({ displayName: "Jane" })).toBe("/login");
    expect(dbWrites).toEqual([]);
    expect(storageCalls).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("a failed session write, or a result that is not exactly the caller's row, is a failed save without revalidation", async () => {
    sessionUpdateFails = true;
    expect(await run({ displayName: "Jane" })).toBe(SAVE_PROFILE_ERROR);
    sessionUpdateFails = false;
    sessionUpdateOverride = () => ({ data: [], error: null });
    expect(await run({ displayName: "Jane" })).toBe(SAVE_PROFILE_ERROR);
    sessionUpdateOverride = () => ({ data: [{ id: OTHER_ID }], error: null });
    expect(await run({ displayName: "Jane" })).toBe(SAVE_PROFILE_ERROR);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

// ============================================================
// 3. Structural: nothing in the application writes profiles.avatar_path.
// ============================================================
describe("no profile photo writer remains", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it("the trusted profile writer module is gone and nothing imports it", () => {
    const files = sourceFiles(path.join(REPO_ROOT, "src"));
    expect(files.some((file) => file.endsWith("src/lib/profile-write-client.ts"))).toBe(false);
    expect(files.filter((file) => /profile-write-client/.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  // PEN-2 (17a after C8): becomeAuthor also sets the default pen name's
  // photo (a server-side copy of the legacy account photo), through the
  // same pen name writer; still no profile photo writer.
  it("the only avatar_path writes in the application are pen name photos, through the pen name writer", () => {
    const writers = sourceFiles(path.join(REPO_ROOT, "src")).filter((file) => {
      const source = readFileSync(file, "utf8");
      return /avatar_path\s*:/.test(source) && /\.(update|insert|upsert)\(/.test(source);
    });
    expect(writers.map((file) => path.relative(REPO_ROOT, file))).toEqual([
      "src/app/(public)/account/become-author.ts",
      "src/app/(public)/dashboard/pen-names/actions.ts",
    ]);
    const becomeAuthor = readFileSync(path.join(REPO_ROOT, "src/app/(public)/account/become-author.ts"), "utf8");
    expect(becomeAuthor).toMatch(/createPenNameWriteClient\(\)/);
    expect(becomeAuthor.match(/\.update\(\{[^}]*avatar_path/g)).toEqual([".update({ avatar_path"]);
    expect(becomeAuthor).toMatch(/\.from\("pen_names"\)\s*\.update\(\{ avatar_path: newPath \}\)/);
    expect(becomeAuthor).not.toMatch(/\.from\("profiles"\)\s*\.update\(\{[^}]*avatar_path/);
    const penNameActions = readFileSync(path.join(REPO_ROOT, "src/app/(public)/dashboard/pen-names/actions.ts"), "utf8");
    expect(penNameActions.match(/\.(update|insert|upsert)\(\{[^}]*avatar_path/g)).toHaveLength(1);
    expect(penNameActions).toMatch(/\.from\("pen_names"\)\s*\.update\(\{ avatar_path: newPhotoPath \}\)/);
    const profileActions = readFileSync(path.join(REPO_ROOT, "src/app/(public)/dashboard/profile/actions.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
    expect(profileActions).not.toMatch(/avatar_path\s*:/);
    expect(profileActions).not.toMatch(/\bbio\s*[:,]/);
    expect(profileActions).not.toMatch(/\.storage\b/);
  });
});
