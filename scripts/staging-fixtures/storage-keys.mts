// PHASE-1C: deterministic, exact-key-only Storage discovery and cleanup
// planning. Pure logic, dependency-injected listing -- no
// @supabase/supabase-js import here (the real StorageFileApi is wired
// in by live-deps.mts). Signature shapes were traced directly from the
// installed @supabase/storage-js source
// (node_modules/@supabase/storage-js/src/packages/StorageFileApi.ts,
// src/lib/types.ts): `list(path?, { limit, offset, ... })` defaults to
// limit 100; a returned FileObject has `id: null` and `metadata: null`
// for a FOLDER, and a real `id` + `metadata.size` for a FILE -- this is
// the authoritative, source-confirmed way to tell them apart (there is
// no separate "type" field).
import {
  FIXTURE_BOOKS,
  fixtureCoverPath,
  fixtureManuscriptPath,
} from "./manifest.mts";

export const FIXTURE_STORAGE_BUCKETS = ["covers", "manuscripts", "avatars"] as const;
export type FixtureStorageBucket = (typeof FIXTURE_STORAGE_BUCKETS)[number];

// The 10 baseline keys (5 books x cover+manuscript).
export function expectedBaselineObjectKeys(authorId: string): readonly { bucket: "covers" | "manuscripts"; key: string }[] {
  const keys: { bucket: "covers" | "manuscripts"; key: string }[] = [];
  for (const book of FIXTURE_BOOKS) {
    keys.push({ bucket: "covers", key: fixtureCoverPath(authorId, book.id) });
    keys.push({ bucket: "manuscripts", key: fixtureManuscriptPath(authorId, book.id) });
  }
  return keys;
}

// "assert every key begins with exactly the expected validated UUID
// plus '/'." Never a "contains" or generic "fixtures/" prefix check --
// the namespace IS the resolved, marker-verified fixture author's own
// UUID. Also rejects any "." or ".." path segment anywhere in the key:
// a literal string-prefix check alone would incorrectly accept a
// storage-API-reported name like "../../some-other-author/evil.png"
// (it DOES start with "<id>/" as a string, even though it doesn't stay
// under that namespace) -- segment-by-segment validation closes that.
export function isWithinFixtureNamespace(objectKey: string, fixtureAuthorId: string): boolean {
  const requiredPrefix = `${fixtureAuthorId}/`;
  if (!objectKey.startsWith(requiredPrefix) || objectKey.length <= requiredPrefix.length) {
    return false;
  }
  const segments = objectKey.split("/");
  return segments.every((segment) => segment !== "." && segment !== "..");
}

export function toFullObjectKey(scopedListPath: string, relativeName: string): string {
  return `${scopedListPath}/${relativeName}`;
}

// ============================================================
// PHASE-1C mandatory correction, item 7: recursive, bounded, folder-
// aware Storage discovery. Supabase's list() returns both files and
// folders in the same response; the application itself nests temporary
// uploads under the fixture author's own namespace at
// `<id>/tmp/cover/`, `<id>/tmp/epub/`, `<id>/tmp/docx/`, and
// `<id>/tmp/avatar/` (confirmed directly against
// src/app/(public)/dashboard/books/actions.ts:349,253,
// src/app/(public)/dashboard/books/docx-actions.ts:193,
// src/components/avatar-field.tsx:149, and each of those call sites'
// own *.test.ts) -- a flat, single-level `list()` call would silently
// miss every one of those, leaving orphaned temp objects behind after
// reset/teardown. This walk finds them by recursing into every folder
// entry it encounters, not by hard-coding those four names.
// ============================================================

export type RawStorageEntry = {
  name: string;
  // null for a folder -- the authoritative signal (FileObject.id,
  // storage-js source). A real file always has a non-null id.
  id: string | null;
  metadata: { size: number } | null;
};

export type ListEntriesFn = (
  path: string,
  options: { limit: number; offset: number },
) => Promise<RawStorageEntry[]>;

export type DiscoveredStorageObject = { fullKey: string; sizeBytes: number };

export class MalformedStorageEntryError extends Error {}

function isFolderEntry(entry: RawStorageEntry): boolean {
  return entry.id === null;
}

// Every entry must be unambiguously a folder (id === null AND
// metadata === null) or unambiguously a file (id !== null AND
// metadata !== null, with a numeric size) -- anything else (a file id
// with null metadata, or vice versa) is a malformed/unexpected shape
// this design refuses to guess about.
function validateEntryShape(entry: RawStorageEntry): void {
  const looksLikeFolder = entry.id === null;
  const looksLikeFile = entry.metadata !== null && typeof entry.metadata.size === "number";
  if (looksLikeFolder && entry.metadata !== null) {
    throw new MalformedStorageEntryError(
      `Storage entry "${entry.name}" has id === null (folder shape) but non-null metadata -- ` +
        "refusing to guess whether this is a file or a folder.",
    );
  }
  if (!looksLikeFolder && !looksLikeFile) {
    throw new MalformedStorageEntryError(
      `Storage entry "${entry.name}" has a non-null id but missing/invalid metadata.size -- ` +
        "refusing to treat this as a file without a known byte size.",
    );
  }
}

