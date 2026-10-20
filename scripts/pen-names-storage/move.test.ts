import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  StorageNotFoundError,
  runCopy,
  runDeleteOld,
  runPlan,
  runVerify,
  type AuditEntry,
  type AuditLog,
  type DbPort,
  type KeyRow,
  type StorageEntry,
  type StoragePort,
} from "./core.mts";
import { classifyKey, extensionOf, newKey } from "./keys.mts";
import { AuditLogRefusedError, openAuditLog } from "./audit-log.mts";
import { parseArgs, runCli, UsageError } from "./move.mts";
import { assertTarget } from "./live.mts";
import type { Target } from "./keys.mts";

// PEN-2 (O6): the storage move script against a Storage test double (no
// local Storage exists) and, for the compare-and-set, the local Postgres
// when PEN2_MOVE_PG_TEMPLATE names an expand-state database to copy
// (built from base schema + expand). Never a real project.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const BOOK1 = "10000000-0000-4000-8000-000000000001";
const BOOK2 = "10000000-0000-4000-8000-000000000002";
const BOOK3 = "10000000-0000-4000-8000-000000000003";
const BOOK4 = "10000000-0000-4000-8000-000000000004";
const PEN_A = "c0000000-0000-4000-8000-00000000000a";
const FAKE_SERVICE_KEY = "sb_secret_TESTONLY_never_printed_0123456789";
const NEW_COVER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/cover\.(jpg|png)$/;
const NEW_PHOTO = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/pen-name\.(jpg|png)$/;

// ------------------------------------------------------------
// Storage double: copy, download, list, remove; a definite not-found and
// a transient failure; hooks to run a concurrent change mid-step.
// ------------------------------------------------------------
type Fault = { op: "copy" | "download" | "list" | "remove"; key?: string; kind: "transient" | "notfound"; once?: boolean };

class StorageDouble implements StoragePort {
  objects = new Map<string, Uint8Array>();
  calls: string[] = [];
  faults: Fault[] = [];
  onCopy?: (bucket: string, from: string, to: string) => void | Promise<void>;
  onDownload?: (bucket: string, key: string) => void | Promise<void>;
  // A copy that lands with different bytes (corruption in transit).
  corruptCopies = false;

  put(bucket: string, key: string, text = `bytes of ${bucket}/${key}`) {
    this.objects.set(`${bucket}/${key}`, new TextEncoder().encode(text));
  }
  has(bucket: string, key: string) {
    return this.objects.has(`${bucket}/${key}`);
  }
  private fault(op: Fault["op"], key: string) {
    const at = this.faults.findIndex((f) => f.op === op && (f.key === undefined || f.key === key));
    if (at === -1) return;
    const f = this.faults[at];
    if (f.once) this.faults.splice(at, 1);
    if (f.kind === "notfound") throw new StorageNotFoundError(`${op}: not found`);
    throw new Error(`${op}: storage error (status 503)`);
  }
  async copy(bucket: string, from: string, to: string) {
    this.calls.push(`copy:${bucket}`);
    await this.onCopy?.(bucket, from, to);
    this.fault("copy", from);
    const bytes = this.objects.get(`${bucket}/${from}`);
    if (!bytes) throw new StorageNotFoundError("copy: not found");
    if (this.has(bucket, to)) throw new Error("copy: storage error (status 409)");
    this.objects.set(`${bucket}/${to}`, this.corruptCopies ? new Uint8Array([...bytes, 0]) : bytes);
  }
  async download(bucket: string, key: string) {
    this.calls.push(`download:${bucket}`);
    await this.onDownload?.(bucket, key);
    this.fault("download", key);
    const bytes = this.objects.get(`${bucket}/${key}`);
    if (!bytes) throw new StorageNotFoundError("download: not found");
    return bytes;
  }
  async list(bucket: string, prefix: string): Promise<StorageEntry[]> {
    this.calls.push(`list:${bucket}`);
    this.fault("list", prefix);
    const head = prefix === "" ? `${bucket}/` : `${bucket}/${prefix}/`;
    const entries = new Map<string, boolean>();
    for (const full of this.objects.keys()) {
      if (!full.startsWith(head)) continue;
      const rest = full.slice(head.length);
      const slash = rest.indexOf("/");
      if (slash === -1) entries.set(rest, false);
      else entries.set(rest.slice(0, slash), true);
    }
    return [...entries].map(([name, folder]) => ({ name, folder }));
  }
  async remove(bucket: string, keys: string[]) {
    this.calls.push(`remove:${bucket}`);
    for (const key of keys) this.fault("remove", key);
    for (const key of keys) this.objects.delete(`${bucket}/${key}`);
  }
  writes() {
    return this.calls.filter((c) => c.startsWith("copy:") || c.startsWith("remove:"));
  }
}

