// BD5 (W9): the daily clean-up of abandoned temporary uploads.
//
// Every upload form first stages its file in the private "manuscripts"
// bucket under the uploader's own "<uid>/tmp/<kind>/<uuid>.<ext>" key
// (manuscript-field.tsx, cover-field.tsx, avatar-field.tsx,
// blog-cover-field.tsx, docx-actions.ts). Saving the form promotes the
// file to its final key and removes the temporary one; a tab closed
// mid-form leaves it behind for good. This job removes those leftovers.
//
// Renato's answers (1 Nov): 1b -- deletes from the first run, with the
// safety limits below; 2b -- an author has 3 days to press Save; 3a --
// the forms themselves stop a Save after 3 days (temp-upload-expiry.ts).
// The job waits half a day longer than the forms (84 h), so a file a
// form still accepts is never removed under it.
//
// Safety limits (allowlist, never a denylist):
//   * Only keys of the exact shape "<uuid>/tmp/<kind>/<uuid>.<ext>" with
//     a kind and extension listed in TMP_UPLOAD_KINDS. Final book files
//     ("<uid>/<book id>.epub", "<uid>/<book id>/<uuid>.epub") never have
//     "tmp" as their second segment and so are never listed, let alone
//     matched. Anything else found under tmp/ is counted and left alone.
//   * Only objects whose newest timestamp (created or updated -- the
//     Word ebook is rewritten in place when the title changes) is older
//     than TMP_UPLOAD_MIN_AGE_MS. An object with no readable timestamp
//     is left alone.
//   * At most TMP_CLEANUP_MAX_DELETES_PER_RUN removals per run; the rest
//     waits for the next night.
//   * The scan stops after TMP_CLEANUP_SCAN_BUDGET_MS (well inside the
//     route's 60 s limit) and removes what it found so far, so a large
//     bucket never turns every run into a silent timeout (audit r1 F2).
//   * TMP_CLEANUP_OFF (any non-blank value) turns the job into a no-op.
//
// No database table is read or written; only Storage list and remove.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`);

export const TMP_UPLOAD_KINDS = {
  epub: new RegExp(`^${UUID}\\.epub$`),
  preview: new RegExp(`^${UUID}\\.epub$`),
  docx: new RegExp(`^${UUID}\\.docx$`),
  cover: new RegExp(`^${UUID}\\.(?:jpg|png)$`),
  avatar: new RegExp(`^${UUID}\\.(?:jpg|png)$`),
  blog: new RegExp(`^${UUID}\\.(?:jpg|png)$`),
} as const;

export type TmpUploadKind = keyof typeof TMP_UPLOAD_KINDS;
const KIND_NAMES = Object.keys(TMP_UPLOAD_KINDS) as TmpUploadKind[];

const HOUR_MS = 60 * 60 * 1000;
export const TMP_UPLOAD_MIN_AGE_MS = 84 * HOUR_MS;
export const TMP_CLEANUP_MAX_DELETES_PER_RUN = 500;
export const TMP_CLEANUP_BUCKET = "manuscripts";
export const TMP_CLEANUP_OFF_ENV = "TMP_CLEANUP_OFF";

// One listing call returns at most LIST_PAGE_SIZE entries; a folder is
// read for at most LIST_MAX_PAGES pages. A folder bigger than that is
// not walked further this run (reported as capped).
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;
const REMOVE_BATCH_SIZE = 100;
export const TMP_CLEANUP_SCAN_BUDGET_MS = 40 * 1000;

export function isTmpCleanupOff(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

// True only for "<uuid>/tmp/<kind>/<file>" with an allowlisted kind and
// that kind's exact file shape. Checked again on every key right before
// it is handed to remove().
export function isRemovableTmpUploadKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const parts = key.split("/");
  if (parts.length !== 4) return false;
  const [owner, tmp, kind, file] = parts;
  if (!UUID_PATTERN.test(owner) || tmp !== "tmp") return false;
  if (!Object.prototype.hasOwnProperty.call(TMP_UPLOAD_KINDS, kind)) return false;
  return TMP_UPLOAD_KINDS[kind as TmpUploadKind].test(file);
}

export type ListedEntry = {
  name: string;
  id: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: { size?: unknown } | null;
};

export interface TmpCleanupStorage {
  list(prefix: string, offset: number, limit: number): Promise<{ data: ListedEntry[] | null; error: unknown }>;
  remove(keys: string[]): Promise<{ error: unknown }>;
}

