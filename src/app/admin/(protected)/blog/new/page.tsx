import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { PageHeader } from "@/components/ui/page-header";
import { BlogEditorForm } from "../blog-editor-form";
import { createBlogPostAction } from "../actions";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "New article",
};

export default async function NewBlogPostPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // blog.manage, not blog.view -- creating an article is a mutation,
  // gated the same way every other blog.manage-only surface is.
  const { userId } = await requireStaff("blog.manage");
  const { error } = await searchParams;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin/blog" className="text-sm text-muted hover:underline">
        &larr; Back to Blog
      </Link>
      <div className="mt-2">
        <PageHeader title="New article" description="Saved as a draft until you publish it." />
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <BlogEditorForm
        action={createBlogPostAction}
        staffUserId={userId}
        slugReadOnly={false}
        submitLabel="Save draft"
      />
    </main>
  );
}
