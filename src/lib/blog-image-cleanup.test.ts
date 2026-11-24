import { describe, expect, it, vi } from "vitest";
import {
  BLOG_IMAGE_MAX_DELETES_PER_RUN,
  BLOG_IMAGE_MIN_AGE_MS,
  isRemovableBlogImageKey,
  runBlogImageCleanup,
  type BlogImageCleanupDeps,
} from "./blog-image-cleanup";

// G2 (c1 a): blog pictures that no post uses are removed after 7 days.
const NOW = Date.parse("2026-11-24T03:00:00Z");
const OLD = new Date(NOW - BLOG_IMAGE_MIN_AGE_MS - 1000).toISOString();
const NEW = new Date(NOW - BLOG_IMAGE_MIN_AGE_MS + 60_000).toISOString();
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const pic = (n: number, at = OLD) => ({ name: `${uuid(n)}.jpg`, id: `id${n}`, created_at: at, updated_at: at });
const url = (n: number) => `https://x.supabase.co/storage/v1/object/public/blog/inline/${uuid(n)}.jpg`;

function deps(entries: ReturnType<typeof pic>[] | { name: string; id: string | null }[], texts: string[] | null) {
  const removed: string[][] = [];
  const listed: string[] = [];
  const d: BlogImageCleanupDeps = {
    list: vi.fn(async (prefix: string, offset: number, limit: number) => {
      listed.push(prefix);
      return { data: entries.slice(offset, offset + limit), error: null };
    }),
    remove: vi.fn(async (keys: string[]) => (removed.push(keys), { error: null })),
    loadPostTexts: vi.fn(async () => texts),
  };
  return { d, removed, listed };
}

describe("isRemovableBlogImageKey", () => {
  it("only inline/<uuid>.jpg", () => {
    expect(isRemovableBlogImageKey(`inline/${uuid(1)}.jpg`)).toBe(true);
    for (const key of [`covers/${uuid(1)}/${uuid(2)}.jpg`, `inline/${uuid(1)}.png`, `inline/x/${uuid(1)}.jpg`, `inline/${uuid(1).replace("4000", "4ABC")}.jpg`, `../inline/${uuid(1)}.jpg`, 5, null]) {
      expect(isRemovableBlogImageKey(key)).toBe(false);
    }
  });
});

describe("runBlogImageCleanup", () => {
  it("removes an old picture no post names; keeps pictures used by any post", async () => {
    const { d, removed, listed } = deps([pic(1), pic(2), pic(3)], [`draft ![](${url(1)})`, `live ![a](${url(3)} "t")`]);
    const s = await runBlogImageCleanup(d, NOW);
    expect(s).toMatchObject({ ok: true, posts: 2, pictures: 3, inUse: 2, removed: 1 });
    expect(removed).toEqual([[`inline/${uuid(2)}.jpg`]]);
    expect(s.removedKeys).toEqual([`inline/${uuid(2)}.jpg`]); // n2 a: named in the summary
    expect(listed).toEqual(["inline"]);
  });

  it("keeps a picture newer than 7 days even if no post names it", async () => {
    const { d, removed } = deps([pic(1, NEW)], ["no pictures"]);
    expect(await runBlogImageCleanup(d, NOW)).toMatchObject({ ok: true, tooNew: 1, removed: 0 });
    expect(removed).toEqual([]);
  });

  it("a failed posts read removes nothing and never lists", async () => {
    const { d, removed } = deps([pic(1)], null);
    expect(await runBlogImageCleanup(d, NOW)).toMatchObject({ ok: false, error: "posts read failed" });
    expect(removed).toEqual([]);
    expect(d.list).not.toHaveBeenCalled();
  });

  it("no posts at all: nothing is removed (an empty answer is never 'nothing used')", async () => {
    const { d, removed } = deps([pic(1)], []);
    expect(await runBlogImageCleanup(d, NOW)).toMatchObject({ ok: true, skipped: "no posts", removed: 0 });
    expect(removed).toEqual([]);
  });

  it("folders, odd names and pictures without a timestamp are left alone", async () => {
    const { d, removed } = deps(
      [{ name: "sub", id: null }, { name: "notes.txt", id: "n" }, { name: `${uuid(4)}.jpg`, id: "z" }],
      ["text"],
    );
    expect(await runBlogImageCleanup(d, NOW)).toMatchObject({ ok: true, leftAlone: 3, removed: 0 });
    expect(removed).toEqual([]);
  });

  it("a listing error removes nothing", async () => {
    const { d, removed } = deps([pic(1)], ["text"]);
    d.list = async () => ({ data: null, error: { message: "x" } });
    expect(await runBlogImageCleanup(d, NOW)).toMatchObject({ ok: false, error: "list failed" });
    expect(removed).toEqual([]);
  });

  it("pages through the folder and stops at the per-run cap", async () => {
    const many = Array.from({ length: BLOG_IMAGE_MAX_DELETES_PER_RUN + 50 }, (_, i) => pic(i + 10));
    const { d, removed } = deps(many, ["text"]);
    const s = await runBlogImageCleanup(d, NOW);
    expect(s).toMatchObject({ ok: true, removed: BLOG_IMAGE_MAX_DELETES_PER_RUN, capped: true });
    expect(removed.flat()).toHaveLength(BLOG_IMAGE_MAX_DELETES_PER_RUN);
    expect(removed.every((b) => b.length <= 100)).toBe(true);
    expect(s.removedKeys).toEqual(removed.flat());
  });

  it("a removal error answers not ok", async () => {
    const { d } = deps([pic(1)], ["text"]);
    d.remove = async () => ({ error: { message: "down" } });
    expect(await runBlogImageCleanup(d, NOW)).toMatchObject({ ok: false, error: "remove failed", removedKeys: [] });
  });
});