export type TmpCleanupSummary = {
  ok: boolean;
  accountsScanned: number;
  found: Record<TmpUploadKind, number>;
  foundBytes: number;
  removed: number;
  tooNew: number;
  leftAlone: number;
  // True when the run stopped early: the removal cap, a folder too big
  // to list in one run, or the scan time budget. The rest waits.
  capped: boolean;
  timeBudgetHit: boolean;
  error?: string;
};

function emptyFound(): Record<TmpUploadKind, number> {
  return { epub: 0, preview: 0, docx: 0, cover: 0, avatar: 0, blog: 0 };
}

function newestTimestampMs(entry: ListedEntry): number | null {
  let newest: number | null = null;
  for (const value of [entry.created_at, entry.updated_at]) {
    if (typeof value !== "string") continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

function sizeOf(entry: ListedEntry): number {
  const size = entry.metadata?.size;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

class ListingError extends Error {}

// Every entry of one folder, page by page. Returns `capped: true` when
// the folder holds more than LIST_MAX_PAGES pages.
async function listAll(
  storage: TmpCleanupStorage,
  prefix: string,
): Promise<{ entries: ListedEntry[]; capped: boolean }> {
  const entries: ListedEntry[] = [];
  for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
    const { data, error } = await storage.list(prefix, page * LIST_PAGE_SIZE, LIST_PAGE_SIZE);
    if (error || !Array.isArray(data)) throw new ListingError("list failed");
    entries.push(...data);
    if (data.length < LIST_PAGE_SIZE) return { entries, capped: false };
  }
  return { entries, capped: true };
}

// A folder in a Storage listing has no object id.
function isFolder(entry: ListedEntry): boolean {
  return entry.id === null || entry.id === undefined;
}

export async function runTmpUploadCleanup(
  storage: TmpCleanupStorage,
  nowMs: number,
  // Milliseconds since the run started; injectable for tests.
  elapsedMs: () => number = (() => {
    const start = Date.now();
    return () => Date.now() - start;
  })(),
): Promise<TmpCleanupSummary> {
  const summary: TmpCleanupSummary = {
    ok: true,
    accountsScanned: 0,
    found: emptyFound(),
    foundBytes: 0,
    removed: 0,
    tooNew: 0,
    leftAlone: 0,
    capped: false,
    timeBudgetHit: false,
  };
  const cutoff = nowMs - TMP_UPLOAD_MIN_AGE_MS;
  const toRemove: string[] = [];

  try {
    const top = await listAll(storage, "");
    if (top.capped) summary.capped = true;

    scan: for (const account of top.entries) {
      if (!isFolder(account) || !UUID_PATTERN.test(account.name)) continue;
      if (elapsedMs() >= TMP_CLEANUP_SCAN_BUDGET_MS) {
        summary.capped = true;
        summary.timeBudgetHit = true;
        break scan;
      }
      summary.accountsScanned += 1;

      const tmp = await listAll(storage, `${account.name}/tmp`);
      if (tmp.capped) summary.capped = true;

      for (const kindEntry of tmp.entries) {
        if (!isFolder(kindEntry) || !KIND_NAMES.includes(kindEntry.name as TmpUploadKind)) {
          summary.leftAlone += 1;
          continue;
        }
        const kind = kindEntry.name as TmpUploadKind;
        const files = await listAll(storage, `${account.name}/tmp/${kind}`);
        if (files.capped) summary.capped = true;

        for (const file of files.entries) {
          const key = `${account.name}/tmp/${kind}/${file.name}`;
          if (isFolder(file) || !isRemovableTmpUploadKey(key)) {
            summary.leftAlone += 1;
            continue;
          }
          const stamp = newestTimestampMs(file);
          if (stamp === null) {
            summary.leftAlone += 1;
            continue;
          }
          if (stamp >= cutoff) {
            summary.tooNew += 1;
            continue;
          }
          if (toRemove.length >= TMP_CLEANUP_MAX_DELETES_PER_RUN) {
            summary.capped = true;
            break scan;
          }
          toRemove.push(key);
          summary.found[kind] += 1;
          summary.foundBytes += sizeOf(file);
        }
      }
    }
  } catch {
    // A failed listing removes nothing at all this run.
    return { ...summary, ok: false, error: "list failed" };
  }

  for (let i = 0; i < toRemove.length; i += REMOVE_BATCH_SIZE) {
    const batch = toRemove.slice(i, i + REMOVE_BATCH_SIZE);
    if (!batch.every(isRemovableTmpUploadKey)) {
      return { ...summary, ok: false, error: "unexpected key" };
    }
    const { error } = await storage.remove(batch);
    if (error) return { ...summary, ok: false, error: "remove failed" };
    summary.removed += batch.length;
  }

  return summary;
}
