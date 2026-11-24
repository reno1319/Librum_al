// G2 (c1 a, Renato 11-24): blog pictures that no post uses are removed
// by the same nightly job as the temporary uploads (tmp-upload-cleanup).
//
// A picture inside an article is stored at "inline/<uuid>.jpg" in the
// public "blog" bucket the moment it is inserted in the editor
// (uploadBlogInlineImageAction). Removing it from the text, never saving
// the post, or deleting the post left it stored for good.
//
// Safety limits (allowlist, never a denylist):
//   * Only keys of the exact shape "inline/<uuid>.jpg". Covers
//     ("covers/...") and anything else in the bucket are never listed.
//   * A picture is kept while ANY post, in any state (draft, scheduled,
//     live), names "inline/<uuid>.jpg" in its text.
//   * Only pictures older than BLOG_IMAGE_MIN_AGE_MS (7 days), so a
//     picture just inserted in an unsaved draft is never removed.
//   * The posts are read first; if that read fails, nothing is removed.
//     If there are no posts at all, nothing is removed either (an empty
//     answer is treated as "could not tell", never as "nothing is used").
//   * At most BLOG_IMAGE_MAX_DELETES_PER_RUN removals per run.
//   * n2 a (Renato 11-24): the summary names every removed key
//     ("inline/<uuid>.jpg", random ids, no personal data), so the job log
//     shows what was removed and a mistake can be traced and restored.
//
// Only reads blog_posts.content_markdown; never writes a table.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const INLINE_FILE = new RegExp(`^${UUID}\\.jpg$`);
export const BLOG_IMAGE_BUCKET = "blog";
export const BLOG_IMAGE_PREFIX = "inline";
export const BLOG_IMAGE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const BLOG_IMAGE_MAX_DELETES_PER_RUN = 200;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;
const REMOVE_BATCH_SIZE = 100;

export function isRemovableBlogImageKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const parts = key.split("/");
  return parts.length === 2 && parts[0] === BLOG_IMAGE_PREFIX && INLINE_FILE.test(parts[1]);
}

type ListedEntry = { name: string; id: string | null; created_at?: string | null; updated_at?: string | null };

export interface BlogImageCleanupDeps {
  list(prefix: string, offset: number, limit: number): Promise<{ data: ListedEntry[] | null; error: unknown }>;
  remove(keys: string[]): Promise<{ error: unknown }>;
  // Every post's text, all states. null = the read failed.
  loadPostTexts(): Promise<string[] | null>;
}

export type BlogImageCleanupSummary = {
  ok: boolean;
  posts: number;
  pictures: number;
  inUse: number;
  tooNew: number;
  leftAlone: number;
  removed: number;
  removedKeys: string[];
  capped: boolean;
  skipped?: "no posts";
  error?: string;
};

function newestTimestampMs(entry: ListedEntry): number | null {
  let newest: number | null = null;
  for (const value of [entry.created_at, entry.updated_at]) {
    if (typeof value !== "string") continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

export async function runBlogImageCleanup(deps: BlogImageCleanupDeps, nowMs: number): Promise<BlogImageCleanupSummary> {
  const summary: BlogImageCleanupSummary = {
    ok: true,
    posts: 0,
    pictures: 0,
    inUse: 0,
    tooNew: 0,
    leftAlone: 0,
    removed: 0,
    removedKeys: [],
    capped: false,
  };

  const texts = await deps.loadPostTexts();
  if (texts === null) return { ...summary, ok: false, error: "posts read failed" };
  summary.posts = texts.length;
  if (texts.length === 0) return { ...summary, skipped: "no posts" };
  const allText = texts.join("\n");

  const cutoff = nowMs - BLOG_IMAGE_MIN_AGE_MS;
  const toRemove: string[] = [];
  try {
    scan: for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const { data, error } = await deps.list(BLOG_IMAGE_PREFIX, page * LIST_PAGE_SIZE, LIST_PAGE_SIZE);
      if (error || !Array.isArray(data)) throw new Error("list failed");
      for (const entry of data) {
        const key = `${BLOG_IMAGE_PREFIX}/${entry.name}`;
        if (entry.id === null || entry.id === undefined || !isRemovableBlogImageKey(key)) {
          summary.leftAlone += 1;
          continue;
        }
        summary.pictures += 1;
        if (allText.includes(key)) {
          summary.inUse += 1;
          continue;
        }
        const stamp = newestTimestampMs(entry);
        if (stamp === null) {
          summary.leftAlone += 1;
          continue;
        }
        if (stamp >= cutoff) {
          summary.tooNew += 1;
          continue;
        }
        if (toRemove.length >= BLOG_IMAGE_MAX_DELETES_PER_RUN) {
          summary.capped = true;
          break scan;
        }
        toRemove.push(key);
      }
      if (data.length < LIST_PAGE_SIZE) break;
      if (page === LIST_MAX_PAGES - 1) summary.capped = true;
    }
  } catch {
    return { ...summary, ok: false, error: "list failed" };
  }

  for (let i = 0; i < toRemove.length; i += REMOVE_BATCH_SIZE) {
    const batch = toRemove.slice(i, i + REMOVE_BATCH_SIZE);
    if (!batch.every(isRemovableBlogImageKey) || batch.some((key) => allText.includes(key))) {
      return { ...summary, ok: false, error: "unexpected key" };
    }
    const { error } = await deps.remove(batch);
    if (error) return { ...summary, ok: false, error: "remove failed" };
    summary.removed += batch.length;
    summary.removedKeys.push(...batch);
  }
  return summary;
}
