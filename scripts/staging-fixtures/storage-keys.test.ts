import { describe, expect, it } from "vitest";
import {
  expectedBaselineObjectKeys,
  isWithinFixtureNamespace,
  discoverStorageObjects,
  planStorageCleanup,
  toFullObjectKey,
  MalformedStorageEntryError,
  UnexpectedStorageKeyError,
  type ListEntriesFn,
  type RawStorageEntry,
} from "./storage-keys.mts";
import { FIXTURE_BOOKS } from "./manifest.mts";

const FIXTURE_AUTHOR_ID = "11111111-2222-4333-8444-555555555555";

function file(name: string, size = 100): RawStorageEntry {
  return { name, id: `id-${name}`, metadata: { size } };
}
function folder(name: string): RawStorageEntry {
  return { name, id: null, metadata: null };
}

describe("expectedBaselineObjectKeys", () => {
  it("includes exactly 10 keys (5 books x cover+manuscript)", () => {
    const keys = expectedBaselineObjectKeys(FIXTURE_AUTHOR_ID);
    expect(keys.length).toBe(FIXTURE_BOOKS.length * 2);
  });

  it("every key begins with exactly '<authorId>/'", () => {
    for (const { key } of expectedBaselineObjectKeys(FIXTURE_AUTHOR_ID)) {
      expect(isWithinFixtureNamespace(key, FIXTURE_AUTHOR_ID)).toBe(true);
    }
  });
});

describe("isWithinFixtureNamespace", () => {
  it("accepts a key exactly prefixed by '<id>/', rejects bare id / cross-author / generic fixtures/ prefixes", () => {
    expect(isWithinFixtureNamespace(`${FIXTURE_AUTHOR_ID}/book.epub`, FIXTURE_AUTHOR_ID)).toBe(true);
    expect(isWithinFixtureNamespace(FIXTURE_AUTHOR_ID, FIXTURE_AUTHOR_ID)).toBe(false);
    expect(isWithinFixtureNamespace("some-other-author-id/book.epub", FIXTURE_AUTHOR_ID)).toBe(false);
    expect(isWithinFixtureNamespace("fixtures/some-book.epub", FIXTURE_AUTHOR_ID)).toBe(false);
    expect(isWithinFixtureNamespace(`prefix-${FIXTURE_AUTHOR_ID}/book.epub`, FIXTURE_AUTHOR_ID)).toBe(false);
  });

  // A literal string-prefix check alone would wrongly accept this -- it
  // DOES start with "<id>/" as a string, even though ".." would walk it
  // outside the namespace. Segment-by-segment validation is required.
  it("rejects a path-traversal-shaped key even though it starts with the exact prefix string", () => {
    expect(
      isWithinFixtureNamespace(`${FIXTURE_AUTHOR_ID}/../../some-other-author/evil.png`, FIXTURE_AUTHOR_ID),
    ).toBe(false);
    expect(isWithinFixtureNamespace(`${FIXTURE_AUTHOR_ID}/./book.epub`, FIXTURE_AUTHOR_ID)).toBe(false);
  });
});

