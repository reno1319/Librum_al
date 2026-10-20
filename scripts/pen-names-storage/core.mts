// PEN-2: the pen-names storage move (rollout step 3) and old-file deletion
// (step 5). See move.mts for the CLI and the run rules, and keys.mts for
// the key shapes.
//
// Everything here works through two ports, so the same code runs against
// the live project (live.mts: supabase-js with the service role) and in
// tests (a Storage double and the local Postgres for the CAS).
//
// Output rule: counts only. No key, row id or account id is ever passed
// to `out`. Keys and row ids go only to the audit log, a local 0600 file.

import { createHash, randomUUID } from "node:crypto";
import {
  AVATARS_BUCKET,
  COVERS_BUCKET,
  bucketOf,
  classifyKey,
  isNewShapeObject,
  newKey,
  type Target,
} from "./keys.mts";

// A definite "this object does not exist" from Storage. Any other error
// is treated as transient (MF6).
export class StorageNotFoundError extends Error {}

export type StorageEntry = { name: string; folder: boolean };

export type StoragePort = {
  copy(bucket: string, from: string, to: string): Promise<void>;
  download(bucket: string, key: string): Promise<Uint8Array>;
  // Every entry directly under `prefix` ("" = bucket root); the port pages.
  list(bucket: string, prefix: string): Promise<StorageEntry[]>;
  remove(bucket: string, keys: string[]): Promise<void>;
};

export type KeyRow = { id: string; accountId: string; key: string };

export type DbPort = {
  // Rows whose key is not null: books.cover_path or pen_names.avatar_path.
  listRows(target: Target): Promise<KeyRow[]>;
  // update ... set <col> = :next where id = :id and <col> = :prev. True
  // when exactly one row changed.
  cas(target: Target, id: string, prev: string, next: string | null): Promise<boolean>;
  listProfilePhotos(): Promise<{ id: string; key: string }[]>;
  casProfilePhotoToNull(id: string, prev: string): Promise<boolean>;
};

export type AuditEntry = {
  event: string;
  table: string;
  row_id: string | null;
  old_key: string | null;
  new_key: string | null;
};

// append() writes one line and fsyncs before it returns.
export type AuditLog = { append(entry: AuditEntry): void };

export type Deps = {
  db: DbPort;
  storage: StoragePort;
  out: (line: string) => void;
  uuid?: () => string;
};

const TABLE: Record<Target, string> = { cover: "books.cover_path", pen_name_photo: "pen_names.avatar_path" };
const TARGETS: Target[] = ["cover", "pen_name_photo"];

function splitKey(key: string): { folder: string; name: string } {
  const at = key.lastIndexOf("/");
  return at === -1 ? { folder: "", name: key } : { folder: key.slice(0, at), name: key.slice(at + 1) };
}

