import { describe, expect, it } from "vitest";
import {
  isRemovableTmpUploadKey,
  isTmpCleanupOff,
  runTmpUploadCleanup,
  TMP_CLEANUP_MAX_DELETES_PER_RUN,
  TMP_CLEANUP_SCAN_BUDGET_MS,
  TMP_UPLOAD_MIN_AGE_MS,
  type ListedEntry,
  type TmpCleanupStorage,
} from "./tmp-upload-cleanup";

const NOW = Date.parse("2026-11-05T03:00:00Z");
const OLD = new Date(NOW - TMP_UPLOAD_MIN_AGE_MS - 60_000).toISOString();
const NEW = new Date(NOW - TMP_UPLOAD_MIN_AGE_MS + 60_000).toISOString();

const A = "a1b2c3d4-1111-4111-8111-abcdef111111";
const B = "b1b2c3d4-2222-4222-8222-abcdef222222";
const F1 = "0b8e6a52-6f0e-4d3c-9a61-2f4d8c1e7b90";
const F2 = "1c9f7b63-7a1f-4e4d-8b72-3a5e9d2f8ca1";
const BOOK = "c1b2c3d4-3333-4333-8333-abcdef333333";

type FakeObject = { created_at?: string | null; updated_at?: string | null; size?: number };

// A tiny in-memory bucket: keys -> objects. list() returns the direct
// children of a prefix the way Supabase Storage does (folders with
// id null, files with an id and timestamps).
function fakeStorage(objects: Record<string, FakeObject>, opts: { failList?: string; failRemove?: boolean } = {}) {
  const store = new Map(Object.entries(objects));
  const listed: string[] = [];
  const removed: string[][] = [];
  const storage: TmpCleanupStorage = {
    async list(prefix, offset, limit) {
      listed.push(prefix);
      if (opts.failList !== undefined && opts.failList === prefix) return { data: null, error: new Error("boom") };
      const base = prefix === "" ? "" : `${prefix}/`;
      const children = new Map<string, ListedEntry>();
      for (const [key, obj] of store) {
        if (!key.startsWith(base)) continue;
        const rest = key.slice(base.length);
        const [head, ...tail] = rest.split("/");
        if (tail.length > 0) children.set(head, { name: head, id: null });
        else
          children.set(head, {
            name: head,
            id: `id-${key}`,
            created_at: obj.created_at,
            updated_at: obj.updated_at,
            metadata: { size: obj.size ?? 10 },
          });
      }
      const sorted = [...children.values()].sort((x, y) => x.name.localeCompare(y.name));
      return { data: sorted.slice(offset, offset + limit), error: null };
    },
    async remove(keys) {
      if (opts.failRemove) return { error: new Error("nope") };
      removed.push(keys);
      for (const key of keys) store.delete(key);
      return { error: null };
    },
  };
  return { storage, store, listed, removed };
}

describe("isRemovableTmpUploadKey", () => {
  it.each([
    `${A}/tmp/epub/${F1}.epub`,
    `${A}/tmp/preview/${F1}.epub`,
    `${A}/tmp/docx/${F1}.docx`,
    `${A}/tmp/cover/${F1}.jpg`,
    `${A}/tmp/cover/${F1}.png`,
    `${A}/tmp/avatar/${F1}.png`,
    `${A}/tmp/blog/${F1}.jpg`,
  ])("accepts %s", (key) => {
    expect(isRemovableTmpUploadKey(key)).toBe(true);
  });

  it.each([
    `${A}/${BOOK}.epub`,
    `${A}/${BOOK}/${F1}.epub`,
    `${A}/tmp/${F1}.epub`,
    `${A}/tmp/epub/${F1}.docx`,
    `${A}/tmp/cover/${F1}.webp`,
    `${A}/tmp/other/${F1}.epub`,
    `${A}/tmp/epub/x/${F1}.epub`,
    // Audit r1 F5 (M2): a valid key with anything after it.
    `${A}/tmp/epub/${F1}.epub/x`,
    `${A}/tmp/epub/${F1}.epub/`,
    `${A}/tmp/epub/${F1.toUpperCase()}.epub`,
    `${A}/tmp/epub/../${F1}.epub`,
    `../${A}/tmp/epub/${F1}.epub`,
    `/${A}/tmp/epub/${F1}.epub`,
    `not-a-uuid/tmp/epub/${F1}.epub`,
    `${A}/TMP/epub/${F1}.epub`,
    `${A}/tmp/epub/${F1}.epub ` ,
    `${A}/tmp/constructor/${F1}.epub`,
    `${A}/tmp/__proto__/${F1}.epub`,
    "",
    42,
    null,
  ])("refuses %s", (key) => {
    expect(isRemovableTmpUploadKey(key)).toBe(false);
  });
});