describe("discoverStorageObjects -- recursive, folder-aware", () => {
  it("returns a flat list of files at the root with no recursion needed", async () => {
    const listEntries: ListEntriesFn = async (path) => {
      if (path === FIXTURE_AUTHOR_ID) return [file("book1-cover.png", 42), file("book1.epub", 999)];
      return [];
    };
    const result = await discoverStorageObjects({ listEntries, fixtureAuthorId: FIXTURE_AUTHOR_ID });
    expect(result).toEqual(
      expect.arrayContaining([
        { fullKey: `${FIXTURE_AUTHOR_ID}/book1-cover.png`, sizeBytes: 42 },
        { fullKey: `${FIXTURE_AUTHOR_ID}/book1.epub`, sizeBytes: 999 },
      ]),
    );
  });

  // PHASE-1C mandatory correction, item 7's required test: nested
  // temporary Storage files (tmp/cover, tmp/epub, tmp/docx, tmp/avatar)
  // must be discovered.
  it("recursively discovers nested tmp/cover, tmp/epub, tmp/docx, and tmp/avatar files", async () => {
    const root = FIXTURE_AUTHOR_ID;
    const listEntries: ListEntriesFn = async (path) => {
      if (path === root) return [folder("tmp"), file("permanent-cover.png", 10)];
      if (path === `${root}/tmp`) return [folder("cover"), folder("epub"), folder("docx"), folder("avatar")];
      if (path === `${root}/tmp/cover`) return [file("abc.png", 111)];
      if (path === `${root}/tmp/epub`) return [file("def.epub", 222)];
      if (path === `${root}/tmp/docx`) return [file("ghi.docx", 333)];
      if (path === `${root}/tmp/avatar`) return [file("jkl.png", 444)];
      return [];
    };
    const result = await discoverStorageObjects({ listEntries, fixtureAuthorId: root });
    const keys = result.map((r) => r.fullKey).sort();
    expect(keys).toEqual(
      [
        `${root}/permanent-cover.png`,
        `${root}/tmp/avatar/jkl.png`,
        `${root}/tmp/cover/abc.png`,
        `${root}/tmp/docx/ghi.docx`,
        `${root}/tmp/epub/def.epub`,
      ].sort(),
    );
  });

  // PHASE-1C mandatory correction, item 7: folder entries must never be
  // treated as files.
  it("never includes a folder entry itself in the discovered results", async () => {
    const listEntries: ListEntriesFn = async (path) => {
      if (path === FIXTURE_AUTHOR_ID) return [folder("tmp")];
      if (path === `${FIXTURE_AUTHOR_ID}/tmp`) return [];
      return [];
    };
    const result = await discoverStorageObjects({ listEntries, fixtureAuthorId: FIXTURE_AUTHOR_ID });
    expect(result).toEqual([]);
    expect(result.some((r) => r.fullKey.endsWith("/tmp"))).toBe(false);
  });

  it("rejects a file entry whose name is a path-traversal attempt, even though the reconstructed key starts with the exact prefix string", async () => {
    const listEntries: ListEntriesFn = async (path) => {
      if (path === FIXTURE_AUTHOR_ID) return [file("../../some-other-author/evil.png", 1)];
      return [];
    };
    await expect(
      discoverStorageObjects({ listEntries, fixtureAuthorId: FIXTURE_AUTHOR_ID }),
    ).rejects.toBeInstanceOf(MalformedStorageEntryError);
  });

  it("rejects a malformed entry (file-shaped id with null metadata)", async () => {
    const listEntries: ListEntriesFn = async () => [{ name: "weird", id: "has-id", metadata: null }];
    await expect(
      discoverStorageObjects({ listEntries, fixtureAuthorId: FIXTURE_AUTHOR_ID }),
    ).rejects.toBeInstanceOf(MalformedStorageEntryError);
  });

  it("rejects a malformed entry (folder-shaped id with non-null metadata)", async () => {
    const listEntries: ListEntriesFn = async () => [{ name: "weird", id: null, metadata: { size: 5 } }];
    await expect(
      discoverStorageObjects({ listEntries, fixtureAuthorId: FIXTURE_AUTHOR_ID }),
    ).rejects.toBeInstanceOf(MalformedStorageEntryError);
  });

  it("paginates within a single directory using limit/offset", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => file(`f${i}.png`, 1));
    const page2 = [file("f100.png", 1)];
    const calls: number[] = [];
    const listEntries: ListEntriesFn = async (path, { offset }) => {
      if (path !== FIXTURE_AUTHOR_ID) return [];
      calls.push(offset);
      return offset === 0 ? page1 : page2;
    };
    const result = await discoverStorageObjects({ listEntries, fixtureAuthorId: FIXTURE_AUTHOR_ID });
    expect(result.length).toBe(101);
    expect(calls).toEqual([0, 100]);
  });

  it("bounds recursion depth and throws rather than looping forever on a pathological tree", async () => {
    let depth = 0;
    const listEntries: ListEntriesFn = async () => {
      depth++;
      return [folder("nested")];
    };
    await expect(
      discoverStorageObjects({ listEntries, fixtureAuthorId: FIXTURE_AUTHOR_ID, maxDepth: 3 }),
    ).rejects.toThrow(/max recursion depth/);
    expect(depth).toBeLessThan(20);
  });
});

describe("planStorageCleanup", () => {
  it("always includes all ten baseline keys", () => {
    const plan = planStorageCleanup({
      fixtureAuthorId: FIXTURE_AUTHOR_ID,
      discoveredByBucket: { covers: [], manuscripts: [], avatars: [] },
    });
    expect(plan.length).toBe(10);
  });

  it("includes a QA-created non-manifest object, including a nested tmp/ object", () => {
    const plan = planStorageCleanup({
      fixtureAuthorId: FIXTURE_AUTHOR_ID,
      discoveredByBucket: {
        covers: [toFullObjectKey(FIXTURE_AUTHOR_ID, "qa-created-book-id-cover.png")],
        manuscripts: [toFullObjectKey(`${FIXTURE_AUTHOR_ID}/tmp/epub`, "abandoned.epub")],
        avatars: [toFullObjectKey(`${FIXTURE_AUTHOR_ID}/tmp/avatar`, "abandoned.png")],
      },
    });
    expect(plan).toContainEqual({ bucket: "covers", key: `${FIXTURE_AUTHOR_ID}/qa-created-book-id-cover.png` });
    expect(plan).toContainEqual({
      bucket: "manuscripts",
      key: `${FIXTURE_AUTHOR_ID}/tmp/epub/abandoned.epub`,
    });
    expect(plan).toContainEqual({ bucket: "avatars", key: `${FIXTURE_AUTHOR_ID}/tmp/avatar/abandoned.png` });
    expect(plan.length).toBe(13);
  });

  it("rejects an unexpected key that does not belong to the validated namespace", () => {
    expect(() =>
      planStorageCleanup({
        fixtureAuthorId: FIXTURE_AUTHOR_ID,
        discoveredByBucket: { covers: ["some-other-authors-id/not-ours-cover.png"], manuscripts: [], avatars: [] },
      }),
    ).toThrow(UnexpectedStorageKeyError);
  });

  it("rejects a generic 'fixtures/' prefixed key", () => {
    expect(() =>
      planStorageCleanup({
        fixtureAuthorId: FIXTURE_AUTHOR_ID,
        discoveredByBucket: { covers: ["fixtures/some-book-cover.png"], manuscripts: [], avatars: [] },
      }),
    ).toThrow(UnexpectedStorageKeyError);
  });
});