async function listAllEntriesAtPath(
  listEntries: ListEntriesFn,
  path: string,
  pageSize: number,
): Promise<RawStorageEntry[]> {
  const entries: RawStorageEntry[] = [];
  let offset = 0;
  const MAX_PAGES = 1000;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await listEntries(path, { limit: pageSize, offset });
    entries.push(...page);
    if (page.length < pageSize) return entries;
    offset += pageSize;
  }
  throw new Error(
    `listAllEntriesAtPath: exceeded ${MAX_PAGES} pages listing "${path}" -- refusing to loop further.`,
  );
}

// Recursively walks every folder under `rootPath`, bounded by
// `maxDepth` (default 8 -- far deeper than the application's own
// known 2-level tmp/<kind>/ nesting, generous headroom without being
// unbounded). Every discovered FILE is validated against the exact
// fixture-author namespace before being returned; folders are never
// returned and never passed to remove().
export async function discoverStorageObjects(params: {
  listEntries: ListEntriesFn;
  fixtureAuthorId: string;
  pageSize?: number;
  maxDepth?: number;
}): Promise<DiscoveredStorageObject[]> {
  const pageSize = params.pageSize ?? 100;
  const maxDepth = params.maxDepth ?? 8;
  const results: DiscoveredStorageObject[] = [];

  async function walk(path: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      throw new Error(
        `discoverStorageObjects: exceeded max recursion depth (${maxDepth}) under "${path}" -- ` +
          "refusing to recurse further (this should never happen for the application's own known " +
          "2-level tmp/<kind>/ nesting; treat this as a signal to investigate, not to raise the limit blindly).",
      );
    }
    const entries = await listAllEntriesAtPath(params.listEntries, path, pageSize);
    for (const entry of entries) {
      validateEntryShape(entry);
      const fullKey = toFullObjectKey(path, entry.name);
      if (isFolderEntry(entry)) {
        await walk(fullKey, depth + 1);
        continue;
      }
      if (!isWithinFixtureNamespace(fullKey, params.fixtureAuthorId)) {
        throw new MalformedStorageEntryError(
          `Discovered file "${fullKey}" does not begin with the exact validated namespace ` +
            `"${params.fixtureAuthorId}/". Refusing to include it in any deletion plan.`,
        );
      }
      results.push({ fullKey, sizeBytes: entry.metadata!.size });
    }
  }

  await walk(params.fixtureAuthorId, 0);
  return results;
}

export type StorageCleanupPlanEntry = { bucket: FixtureStorageBucket; key: string };

export class UnexpectedStorageKeyError extends Error {}

// Combines the known baseline keys with whatever else was actually
// discovered (via discoverStorageObjects above) under the fixture
// author's own namespace in each fixture-owned bucket -- including
// nested tmp/ objects. `discoveredByBucket` must already contain FULL,
// pre-validated object keys (DiscoveredStorageObject.fullKey) -- every
// key is re-validated here anyway, independently, so a coding mistake
// upstream still fails closed rather than silently expanding scope.
export function planStorageCleanup(params: {
  fixtureAuthorId: string;
  discoveredByBucket: Record<FixtureStorageBucket, string[]>;
}): StorageCleanupPlanEntry[] {
  const plan: StorageCleanupPlanEntry[] = [];
  const seen = new Set<string>();

  const baseline = expectedBaselineObjectKeys(params.fixtureAuthorId);
  for (const entry of baseline) {
    const dedupeKey = `${entry.bucket}:${entry.key}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      plan.push(entry);
    }
  }

  for (const bucket of FIXTURE_STORAGE_BUCKETS) {
    const fullKeys = params.discoveredByBucket[bucket] ?? [];
    for (const fullKey of fullKeys) {
      if (!isWithinFixtureNamespace(fullKey, params.fixtureAuthorId)) {
        throw new UnexpectedStorageKeyError(
          `Discovered object "${fullKey}" in bucket "${bucket}" does not begin with the exact ` +
            `validated namespace "${params.fixtureAuthorId}/". Refusing to include it in any ` +
            "deletion plan -- this indicates either a listing bug or a path-convention change " +
            "that must be reviewed, never silently deleted.",
        );
      }
      const dedupeKey = `${bucket}:${fullKey}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        plan.push({ bucket, key: fullKey });
      }
    }
  }

  return plan;
}

// PHASE-1C review round 3, item 6: the fixture READER also has their own
// avatar namespace -- avatar upload is not author-specific (confirmed
// against src/components/avatar-field.tsx, usable by any signed-in
// profile). This validates a set of already-discovered keys against a
// single OTHER namespace id in a single bucket, independent of the
// author's own baseline-key plan above. There is no "baseline avatar"
// entry to unconditionally add -- the avatar baseline is the ABSENCE of
// a file (see manifest.mts's FIXTURE_AVATAR_PATH_BASELINE) -- so this
// only ever plans removal of whatever was actually discovered.
export function planNamespaceCleanup(params: {
  namespaceId: string;
  bucket: FixtureStorageBucket;
  discoveredKeys: readonly string[];
}): StorageCleanupPlanEntry[] {
  const plan: StorageCleanupPlanEntry[] = [];
  for (const fullKey of params.discoveredKeys) {
    if (!isWithinFixtureNamespace(fullKey, params.namespaceId)) {
      throw new UnexpectedStorageKeyError(
        `Discovered object "${fullKey}" in bucket "${params.bucket}" does not begin with the exact ` +
          `validated namespace "${params.namespaceId}/". Refusing to include it in any deletion plan.`,
      );
    }
    plan.push({ bucket: params.bucket, key: fullKey });
  }
  return plan;
}