// Existence by listing the key's folder: read-only and cheap. Throws on a
// transient Storage error (the caller counts it).
function existenceChecker(storage: StoragePort) {
  const folders = new Map<string, Promise<Set<string>>>();
  return async (bucket: string, key: string): Promise<boolean> => {
    const { folder, name } = splitKey(key);
    const cacheKey = `${bucket}\u0000${folder}`;
    let names = folders.get(cacheKey);
    if (!names) {
      names = storage
        .list(bucket, folder)
        .then((entries) => new Set(entries.filter((e) => !e.folder).map((e) => e.name)));
      folders.set(cacheKey, names);
    }
    return (await names).has(name);
  };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// ------------------------------------------------------------
// plan (read-only)
// ------------------------------------------------------------
export type PlanCounts = {
  covers_old: number;
  covers_unsafe: number;
  covers_done: number;
  photos_old: number;
  photos_unsafe: number;
  photos_done: number;
  profile_photos: number;
  unknown_extension: number;
  missing_sources: number;
  storage_errors: number;
};

export async function runPlan(deps: Deps): Promise<PlanCounts> {
  const exists = existenceChecker(deps.storage);
  const counts: PlanCounts = {
    covers_old: 0,
    covers_unsafe: 0,
    covers_done: 0,
    photos_old: 0,
    photos_unsafe: 0,
    photos_done: 0,
    profile_photos: 0,
    unknown_extension: 0,
    missing_sources: 0,
    storage_errors: 0,
  };
  for (const target of TARGETS) {
    const isCover = target === "cover";
    for (const row of await deps.db.listRows(target)) {
      const cls = classifyKey(target, row.key, row.accountId, row.id);
      if (cls.kind === "new") {
        if (isCover) counts.covers_done += 1;
        else counts.photos_done += 1;
        continue;
      }
      if (cls.kind === "old") {
        if (isCover) counts.covers_old += 1;
        else counts.photos_old += 1;
      } else if (isCover) counts.covers_unsafe += 1;
      else counts.photos_unsafe += 1;
      if (cls.extension === null) counts.unknown_extension += 1;
      try {
        if (!(await exists(bucketOf(target), row.key))) counts.missing_sources += 1;
      } catch {
        counts.storage_errors += 1;
      }
    }
  }
  counts.profile_photos = (await deps.db.listProfilePhotos()).length;
  deps.out(
    `plan: covers old=${counts.covers_old} unsafe=${counts.covers_unsafe} done=${counts.covers_done}; ` +
      `pen name photos old=${counts.photos_old} unsafe=${counts.photos_unsafe} done=${counts.photos_done}; ` +
      `legacy profile photos=${counts.profile_photos}; unknown extension=${counts.unknown_extension}; ` +
      `missing source objects=${counts.missing_sources}; storage errors=${counts.storage_errors}`,
  );
  return counts;
}

// ------------------------------------------------------------
// copy
// ------------------------------------------------------------
export type CopyCounts = {
  repointed: number;
  already_done: number;
  missing_nulled: number;
  missing_lost_race: number;
  cas_miss_removed: number;
  errors: number;
};

export async function runCopy(deps: Deps, log: AuditLog): Promise<CopyCounts> {
  const uuid = deps.uuid ?? randomUUID;
  const counts: CopyCounts = {
    repointed: 0,
    already_done: 0,
    missing_nulled: 0,
    missing_lost_race: 0,
    cas_miss_removed: 0,
    errors: 0,
  };

  const removeQuietly = async (bucket: string, key: string): Promise<boolean> => {
    try {
      await deps.storage.remove(bucket, [key]);
      return true;
    } catch {
      return false;
    }
  };

  for (const target of TARGETS) {
    const table = TABLE[target];
    const bucket = bucketOf(target);
    for (const row of await deps.db.listRows(target)) {
      const cls = classifyKey(target, row.key, row.accountId, row.id);
      if (cls.kind === "new") {
        counts.already_done += 1;
        continue;
      }
      if (cls.extension === null) {
        // No new key can be named; the operator decides (row unchanged).
        log.append({ event: "unknown_extension", table, row_id: row.id, old_key: row.key, new_key: null });
        counts.errors += 1;
        continue;
      }

      // O-c: make the key, write and fsync the line, then copy.
      const next = newKey(target, uuid(), cls.extension);
      log.append({ event: "planned", table, row_id: row.id, old_key: row.key, new_key: next });

      try {
        await deps.storage.copy(bucket, row.key, next);
      } catch (error) {
        if (error instanceof StorageNotFoundError) {
          // MF6: a definite not-found only. Null the row with a CAS, so a
          // concurrent replace wins.
          let hit = false;
          try {
            hit = await deps.db.cas(target, row.id, row.key, null);
          } catch {
            log.append({ event: "missing_db_error", table, row_id: row.id, old_key: row.key, new_key: null });
            counts.errors += 1;
            continue;
          }
          log.append({ event: hit ? "missing_nulled" : "missing_lost_race", table, row_id: row.id, old_key: row.key, new_key: null });
          if (hit) counts.missing_nulled += 1;
          else counts.missing_lost_race += 1;
          continue;
        }
        const removed = await removeQuietly(bucket, next);
        log.append({ event: removed ? "copy_error_removed" : "copy_error", table, row_id: row.id, old_key: row.key, new_key: next });
        counts.errors += 1;
        continue;
      }

      // Download both and compare size and sha256.
      let same = false;
      try {
        const [before, after] = await Promise.all([
          deps.storage.download(bucket, row.key),
          deps.storage.download(bucket, next),
        ]);
        same = before.byteLength === after.byteLength && sha256(before) === sha256(after);
      } catch {
        same = false;
      }
      if (!same) {
        const removed = await removeQuietly(bucket, next);
        log.append({ event: removed ? "compare_error_removed" : "compare_error", table, row_id: row.id, old_key: row.key, new_key: next });
        counts.errors += 1;
        continue;
      }

      let hit = false;
      try {
        hit = await deps.db.cas(target, row.id, row.key, next);
      } catch {
        const removed = await removeQuietly(bucket, next);
        log.append({ event: removed ? "db_error_removed" : "db_error", table, row_id: row.id, old_key: row.key, new_key: next });
        counts.errors += 1;
        continue;
      }
      if (hit) {
        log.append({ event: "repointed", table, row_id: row.id, old_key: row.key, new_key: next });
        counts.repointed += 1;
      } else {
        // The author changed it meanwhile: their value stands.
        const removed = await removeQuietly(bucket, next);
        log.append({ event: removed ? "cas_miss_removed" : "cas_miss", table, row_id: row.id, old_key: row.key, new_key: next });
        if (removed) counts.cas_miss_removed += 1;
        else counts.errors += 1;
      }
    }
  }

  deps.out(
    `copy: repointed=${counts.repointed} already done=${counts.already_done} ` +
      `missing nulled=${counts.missing_nulled} missing lost race=${counts.missing_lost_race} ` +
      `changed meanwhile (copy removed)=${counts.cas_miss_removed} errors=${counts.errors}`,
  );
  return counts;
}

// ------------------------------------------------------------
// verify (read-only). Owner is checked in SQL (C0, MF-B), not here.
// ------------------------------------------------------------
export type VerifyCounts = { rows: number; not_new: number; missing: number; storage_errors: number };

export async function runVerify(deps: Deps): Promise<{ ok: boolean; counts: VerifyCounts }> {
  const exists = existenceChecker(deps.storage);
  const counts: VerifyCounts = { rows: 0, not_new: 0, missing: 0, storage_errors: 0 };
  for (const target of TARGETS) {
    for (const row of await deps.db.listRows(target)) {
      counts.rows += 1;
      if (classifyKey(target, row.key, row.accountId, row.id).kind !== "new") counts.not_new += 1;
      try {
        if (!(await exists(bucketOf(target), row.key))) counts.missing += 1;
      } catch {
        counts.storage_errors += 1;
      }
    }
  }
  const ok = counts.not_new === 0 && counts.missing === 0 && counts.storage_errors === 0;
  deps.out(
    `verify: ${ok ? "PASS" : "FAIL"} rows=${counts.rows} not in new shape=${counts.not_new} ` +
      `missing objects=${counts.missing} storage errors=${counts.storage_errors}`,
  );
  return { ok, counts };
}

// ------------------------------------------------------------
// delete-old (MF5; 19a/20a)
// ------------------------------------------------------------
export class DeleteOldRefusedError extends Error {}

export type DeleteOldCounts = {
  listed: number;
  kept_new: number;
  kept_referenced: number;
  deleted: number;
  profile_photos_nulled: number;
  errors: number;
};

async function walk(storage: StoragePort, bucket: string, prefix: string, depth: number): Promise<string[]> {
  if (depth > 8) throw new Error("delete-old: folder nesting deeper than expected");
  const out: string[] = [];
  for (const entry of await storage.list(bucket, prefix)) {
    const full = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.folder) out.push(...(await walk(storage, bucket, full, depth + 1)));
    else out.push(full);
  }
  return out;
}