// ------------------------------------------------------------
// In-memory DB port (logic tests); the local-Postgres port is below.
// ------------------------------------------------------------
class MemoryDb implements DbPort {
  rows: Record<Target, KeyRow[]> = { cover: [], pen_name_photo: [] };
  profiles: { id: string; key: string | null }[] = [];
  async listRows(target: Target) {
    return this.rows[target].filter((r) => r.key !== null).map((r) => ({ ...r }));
  }
  async cas(target: Target, id: string, prev: string, next: string | null) {
    const row = this.rows[target].find((r) => r.id === id && r.key === prev);
    if (!row) return false;
    if (next === null) this.rows[target] = this.rows[target].filter((r) => r !== row);
    else row.key = next;
    return true;
  }
  async listProfilePhotos() {
    return this.profiles.filter((p) => p.key !== null).map((p) => ({ id: p.id, key: p.key as string }));
  }
  async casProfilePhotoToNull(id: string, prev: string) {
    const p = this.profiles.find((x) => x.id === id && x.key === prev);
    if (!p) return false;
    p.key = null;
    return true;
  }
}

class MemoryLog implements AuditLog {
  entries: AuditEntry[] = [];
  append(entry: AuditEntry) {
    this.entries.push(entry);
  }
}

function deps(db: DbPort, storage: StorageDouble, out: string[]) {
  return { db, storage, out: (line: string) => out.push(line) };
}

describe("keys: shapes and extensions", () => {
  it("classifies the new, the old canonical, the legacy jpeg and unsafe keys", () => {
    expect(classifyKey("cover", "f0000000-0000-4000-8000-000000000001/cover.png", A, BOOK1)).toEqual({ kind: "new" });
    expect(classifyKey("cover", `${A}/${BOOK1}-cover.png`, A, BOOK1)).toEqual({ kind: "old", extension: "png" });
    expect(classifyKey("cover", `${A}/${BOOK1}-cover.JPEG`, A, BOOK1)).toEqual({ kind: "old", extension: "jpg" });
    expect(classifyKey("cover", `${B}/${BOOK1}-cover.png`, A, BOOK1)).toEqual({ kind: "unsafe", extension: "png" });
    expect(classifyKey("cover", `${A}/${BOOK2}-cover.png`, A, BOOK1)).toEqual({ kind: "unsafe", extension: "png" });
    expect(classifyKey("cover", `${A}/../x.gif`, A, BOOK1)).toEqual({ kind: "unsafe", extension: null });
    // A new-shape key in the account's own folder still names the account.
    expect(classifyKey("cover", `${A}/cover.png`, A, BOOK1).kind).toBe("unsafe");
    expect(classifyKey("pen_name_photo", `${A}/avatar.jpg`, A, PEN_A)).toEqual({ kind: "old", extension: "jpg" });
    expect(classifyKey("pen_name_photo", "f0000000-0000-4000-8000-000000000001/pen-name.jpg", A, PEN_A)).toEqual({ kind: "new" });
  });

  it("extension: lowercased, jpeg -> jpg, anything else unknown", () => {
    expect(extensionOf("x/a.JPEG")).toBe("jpg");
    expect(extensionOf("x/a.Png")).toBe("png");
    expect(extensionOf("x/a.webp")).toBeNull();
    expect(newKey("cover", "f0000000-0000-4000-8000-000000000001", "jpg")).toBe("f0000000-0000-4000-8000-000000000001/cover.jpg");
    expect(() => newKey("cover", "../x", "jpg")).toThrow();
  });
});

