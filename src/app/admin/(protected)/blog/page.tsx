import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff, hasPermission } from "@/lib/staff";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { BLOG_CATEGORY_LABELS } from "@/lib/blog-categories";
import type { BlogPostStatus } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blog",
};

const STATUS_CLASS: Record<BlogPostStatus, string> = {
  draft: "text-muted",
  published: "font-semibold text-green-700",
};

const STATUS_LABEL: Record<BlogPostStatus, string> = {
  draft: "Draft",
  published: "Published",
};

const FILTERS: { value: BlogPostStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
];

type AdminBlogPostRow = {
  id: string;
  title: string;
  slug: string;
  status: BlogPostStatus;
  category: string;
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

  const supabase = await createClient();
  const { status: statusParam, success, error } = await searchParams;
  const activeFilter: BlogPostStatus | "all" =
    statusParam === "draft" || statusParam === "published" ? statusParam : "all";

  // Explicit column select, never select("*") -- this list only ever
  // renders these six fields; content_markdown/seo_*/created_by/
  // cover_image_path/featured aren't needed here at all.
  const { data: posts } = await supabase
    .from("blog_posts")
    .select("id, title, slug, status, category, published_at, updated_at")
    .order("updated_at", { ascending: false })
    .returns<AdminBlogPostRow[]>();

  const allPosts = posts ?? [];
  const visiblePosts = activeFilter === "all" ? allPosts : allPosts.filter((p) => p.status === activeFilter);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted hover:underline">
        &larr; Back to admin
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Blog"
          description={`${allPosts.length} article${allPosts.length === 1 ? "" : "s"}`}
          actions={
            canManage ? (
              <Link href="/admin/blog/new">
                <Button type="button">New article</Button>
              </Link>
            ) : undefined
          }
        />
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
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
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{post.title}</p>
                <p className="text-xs text-muted">
                  {BLOG_CATEGORY_LABELS[post.category as keyof typeof BLOG_CATEGORY_LABELS] ?? post.category}
                  {" · "}
                  Updated{" "}
                  {new Date(post.updated_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                  {post.status === "published" && post.published_at && (
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
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <span className={`text-sm ${STATUS_CLASS[post.status]}`}>{STATUS_LABEL[post.status]}</span>
                <Link href={`/admin/blog/${post.id}/preview`} className="text-sm text-primary hover:underline">
                  Preview
                </Link>
                {canManage && (
                  <Link href={`/admin/blog/${post.id}/edit`} className="text-sm text-primary hover:underline">
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