describe("isTmpCleanupOff", () => {
  it("is on when unset or blank, off for any other value", () => {
    expect(isTmpCleanupOff(undefined)).toBe(false);
    expect(isTmpCleanupOff("")).toBe(false);
    expect(isTmpCleanupOff("  ")).toBe(false);
    expect(isTmpCleanupOff("1")).toBe(true);
    expect(isTmpCleanupOff("false")).toBe(true);
  });
});

describe("runTmpUploadCleanup", () => {
  it("removes only temporary uploads older than the limit, of every allowlisted kind", async () => {
    const { storage, store, removed } = fakeStorage({
      [`${A}/tmp/epub/${F1}.epub`]: { created_at: OLD, updated_at: OLD, size: 1000 },
      [`${A}/tmp/preview/${F1}.epub`]: { created_at: OLD, updated_at: OLD, size: 500 },
      [`${A}/tmp/docx/${F2}.docx`]: { created_at: OLD, updated_at: OLD },
      [`${A}/tmp/cover/${F1}.jpg`]: { created_at: OLD, updated_at: OLD },
      [`${B}/tmp/avatar/${F1}.png`]: { created_at: OLD, updated_at: OLD },
      [`${B}/tmp/blog/${F2}.png`]: { created_at: OLD, updated_at: OLD },
      [`${B}/tmp/epub/${F2}.epub`]: { created_at: NEW, updated_at: NEW },
      // Final book files: never touched.
      [`${A}/${BOOK}.epub`]: { created_at: OLD, updated_at: OLD },
      [`${A}/${BOOK}/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
    });
    const summary = await runTmpUploadCleanup(storage, NOW);

    expect(summary.ok).toBe(true);
    expect(summary.accountsScanned).toBe(2);
    expect(summary.removed).toBe(6);
    expect(summary.found).toEqual({ epub: 1, preview: 1, docx: 1, cover: 1, avatar: 1, blog: 1 });
    expect(summary.foundBytes).toBe(1000 + 500 + 4 * 10);
    expect(summary.tooNew).toBe(1);
    expect(summary.capped).toBe(false);
    expect([...store.keys()].sort()).toEqual(
      [`${A}/${BOOK}.epub`, `${A}/${BOOK}/${F1}.epub`, `${B}/tmp/epub/${F2}.epub`].sort(),
    );
    expect(removed.flat().every(isRemovableTmpUploadKey)).toBe(true);
  });

  it("uses the newest timestamp: a Word ebook rewritten recently is kept", async () => {
    const { storage, store } = fakeStorage({
      [`${A}/tmp/epub/${F1}.epub`]: { created_at: OLD, updated_at: NEW },
    });
    const summary = await runTmpUploadCleanup(storage, NOW);
    expect(summary.removed).toBe(0);
    expect(summary.tooNew).toBe(1);
    expect(store.size).toBe(1);
  });

  it("keeps a file exactly at the limit and one with no readable timestamp", async () => {
    const atLimit = new Date(NOW - TMP_UPLOAD_MIN_AGE_MS).toISOString();
    const { storage, store } = fakeStorage({
      [`${A}/tmp/epub/${F1}.epub`]: { created_at: atLimit, updated_at: atLimit },
      [`${A}/tmp/epub/${F2}.epub`]: { created_at: null, updated_at: "not a date" },
    });
    const summary = await runTmpUploadCleanup(storage, NOW);
    expect(summary.removed).toBe(0);
    expect(summary.leftAlone).toBe(1);
    expect(store.size).toBe(2);
  });

  it("leaves unknown kinds, odd file names, loose files and non-account folders alone", async () => {
    const { storage, store, listed } = fakeStorage({
      [`${A}/tmp/other/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
      [`${A}/tmp/epub/notes.txt`]: { created_at: OLD, updated_at: OLD },
      [`${A}/tmp/epub/${F1}.docx`]: { created_at: OLD, updated_at: OLD },
      [`${A}/tmp/epub/deeper/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
      [`${A}/tmp/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
      [`shared/tmp/epub/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
      [`${F1}.epub`]: { created_at: OLD, updated_at: OLD },
    });
    const summary = await runTmpUploadCleanup(storage, NOW);
    expect(summary.removed).toBe(0);
    expect(store.size).toBe(7);
    expect(summary.leftAlone).toBe(5);
    // Never walks outside "<uuid>/tmp" and its allowlisted kinds.
    expect(listed.every((p) => p === "" || p.startsWith(`${A}/tmp`))).toBe(true);
    expect(listed).not.toContain(`${A}/tmp/other`);
    expect(listed).not.toContain(`${A}/tmp/epub/deeper`);
  });

  it(`stops at ${TMP_CLEANUP_MAX_DELETES_PER_RUN} removals and reports it`, async () => {
    const objects: Record<string, FakeObject> = {};
    for (let i = 0; i < TMP_CLEANUP_MAX_DELETES_PER_RUN + 20; i += 1) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      objects[`${A}/tmp/cover/${id}.jpg`] = { created_at: OLD, updated_at: OLD };
    }
    const { storage, store, removed } = fakeStorage(objects);
    const summary = await runTmpUploadCleanup(storage, NOW);
    expect(summary.ok).toBe(true);
    expect(summary.capped).toBe(true);
    expect(summary.removed).toBe(TMP_CLEANUP_MAX_DELETES_PER_RUN);
    expect(store.size).toBe(20);
    expect(removed.every((batch) => batch.length <= 100)).toBe(true);
  });

  it("stops scanning at the time budget and still removes what it found (audit r1 F2)", async () => {
    const { storage, store, listed } = fakeStorage({
      [`${A}/tmp/epub/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
      [`${B}/tmp/epub/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
    });
    // The clock passes the budget after the first account is scanned.
    let checks = 0;
    const elapsed = () => (checks++ === 0 ? 0 : TMP_CLEANUP_SCAN_BUDGET_MS);
    const summary = await runTmpUploadCleanup(storage, NOW, elapsed);
    expect(summary).toMatchObject({ ok: true, removed: 1, accountsScanned: 1, capped: true, timeBudgetHit: true });
    expect([...store.keys()]).toEqual([`${B}/tmp/epub/${F1}.epub`]);
    expect(listed).not.toContain(`${B}/tmp`);
  });

  it("keeps the scan budget well inside the route's 60 s limit", () => {
    expect(TMP_CLEANUP_SCAN_BUDGET_MS).toBeLessThanOrEqual(45_000);
  });

  it("removes nothing at all when any listing fails", async () => {
    const { storage, store, removed } = fakeStorage(
      {
        [`${A}/tmp/epub/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
        [`${B}/tmp/epub/${F1}.epub`]: { created_at: OLD, updated_at: OLD },
      },
      { failList: `${B}/tmp` },
    );
    const summary = await runTmpUploadCleanup(storage, NOW);
    expect(summary.ok).toBe(false);
    expect(summary.removed).toBe(0);
    expect(removed).toEqual([]);
    expect(store.size).toBe(2);
  });

  it("reports a failed removal", async () => {
    const { storage } = fakeStorage(
      { [`${A}/tmp/epub/${F1}.epub`]: { created_at: OLD, updated_at: OLD } },
      { failRemove: true },
    );
    const summary = await runTmpUploadCleanup(storage, NOW);
    expect(summary.ok).toBe(false);
    expect(summary.removed).toBe(0);
  });

  it("does nothing on an empty bucket", async () => {
    const { storage, removed } = fakeStorage({});
    const summary = await runTmpUploadCleanup(storage, NOW);
    expect(summary).toMatchObject({ ok: true, accountsScanned: 0, removed: 0 });
    expect(removed).toEqual([]);
  });
});