describe("storage move against the Storage double (in-memory rows)", () => {
  let db: MemoryDb;
  let storage: StorageDouble;
  let out: string[];

  beforeEach(() => {
    db = new MemoryDb();
    storage = new StorageDouble();
    out = [];
    db.rows.cover = [
      { id: BOOK1, accountId: A, key: `${A}/${BOOK1}-cover.png` },
      { id: BOOK2, accountId: A, key: `${A}/${BOOK2}-cover.jpeg` },
      { id: BOOK3, accountId: A, key: `${B}/stray.png` },
      { id: BOOK4, accountId: A, key: `${A}/${BOOK4}-cover.png` },
    ];
    db.rows.pen_name_photo = [{ id: PEN_A, accountId: A, key: `${A}/avatar.png` }];
    db.profiles = [{ id: A, key: `${A}/avatar.png` }];
    storage.put("covers", `${A}/${BOOK1}-cover.png`);
    storage.put("covers", `${A}/${BOOK2}-cover.jpeg`);
    storage.put("covers", `${B}/stray.png`);
    // BOOK4's object is missing.
    storage.put("avatars", `${A}/avatar.png`);
  });

  it("plan is read-only and prints counts only", async () => {
    const before = JSON.stringify(db.rows);
    const counts = await runPlan(deps(db, storage, out));
    expect(counts).toMatchObject({
      covers_old: 3,
      covers_unsafe: 1,
      covers_done: 0,
      photos_old: 1,
      profile_photos: 1,
      missing_sources: 1,
      unknown_extension: 0,
    });
    expect(storage.writes()).toEqual([]);
    expect(JSON.stringify(db.rows)).toBe(before);
    expect(out).toHaveLength(1);
  });

  it("copy: new random keys, .jpeg -> .jpg, unsafe copied from its exact key, missing nulled", async () => {
    const log = new MemoryLog();
    const counts = await runCopy(deps(db, storage, out), log);
    expect(counts).toMatchObject({ repointed: 4, missing_nulled: 1, errors: 0 });
    const [c1, c2, c3] = db.rows.cover;
    expect(c1.key).toMatch(NEW_COVER);
    expect(c1.key.endsWith(".png")).toBe(true);
    expect(c2.key).toMatch(NEW_COVER);
    expect(c2.key.endsWith(".jpg")).toBe(true);
    expect(c3.key).toMatch(NEW_COVER);
    expect(db.rows.cover.find((r) => r.id === BOOK4)).toBeUndefined();
    expect(db.rows.pen_name_photo[0].key).toMatch(NEW_PHOTO);
    for (const r of db.rows.cover) expect(r.key).not.toContain(A);
    // Same bytes under the new key; the old object stays until delete-old.
    expect(storage.objects.get(`covers/${c3.key}`)).toEqual(storage.objects.get(`covers/${B}/stray.png`));
    expect(storage.has("covers", `${A}/${BOOK1}-cover.png`)).toBe(true);
  });

  it("O-c: each mapping line is written before its copy", async () => {
    const log = new MemoryLog();
    storage.onCopy = (_b, from, to) => {
      expect(log.entries.at(-1)).toMatchObject({ event: "planned", old_key: from, new_key: to });
    };
    await runCopy(deps(db, storage, out), log);
    expect(log.entries.filter((e) => e.event === "planned")).toHaveLength(5);
  });

  it("a transient copy error leaves the row unchanged, removes any copy and counts an error", async () => {
    storage.faults.push({ op: "copy", key: `${A}/${BOOK1}-cover.png`, kind: "transient" });
    const counts = await runCopy(deps(db, storage, out), new MemoryLog());
    expect(counts.errors).toBe(1);
    expect(db.rows.cover[0].key).toBe(`${A}/${BOOK1}-cover.png`);
  });

  it("a transient download error, or different bytes, removes the new copy and leaves the row", async () => {
    storage.corruptCopies = true;
    const log = new MemoryLog();
    const counts = await runCopy(deps(db, storage, out), log);
    expect(counts.errors).toBe(4);
    expect(db.rows.cover[0].key).toBe(`${A}/${BOOK1}-cover.png`);
    for (const e of log.entries.filter((x) => x.event === "compare_error_removed")) {
      expect(storage.has(e.table === "books.cover_path" ? "covers" : "avatars", e.new_key as string)).toBe(false);
    }
  });

  it("a re-run is idempotent: nothing left to copy", async () => {
    await runCopy(deps(db, storage, out), new MemoryLog());
    storage.calls = [];
    const again = await runCopy(deps(db, storage, out), new MemoryLog());
    expect(again).toMatchObject({ repointed: 0, already_done: 4, errors: 0 });
    expect(storage.writes()).toEqual([]);
    expect((await runVerify(deps(db, storage, out))).ok).toBe(true);
  });

  it("verify fails while any row is old or any object is missing", async () => {
    expect((await runVerify(deps(db, storage, out))).ok).toBe(false);
  });

  it("delete-old refuses without --contract-applied, and without a passing verify", async () => {
    await expect(runDeleteOld(deps(db, storage, out), { contractApplied: false })).rejects.toThrow(/contract-applied/);
    await expect(runDeleteOld(deps(db, storage, out), { contractApplied: true })).rejects.toThrow(/verify/);
    expect(storage.writes()).toEqual([]);
  });

  it("delete-old removes orphaned old objects, keeps new-shape ones with no row, clears the profile photo", async () => {
    await runCopy(deps(db, storage, out), new MemoryLog());
    const orphanNew = "f0000000-0000-4000-8000-0000000000ff/cover.png";
    storage.put("covers", orphanNew);
    storage.put("covers", `${B}/${BOOK3}-cover.png`); // orphaned old shape, no row
    const counts = await runDeleteOld(deps(db, storage, out), { contractApplied: true });
    expect(storage.has("covers", orphanNew)).toBe(true);
    expect(storage.has("covers", `${B}/${BOOK3}-cover.png`)).toBe(false);
    expect(storage.has("covers", `${A}/${BOOK1}-cover.png`)).toBe(false);
    expect(storage.has("avatars", `${A}/avatar.png`)).toBe(false);
    for (const r of db.rows.cover) expect(storage.has("covers", r.key)).toBe(true);
    expect(db.profiles[0].key).toBeNull();
    expect(counts).toMatchObject({ deleted: 5, profile_photos_nulled: 1, errors: 0 });
    // Idempotent.
    const again = await runDeleteOld(deps(db, storage, out), { contractApplied: true });
    expect(again.deleted).toBe(0);
  });
});

