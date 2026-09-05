import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { PageHeader } from "@/components/ui/page-header";
import { BlogEditorForm } from "../../blog-editor-form";
import { updateBlogPostAction, publishBlogPostAction, unpublishBlogPostAction, deleteBlogPostAction } from "../../actions";
import { PublishButton, UnpublishButton, DeleteDraftButton } from "../blog-status-actions";
import type { BlogCategory, BlogPostStatus } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Edit article",
};

type EditableBlogPost = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content_markdown: string;
  cover_image_path: string | null;
  category: BlogCategory;
  status: BlogPostStatus;
  featured: boolean;
  seo_title: string | null;
  seo_description: string | null;
};

export default async function EditBlogPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  // blog.manage, not blog.view -- per the BLOG-1C authorization model,
  // editing (unlike list/preview) is a blog.manage-only surface. The
  // underlying RLS policy (staff_has_permission('blog.view')) would
  // technically let a blog.view-only staffer's query resolve a draft
  // row too, but every current role holds blog.view and blog.manage
  // together (owner/admin/editor) or neither (moderator/support), and
  // gating the whole EDIT surface on the stricter permission is the
  // correct posture regardless: there is no legitimate reason for a
  // read-only holder to land on a form whose only purpose is mutation.
  const { userId } = await requireStaff("blog.manage");
  const { id } = await params;
  const { error, success } = await searchParams;

  const supabase = await createClient();
  const { data: post } = await supabase
    .from("blog_posts")
    .select(
      "id, title, slug, excerpt, content_markdown, cover_image_path, category, status, featured, seo_title, seo_description",
    )
    .eq("id", id)
    .maybeSingle<EditableBlogPost>();

  if (!post) {
    notFound();
  }

  const coverImageUrl = post.cover_image_path
    ? supabase.storage.from("blog").getPublicUrl(post.cover_image_path).data.publicUrl
    : null;

  const isPublished = post.status === "published";

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin/blog" className="text-sm text-muted hover:underline">
        &larr; Back to Blog
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Edit article"
          description={isPublished ? "Published" : "Draft"}
          actions={
            <Link href={`/admin/blog/${post.id}/preview`} className="text-sm text-primary hover:underline">
              Preview
            </Link>
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

      <BlogEditorForm
        action={updateBlogPostAction.bind(null, post.id)}
        staffUserId={userId}
        slugReadOnly={isPublished}
        submitLabel="Save"
        initialValues={{
          title: post.title,
          slug: post.slug,
          excerpt: post.excerpt,
          category: post.category,
          featured: post.featured,
          seoTitle: post.seo_title ?? "",
          seoDescription: post.seo_description ?? "",
          contentMarkdown: post.content_markdown,
          coverImageUrl,
        }}
      />

      <div className="mt-6 flex flex-wrap gap-3 border-t border-border pt-6">
        {isPublished ? (
          <UnpublishButton action={unpublishBlogPostAction.bind(null, post.id)} />
        ) : (
          <>
            <PublishButton action={publishBlogPostAction.bind(null, post.id)} />
            <DeleteDraftButton action={deleteBlogPostAction.bind(null, post.id)} />
          </>
        )}
      </div>
    </main>
  );
}