export async function runDeleteOld(
  deps: Deps,
  options: { contractApplied: boolean },
  log?: AuditLog,
): Promise<DeleteOldCounts> {
  if (!options.contractApplied) {
    throw new DeleteOldRefusedError(
      "delete-old refused: pass --contract-applied only after the contract run plan's postcheck",
    );
  }
  const { ok } = await runVerify(deps);
  if (!ok) throw new DeleteOldRefusedError("delete-old refused: verify did not pass");

  const counts: DeleteOldCounts = {
    listed: 0,
    kept_new: 0,
    kept_referenced: 0,
    deleted: 0,
    profile_photos_nulled: 0,
    errors: 0,
  };

  const referenced: Record<string, Set<string>> = {
    [COVERS_BUCKET]: new Set((await deps.db.listRows("cover")).map((r) => r.key)),
    [AVATARS_BUCKET]: new Set((await deps.db.listRows("pen_name_photo")).map((r) => r.key)),
  };
  const removedAvatars = new Set<string>();

  for (const bucket of [COVERS_BUCKET, AVATARS_BUCKET]) {
    const names = await walk(deps.storage, bucket, "", 0);
    const doomed: string[] = [];
    for (const name of names) {
      counts.listed += 1;
      if (isNewShapeObject(bucket, name)) counts.kept_new += 1;
      else if (referenced[bucket].has(name)) counts.kept_referenced += 1;
      else doomed.push(name);
    }
    for (let i = 0; i < doomed.length; i += 100) {
      const batch = doomed.slice(i, i + 100);
      try {
        await deps.storage.remove(bucket, batch);
        counts.deleted += batch.length;
        for (const name of batch) {
          log?.append({ event: "deleted", table: bucket, row_id: null, old_key: name, new_key: null });
          if (bucket === AVATARS_BUCKET) removedAvatars.add(name);
        }
      } catch {
        counts.errors += batch.length;
      }
    }
  }

  // 20a/O15: a profile photo whose object was removed is cleared.
  for (const profile of await deps.db.listProfilePhotos()) {
    if (!removedAvatars.has(profile.key)) continue;
    try {
      if (await deps.db.casProfilePhotoToNull(profile.id, profile.key)) counts.profile_photos_nulled += 1;
    } catch {
      counts.errors += 1;
    }
  }

  deps.out(
    `delete-old: listed=${counts.listed} kept new-shape=${counts.kept_new} kept referenced=${counts.kept_referenced} ` +
      `deleted=${counts.deleted} profile photos cleared=${counts.profile_photos_nulled} errors=${counts.errors}`,
  );
  return counts;
}