describe("CLI: confirmation, the log file, output", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pen2-move-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function cliDeps(db: DbPort, storage: StorageDouble, out: string[], typed: string) {
    return { ...deps(db, storage, out), ref: "erhzpapqwyfjotliqdjo", repoRoot: REPO_ROOT, ask: async () => typed };
  }

  it("parses modes and requires --log for copy", () => {
    expect(parseArgs([])).toMatchObject({ mode: "plan" });
    expect(parseArgs(["delete-old", "--contract-applied"])).toMatchObject({ mode: "delete-old", contractApplied: true });
    expect(() => parseArgs(["copy"])).toThrow(UsageError);
    expect(() => parseArgs(["nuke"])).toThrow(UsageError);
  });

  it("targets only staging or production, and only the project --project-ref names", () => {
    expect(assertTarget("https://erhzpapqwyfjotliqdjo.supabase.co", "erhzpapqwyfjotliqdjo")).toBe("erhzpapqwyfjotliqdjo");
    expect(() => assertTarget("https://erhzpapqwyfjotliqdjo.supabase.co", undefined)).toThrow();
    expect(() => assertTarget("https://erhzpapqwyfjotliqdjo.supabase.co", "pwkukotgpsegieshulpj")).toThrow();
    expect(() => assertTarget("https://aaaaaaaaaaaaaaaaaaaa.supabase.co", "aaaaaaaaaaaaaaaaaaaa")).toThrow();
  });

  it("a wrong typed confirmation changes nothing", async () => {
    const db = new MemoryDb();
    db.rows.cover = [{ id: BOOK1, accountId: A, key: `${A}/${BOOK1}-cover.png` }];
    const storage = new StorageDouble();
    storage.put("covers", `${A}/${BOOK1}-cover.png`);
    const out: string[] = [];
    const code = await runCli(parseArgs(["copy", `--log=${dir}/m.log`]), cliDeps(db, storage, out, "erhzpapqwyfjotliqdjo"));
    expect(code).toBe(2);
    expect(storage.writes()).toEqual([]);
  });

  it("the mapping file is 0600, each line is on disk before its copy, and only its sha256 is printed", async () => {
    const db = new MemoryDb();
    db.rows.cover = [{ id: BOOK1, accountId: A, key: `${A}/${BOOK1}-cover.png` }];
    const storage = new StorageDouble();
    storage.put("covers", `${A}/${BOOK1}-cover.png`);
    const logPath = `${dir}/mapping.log`;
    storage.onCopy = (_b, _from, to) => {
      expect(readFileSync(logPath, "utf8")).toContain(`"new_key":"${to}"`);
    };
    const out: string[] = [];
    const code = await runCli(parseArgs(["copy", `--log=${logPath}`]), cliDeps(db, storage, out, "erhzpapqwyfjotliqdjo copy"));
    expect(code).toBe(0);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(out.at(-1)).toMatch(/^audit log: lines=2 sha256=[0-9a-f]{64}$/);
  });

  it("refuses a log file inside the repo, in the shared folder, or readable by others", () => {
    expect(() => openAuditLog(path.join(REPO_ROOT, "mapping.log"), REPO_ROOT)).toThrow(AuditLogRefusedError);
    expect(() => openAuditLog("/mnt/project-files/x/mapping.log", REPO_ROOT)).toThrow(AuditLogRefusedError);
    const loose = `${dir}/loose.log`;
    writeFileSync(loose, "");
    chmodSync(loose, 0o644);
    expect(() => openAuditLog(loose, REPO_ROOT)).toThrow(AuditLogRefusedError);
  });

  it("a transient error makes the run exit non-zero", async () => {
    const db = new MemoryDb();
    db.rows.cover = [{ id: BOOK1, accountId: A, key: `${A}/${BOOK1}-cover.png` }];
    const storage = new StorageDouble();
    storage.put("covers", `${A}/${BOOK1}-cover.png`);
    storage.faults.push({ op: "download", kind: "transient" });
    const code = await runCli(parseArgs(["copy", `--log=${dir}/m.log`]), cliDeps(db, storage, [], "erhzpapqwyfjotliqdjo copy"));
    expect(code).toBe(1);
    expect(db.rows.cover[0].key).toBe(`${A}/${BOOK1}-cover.png`);
  });

  it("no output line, log line or console message carries a key, an id or the service key", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_KEY);
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const db = new MemoryDb();
    db.rows.cover = [
      { id: BOOK1, accountId: A, key: `${A}/${BOOK1}-cover.png` },
      { id: BOOK4, accountId: A, key: `${A}/${BOOK4}-cover.png` },
    ];
    db.rows.pen_name_photo = [{ id: PEN_A, accountId: A, key: `${A}/avatar.png` }];
    db.profiles = [{ id: A, key: `${A}/avatar.png` }];
    const storage = new StorageDouble();
    storage.put("covers", `${A}/${BOOK1}-cover.png`);
    storage.put("avatars", `${A}/avatar.png`);
    const out: string[] = [];
    const log = `${dir}/m.log`;
    for (const [args, typed] of [
      [["plan"], ""],
      [["copy", `--log=${log}`], "erhzpapqwyfjotliqdjo copy"],
      [["verify"], ""],
      [["delete-old"], "erhzpapqwyfjotliqdjo delete-old"],
      [["delete-old", "--contract-applied"], "erhzpapqwyfjotliqdjo delete-old"],
    ] as const) {
      await runCli(parseArgs([...args]), cliDeps(db, storage, out, typed));
    }
    const printed = [...out, ...spies.flatMap((s) => s.mock.calls.flat().map(String))].join("\n");
    expect(out.length).toBeGreaterThan(5);
    for (const secret of [A, B, BOOK1, BOOK4, PEN_A, "cover.png", "avatar.png", "pen-name.", FAKE_SERVICE_KEY]) {
      expect(printed).not.toContain(secret);
    }
    expect(printed).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    vi.unstubAllEnvs();
  });
});

