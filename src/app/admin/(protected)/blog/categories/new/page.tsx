import Link from "next/link";
import type { Metadata } from "next";
import { requireStaff } from "@/lib/staff";
import { PageHeader } from "@/components/ui/page-header";
import { CategoryForm } from "../category-form";
import { createBlogCategoryAction } from "../actions";
import { pageErrorMessage } from "@/lib/page-messages";

export const metadata: Metadata = { title: "New category" };

export default async function NewBlogCategoryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireStaff("blog.categories");
  const { error: rawError } = await searchParams;
  const error = pageErrorMessage(rawError);
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin/blog/categories" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to Categories
      </Link>
      <div className="mt-2">
        <PageHeader title="New category" description="It shows on /blog as soon as you create it, last in the order." />
      </div>
      {error && (
        <p role="alert" className="mt-4 rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <CategoryForm
        mode="new"
        action={createBlogCategoryAction}
        submitLabel="Create category"
        initial={{ label: "", shortLabel: "", description: "", urlSlug: "", colour: "teal", cta: "browse" }}
      />
    </main>
  );
}
