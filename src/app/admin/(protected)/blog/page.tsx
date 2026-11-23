import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff, hasPermission } from "@/lib/staff";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { getBlogCategory } from "@/lib/blog-categories";
import { getBlogCategories } from "@/lib/blog-categories-server";
import { blogPublishState, formatTiranaDateTime, type BlogPublishState } from "@/lib/blog-schedule";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import {
  BLOG_REACTIONS,
  BLOG_REACTION_COUNTS_MAX_IDS,
  groupBlogReactionCounts,
  type BlogReactionCountRow,
  type BlogReactionCounts,
} from "@/lib/blog-reactions";

export const metadata: Metadata = {
  title: "Blog",
};

// e3 (2026-11-19): a scheduled article is published with its time
// still ahead; the list shows it as its own state.
const STATUS_CLASS: Record<BlogPublishState, string> = {
  draft: "text-muted",
  scheduled: "font-semibold text-amber-800",
  published: "font-semibold text-green-700",
};

const STATUS_LABEL: Record<BlogPublishState, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
};

const FILTERS: { value: BlogPublishState | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
];

type AdminBlogPostRow = {
  id: string;
  title: string;
  slug: string;
  status: string;
  featured: boolean;
  category: string;
  is_editorial: boolean;
  published_at: string | null;
  updated_at: string;
};

export default async function AdminBlogListPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; success?: string; error?: string }>;
}) {
  // blog.view is the read gate for this whole surface -- a blog.view
  // holder without blog.manage still sees this list (read-only, since
  // the "New article" action below is independently hidden for them),
  // exactly the same "one permission for reads, a narrower one for
  // mutation" shape every other admin surface in this codebase already
  // uses (e.g. reports.view vs reports.resolve).
  await requireStaff("blog.view");
  const canManage = await hasPermission("blog.manage");
  const canCategories = await hasPermission("blog.categories");

  const supabase = await createClient();
  const { status: statusParam, success: rawSuccess, error: rawError } = await searchParams;
  const success = pageSuccessMessage(rawSuccess);
  const error = pageErrorMessage(rawError);
  const activeFilter: BlogPublishState | "all" =
    statusParam === "draft" || statusParam === "scheduled" || statusParam === "published" ? statusParam : "all";

  // Explicit column select, never select("*") -- this list only ever
  // renders these fields; content_markdown/seo_*/created_by/
  // cover_image_path aren't needed here at all. featured drives the
  // 📌 Pinned label and published_at the Scheduled state (2026-11-19).
  const { data: posts } = await supabase
    .from("blog_posts")
    .select("id, title, slug, status, featured, category, is_editorial, published_at, updated_at")
    .order("updated_at", { ascending: false })
    .returns<AdminBlogPostRow[]>();

  const categories = await getBlogCategories();
  const now = new Date();
  const allPosts = (posts ?? []).map((p) => ({ ...p, state: blogPublishState(p, now) }));
  const visiblePosts = activeFilter === "all" ? allPosts : allPosts.filter((p) => p.state === activeFilter);

  // BR1 q6 (2026-11-23): reaction totals per live article -- numbers
  // only, never which reader reacted.
  const livePostIds = visiblePosts.filter((p) => p.state === "published").map((p) => p.id);
  // Audit L1: asked 500 at a time (the function's limit); a failed read
  // shows "—" for that article, never a wrong 0.
  const reactionCounts = new Map<string, BlogReactionCounts>();
  const unknownReactionIds = new Set<string>();
  for (let start = 0; start < livePostIds.length; start += BLOG_REACTION_COUNTS_MAX_IDS) {
    const ids = livePostIds.slice(start, start + BLOG_REACTION_COUNTS_MAX_IDS);
    const { data, error } = await supabase.rpc("blog_post_reaction_counts", { p_post_ids: ids });
    if (error) {
      console.error("admin blog: reaction counts read failed", { code: error.code });
      ids.forEach((id) => unknownReactionIds.add(id));
      continue;
    }
    groupBlogReactionCounts(data as BlogReactionCountRow[] | null).forEach((counts, id) => reactionCounts.set(id, counts));
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to admin
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Blog"
          description={`${allPosts.length} article${allPosts.length === 1 ? "" : "s"}`}
          actions={
            canManage || canCategories ? (
              <div className="flex flex-wrap gap-2">
                {canCategories && (
                  <Link href="/admin/blog/categories">
                    <Button type="button" variant="outline">
                      Categories
                    </Button>
                  </Link>
                )}
                {canManage && (
                  <Link href="/admin/blog/new">
                    <Button type="button">New article</Button>
                  </Link>
                )}
              </div>
            ) : undefined
          }
        />
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="mt-4 rounded-card bg-green-50 px-3 py-2 text-sm text-green-700">
          {success}
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((filter) => {
          const href = filter.value === "all" ? "/admin/blog" : `/admin/blog?status=${filter.value}`;
          const isActive = filter.value === activeFilter;
          return (
            <Link
              key={filter.value}
              href={href}
              aria-current={isActive ? "true" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-surface text-foreground hover:bg-surface-hover"
              }`}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      {visiblePosts.length === 0 ? (
        <EmptyState
          className="mt-6"
          title="No articles yet."
          description={
            canManage
              ? "Create your first article to get started."
              : "Articles will appear here once an editor creates one."
          }
        />
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {visiblePosts.map((post) => (
            <li
              key={post.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {post.title}
                  {post.featured && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 align-middle text-xs font-semibold text-amber-800">
                      📌 Pinned
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted">
                  {getBlogCategory(categories, post.category)?.label ?? post.category}
                  {post.is_editorial && " · Editorial"}
                  {" · "}
                  Updated{" "}
                  {new Date(post.updated_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                  {post.state === "scheduled" && post.published_at && (
                    <>
                      {" · "}
                      Goes live {formatTiranaDateTime(post.published_at)} Tirana time
                    </>
                  )}
                  {post.state === "published" && post.published_at && (
                    <>
                      {" · "}
                      Published{" "}
                      {new Date(post.published_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </>
                  )}
                </p>
                {post.state === "published" && (
                  <p className="mt-1 text-xs text-muted">
                    Reactions:{" "}
                    {BLOG_REACTIONS.map((reaction, index) => (
                      <span key={reaction.key} title={reaction.label}>
                        {index > 0 && " · "}
                        <span aria-hidden="true">{reaction.emoji}</span>
                        <span className="sr-only">{reaction.label}</span>{" "}
                        <span className="tabular-nums">
                          {unknownReactionIds.has(post.id) ? "—" : (reactionCounts.get(post.id)?.[reaction.key] ?? 0)}
                        </span>
                      </span>
                    ))}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <span className={`text-sm ${STATUS_CLASS[post.state]}`}>{STATUS_LABEL[post.state]}</span>
                <Link href={`/admin/blog/${post.id}/preview`} className="text-sm text-primary underline underline-offset-2 hover:decoration-2">
                  Preview
                </Link>
                {canManage && (
                  <Link href={`/admin/blog/${post.id}/edit`} className="text-sm text-primary underline underline-offset-2 hover:decoration-2">
                    Edit
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
