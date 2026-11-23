import Link from "next/link";
import { blogPublishState } from "@/lib/blog-schedule";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { getBlogCategory } from "@/lib/blog-categories";
import { getBlogCategories } from "@/lib/blog-categories-server";
import { calculateReadingTime } from "@/lib/blog-reading-time";
import { blogBylineName } from "@/lib/blog-byline";
import { BlogMarkdown } from "@/components/blog-markdown";
import type { BlogPostStatus } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Preview article",
};

type PreviewBlogPost = {
  id: string;
  title: string;
  excerpt: string;
  content_markdown: string;
  cover_image_path: string | null;
  category: string;
  is_editorial: boolean;
  author_name: string | null;
  status: BlogPostStatus;
  published_at: string | null;
};

// LIBRUM 2.0 BLOG-1C: staff-only preview, gated by blog.view (the
// broadest legitimate reader of this surface -- a blog.manage holder
// without blog.view is not a real combination in the current matrix,
// but blog.view is still the semantically correct gate per the BLOG-1C
// authorization model's own "blog.view: may access preview/read-only
// surfaces" line). Deliberately NOT a secret-query-parameter-protected
// public URL -- this route lives entirely inside /admin/(protected),
// behind the same requireStaff() boundary as every other admin surface,
// per the brief's own explicit instruction not to build that shortcut.
export default async function PreviewBlogPostPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff("blog.view");
  const { id } = await params;

  const supabase = await createClient();
  const { data: post } = await supabase
    .from("blog_posts")
    .select("id, title, excerpt, content_markdown, cover_image_path, category, is_editorial, author_name, status, published_at")
    .eq("id", id)
    .maybeSingle<PreviewBlogPost>();

  if (!post) {
    notFound();
  }

  const coverImageUrl = post.cover_image_path
    ? supabase.storage.from("blog").getPublicUrl(post.cover_image_path).data.publicUrl
    : null;
  const readingMinutes = calculateReadingTime(post.content_markdown);
  // pv1 b (Renato 2026-11-22): the same byline as the live article page
  // (au2 reversed 2026-11-23): the typed name, else "Librum".
  const bylineName = blogBylineName(post);

  // e3: a scheduled article is published with its time still ahead.
  const state = blogPublishState(post);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <Link href={`/admin/blog/${post.id}/edit`} className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to editor
      </Link>

      <p className="mt-4 rounded-card bg-primary/10 px-3 py-2 text-xs text-primary">
        Staff preview --{" "}
        {state === "published"
          ? "this article is live"
          : state === "scheduled"
            ? "this article is scheduled, not visible to the public yet"
            : "this is a draft, not visible to the public"}
        . Approximates the future public article layout (BLOG-1D).
      </p>

      <article className="mt-6">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {getBlogCategory(await getBlogCategories(), post.category)?.label ?? post.category}
          {post.is_editorial && " · Editorial"}
        </p>
        <h1 className="mt-1 font-serif text-3xl font-semibold text-foreground md:text-4xl">{post.title}</h1>
        <p className="mt-3 text-lg text-muted">{post.excerpt}</p>

        <p className="mt-4 text-sm text-muted">
          {`Nga ${bylineName} · `}
          {post.status === "published" && post.published_at && (
            <>
              {new Date(post.published_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
              {" · "}
            </>
          )}
          {readingMinutes} min read
        </p>

        {coverImageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverImageUrl}
            alt=""
            className="mt-6 aspect-[3/2] w-full rounded-card object-cover"
          />
        )}

        <div className="mt-6">
          <BlogMarkdown markdown={post.content_markdown} />
        </div>
      </article>
    </main>
  );
}
