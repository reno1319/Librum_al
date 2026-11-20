import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { PageHeader } from "@/components/ui/page-header";
import { BlogEditorForm } from "../../blog-editor-form";
import {
  updateBlogPostAction,
  publishBlogPostAction,
  unpublishBlogPostAction,
  deleteBlogPostAction,
  scheduleBlogPostAction,
  cancelBlogScheduleAction,
} from "../../actions";
import {
  PublishButton,
  UnpublishButton,
  DeleteDraftButton,
  ScheduleForm,
  CancelScheduleButton,
} from "../blog-status-actions";
import { blogPublishState, canBeScheduled, formatTiranaDateTime, instantToTiranaInputs } from "@/lib/blog-schedule";
import type { BlogPostStatus } from "@/lib/types";
import { blogPostCategories } from "@/lib/blog-categories";
import { getBlogCategories } from "@/lib/blog-categories-server";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

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
  category: string;
  status: BlogPostStatus;
  published_at: string | null;
  featured: boolean;
  is_editorial: boolean;
  keywords: string[];
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
  const { error: rawError, success: rawSuccess } = await searchParams;
  const error = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);

  const supabase = await createClient();
  const { data: post } = await supabase
    .from("blog_posts")
    .select(
      "id, title, slug, excerpt, content_markdown, cover_image_path, category, is_editorial, keywords, status, published_at, featured, seo_title, seo_description",
    )
    .eq("id", id)
    .maybeSingle<EditableBlogPost>();

  if (!post) {
    notFound();
  }

  const coverImageUrl = post.cover_image_path
    ? supabase.storage.from("blog").getPublicUrl(post.cover_image_path).data.publicUrl
    : null;

  // e3: draft / scheduled (published, time still ahead) / published.
  const now = new Date();
  const state = blogPublishState(post, now);
  const schedulable = canBeScheduled(post, now);
  // A sensible starting point: tomorrow at 09:00 Tirana time.
  const scheduleDefaults =
    state === "scheduled" && post.published_at
      ? instantToTiranaInputs(post.published_at)
      : { date: instantToTiranaInputs(new Date(now.getTime() + 86_400_000).toISOString()).date, time: "09:00" };

  // e4: the article pinned now, when it is not this one.
  const { data: pinned } = await supabase
    .from("blog_posts")
    .select("id, title")
    .eq("featured", true)
    .neq("id", post.id)
    .maybeSingle<{ id: string; title: string }>();

  const description =
    state === "published"
      ? "Published"
      : state === "scheduled" && post.published_at
        ? `Scheduled · goes live ${formatTiranaDateTime(post.published_at)} Tirana time`
        : "Draft";

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 lg:max-w-6xl">
      <div className="lg:max-w-3xl">
      <Link href="/admin/blog" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to Blog
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Edit article"
          description={description}
          actions={
            <Link href={`/admin/blog/${post.id}/preview`} className="text-sm text-primary underline underline-offset-2 hover:decoration-2">
              Preview
            </Link>
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
      </div>

      <BlogEditorForm
        action={updateBlogPostAction.bind(null, post.id)}
        staffUserId={userId}
        slugReadOnly={state === "published"}
        submitLabel="Save"
        pinnedElsewhereTitle={pinned?.title ?? null}
        categories={blogPostCategories(await getBlogCategories())}
        initialValues={{
          title: post.title,
          slug: post.slug,
          excerpt: post.excerpt,
          category: post.category,
          featured: post.featured,
          isEditorial: post.is_editorial,
          keywords: post.keywords ?? [],
          seoTitle: post.seo_title ?? "",
          seoDescription: post.seo_description ?? "",
          contentMarkdown: post.content_markdown,
          coverImageUrl,
        }}
      />

      <div className="mt-6 flex flex-col gap-4 border-t border-border pt-6 text-sm lg:max-w-3xl">
        {state === "published" ? (
          <div>
            <UnpublishButton action={unpublishBlogPostAction.bind(null, post.id)} />
          </div>
        ) : (
          <>
            <strong className="text-base font-semibold">{state === "scheduled" ? "Scheduled" : "Publish"}</strong>
            {state === "draft" && (
              <div className="flex flex-wrap items-center gap-3">
                <PublishButton action={publishBlogPostAction.bind(null, post.id)} />
                <span className="text-muted">Goes live right away.</span>
              </div>
            )}
            {schedulable && (
              <div className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-3.5">
                <strong>{state === "scheduled" ? "Change the go-live time" : "Or schedule it"}</strong>
                <ScheduleForm
                  action={scheduleBlogPostAction.bind(null, post.id)}
                  defaultDate={scheduleDefaults.date}
                  defaultTime={scheduleDefaults.time}
                  submitLabel={state === "scheduled" ? "Change time" : "Schedule"}
                />
                <span className="text-muted">
                  Goes live on its own at that minute: on the blog, in search and in the sitemap. You can change the
                  time or cancel until then. Needs the same as Publish (at least 1 keyword).
                </span>
                {state === "scheduled" && (
                  <div>
                    <CancelScheduleButton action={cancelBlogScheduleAction.bind(null, post.id)} />
                  </div>
                )}
              </div>
            )}
            {state === "draft" && (
              <div className="pt-1.5">
                <DeleteDraftButton action={deleteBlogPostAction.bind(null, post.id)} />
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