// ------------------------------------------------------------
// The compare-and-set against the local Postgres (expand state).
// ------------------------------------------------------------
const TEMPLATE = process.env.PEN2_MOVE_PG_TEMPLATE;

describe.skipIf(!TEMPLATE)("storage move: CAS on the local database (PEN2_MOVE_PG_TEMPLATE)", () => {
  const dbName = `pen2_move_test_${process.pid}`;

  function sql(text: string, vars: Record<string, string> = {}): string {
    const args = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", dbName];
    for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
    return execFileSync("psql", args, { input: text, encoding: "utf8" }).trim();
  }

  const COLUMN: Record<Target, [string, string]> = { cover: ["books", "cover_path"], pen_name_photo: ["pen_names", "avatar_path"] };

  const pgDb: DbPort = {
    async listRows(target) {
      const [table, column] = COLUMN[target];
      const text = sql(`select id || '|' || author_id || '|' || ${column} from public.${table} where ${column} is not null order by id;`);
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, accountId, key] = line.split("|");
          return { id, accountId, key };
        });
    },
    async cas(target, id, prev, next) {
      const [table, column] = COLUMN[target];
      const set = next === null ? "null" : ":'next'";
      const n = sql(
        `with u as (update public.${table} set ${column} = ${set} where id = :'id' and ${column} = :'prev' returning 1) select count(*) from u;`,
        { id, prev, ...(next === null ? {} : { next }) },
      );
      return n === "1";
    },
    async listProfilePhotos() {
      const text = sql(`select id || '|' || avatar_path from public.profiles where avatar_path is not null order by id;`);
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, key] = line.split("|");
          return { id, key };
        });
    },
    async casProfilePhotoToNull(id, prev) {
      const n = sql(
        `with u as (update public.profiles set avatar_path = null where id = :'id' and avatar_path = :'prev' returning 1) select count(*) from u;`,
        { id, prev },
      );
      return n === "1";
    },
  };

  const cover = (book: string) => sql(`select coalesce(cover_path, '<null>') from public.books where id = :'id';`, { id: book });

  let storage: StorageDouble;
  let out: string[];

  beforeAll(() => {
    execFileSync("dropdb", ["--if-exists", dbName]);
    execFileSync("createdb", ["-T", TEMPLATE as string, dbName]);
  });
  afterAll(() => {
    execFileSync("dropdb", ["--if-exists", dbName]);
  });

  beforeEach(() => {
    sql(`
      delete from public.books;
      delete from auth.users where id in (:'a', :'b');
      insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
        (:'a', 'pen2-move-a@test', now(), '{"role":"author","display_name":"Move A"}'),
        (:'b', 'pen2-move-b@test', now(), '{"role":"author","display_name":"Move B"}');
      insert into public.books (id, author_id, title, status, cover_path) values
        (:'b1', :'a', 'M1', 'draft', :'a' || '/' || :'b1' || '-cover.png'),
        (:'b2', :'a', 'M2', 'draft', :'a' || '/' || :'b2' || '-cover.jpeg'),
        (:'b3', :'a', 'M3', 'draft', :'b' || '/stray.png'),
        (:'b4', :'a', 'M4', 'draft', :'a' || '/' || :'b4' || '-cover.png');
      update public.profiles set avatar_path = :'a' || '/avatar.png' where id = :'a';
      update public.pen_names set avatar_path = :'a' || '/avatar.png' where author_id = :'a' and is_default;
    `, { a: A, b: B, b1: BOOK1, b2: BOOK2, b3: BOOK3, b4: BOOK4 });
    storage = new StorageDouble();
    out = [];
    storage.put("covers", `${A}/${BOOK1}-cover.png`);
    storage.put("covers", `${A}/${BOOK2}-cover.jpeg`);
    storage.put("covers", `${B}/stray.png`);
    storage.put("avatars", `${A}/avatar.png`);
  });

  it("repoints old canonical, legacy .jpeg and unsafe keys; nulls the missing one", async () => {
    const counts = await runCopy(deps(pgDb, storage, out), new MemoryLog());
    expect(counts).toMatchObject({ repointed: 4, missing_nulled: 1, errors: 0 });
    expect(cover(BOOK1)).toMatch(NEW_COVER);
    expect(cover(BOOK2)).toMatch(/\.jpg$/);
    expect(cover(BOOK3)).toMatch(NEW_COVER);
    expect(cover(BOOK4)).toBe("<null>");
    expect(sql(`select avatar_path from public.pen_names where author_id = :'a' and is_default;`, { a: A })).toMatch(NEW_PHOTO);
    // The profile keeps its own key until delete-old.
    expect(sql(`select avatar_path from public.profiles where id = :'a';`, { a: A })).toBe(`${A}/avatar.png`);
  });

  it("a concurrent change during the repoint wins; the new copy is removed", async () => {
    const replaced = "f0000000-0000-4000-8000-0000000000a1/cover.png";
    storage.put("covers", replaced);
    storage.onDownload = (_bucket, key) => {
      if (key === `${A}/${BOOK1}-cover.png`) {
        sql(`update public.books set cover_path = :'k' where id = :'id';`, { k: replaced, id: BOOK1 });
      }
    };
    const log = new MemoryLog();
    const counts = await runCopy(deps(pgDb, storage, out), log);
    expect(cover(BOOK1)).toBe(replaced);
    const miss = log.entries.find((e) => e.event === "cas_miss_removed");
    expect(miss?.row_id).toBe(BOOK1);
    expect(storage.has("covers", miss?.new_key as string)).toBe(false);
    expect(counts.cas_miss_removed).toBe(1);
  });

  it("the null path loses to a concurrent replace", async () => {
    const replaced = "f0000000-0000-4000-8000-0000000000a4/cover.png";
    storage.onCopy = (_bucket, from) => {
      if (from === `${A}/${BOOK4}-cover.png`) {
        sql(`update public.books set cover_path = :'k' where id = :'id';`, { k: replaced, id: BOOK4 });
      }
    };
    const counts = await runCopy(deps(pgDb, storage, out), new MemoryLog());
    expect(cover(BOOK4)).toBe(replaced);
    expect(counts).toMatchObject({ missing_lost_race: 1, missing_nulled: 0 });
  });

  it("a transient error leaves the row unchanged; the run exits non-zero; a re-run finishes it", async () => {
    storage.faults.push({ op: "copy", key: `${A}/${BOOK1}-cover.png`, kind: "transient", once: true });
    const dir = mkdtempSync(path.join(tmpdir(), "pen2-move-"));
    try {
      const cli = { ...deps(pgDb, storage, out), ref: "erhzpapqwyfjotliqdjo", repoRoot: REPO_ROOT, ask: async () => "erhzpapqwyfjotliqdjo copy" };
      expect(await runCli(parseArgs(["copy", `--log=${dir}/m.log`]), cli)).toBe(1);
      expect(cover(BOOK1)).toBe(`${A}/${BOOK1}-cover.png`);
      expect(await runCli(parseArgs(["copy", `--log=${dir}/m.log`]), cli)).toBe(0);
      expect(cover(BOOK1)).toMatch(NEW_COVER);
      const third = await runCopy(deps(pgDb, storage, out), new MemoryLog());
      expect(third).toMatchObject({ repointed: 0, already_done: 4, errors: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan reads only", async () => {
    const before = sql(`select string_agg(id || coalesce(cover_path, ''), ',' order by id) from public.books;`);
    await runPlan(deps(pgDb, storage, out));
    expect(sql(`select string_agg(id || coalesce(cover_path, ''), ',' order by id) from public.books;`)).toBe(before);
    expect(storage.writes()).toEqual([]);
  });

  it("delete-old after copy: old objects gone, rows intact, the profile photo cleared", async () => {
    await runCopy(deps(pgDb, storage, out), new MemoryLog());
    storage.put("covers", `${A}/${BOOK3}-cover.png`); // an orphan with no row
    const keep = "f0000000-0000-4000-8000-0000000000ee/cover.png";
    storage.put("covers", keep);
    const counts = await runDeleteOld(deps(pgDb, storage, out), { contractApplied: true });
    expect(counts.errors).toBe(0);
    expect(storage.has("covers", `${A}/${BOOK3}-cover.png`)).toBe(false);
    expect(storage.has("covers", keep)).toBe(true);
    expect(storage.has("covers", cover(BOOK1))).toBe(true);
    expect(sql(`select coalesce(avatar_path, '<null>') from public.profiles where id = :'a';`, { a: A })).toBe("<null>");
  });
});

describe("runtime smoke: the script loads under node --experimental-strip-types", () => {
  it("imports move.mts, core.mts, live.mts with no CLI run and no credentials", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PEN_NAMES_STORAGE_SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    const probe = [
      "for (const t of ['./scripts/pen-names-storage/move.mts', './scripts/pen-names-storage/core.mts', './scripts/pen-names-storage/live.mts']) {",
      "  await import(t);",
      "}",
      "console.log('SMOKE_OK');",
    ].join("\n");
    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", probe], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(stdout.trim().split("\n").at(-1)).toBe("SMOKE_OK");
  });
});
