import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireStaff } from "@/lib/staff";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { CategoryForm } from "../../category-form";
import { loadAdminCategories } from "../../load";
import { deleteBlogCategoryAction, updateBlogCategoryAction } from "../../actions";
import { pageErrorMessage } from "@/lib/page-messages";

export const metadata: Metadata = { title: "Edit category" };

export default async function EditBlogCategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ value: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireStaff("blog.categories");
  const { value } = await params;
  const { error: rawError } = await searchParams;
  const error = pageErrorMessage(rawError);
  const cats = await loadAdminCategories();
  const cat = cats.find((c) => c.value === value);
  if (!cat) notFound();
  const isEditorial = cat.value === "editorial";
  const targets = cats.filter((c) => c.value !== "editorial" && c.value !== cat.value);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin/blog/categories" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to Categories
      </Link>
      <div className="mt-2">
        <PageHeader
          title={`Edit: ${cat.label}`}
          description={
            isEditorial
              ? "Editorial keeps its gold colour, its “Editorial” tag and its place first. You can change its name and description."
              : `${cat.articleCount} article${cat.articleCount === 1 ? "" : "s"} in this category.`
          }
        />
      </div>
      {error && (
        <p role="alert" className="mt-4 rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <CategoryForm
        action={updateBlogCategoryAction.bind(null, cat.value)}
        mode={isEditorial ? "editorial" : "edit"}
        submitLabel="Save changes"
        initial={{
          label: cat.label,
          shortLabel: cat.shortLabel,
          description: cat.description,
          urlSlug: cat.urlSlug,
          colour: cat.colour,
          cta: cat.cta,
        }}
      />

      {!isEditorial && (
        <details className="mt-10 rounded-card border border-red-200 bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium text-red-700">Delete this category</summary>
          <form action={deleteBlogCategoryAction.bind(null, cat.value)} className="mt-4 flex flex-col gap-4 text-sm">
            <label className="flex flex-col gap-1">
              {cat.articleCount === 0
                ? "This category has no articles."
                : `Its ${cat.articleCount} article${cat.articleCount === 1 ? "" : "s"} (drafts and scheduled included) move to:`}
              {cat.articleCount > 0 && (
                <select name="moveTo" required defaultValue="" className="rounded-control border border-control bg-surface px-3 py-2">
                  <option value="" disabled>
                    Choose a category
                  </option>
                  {targets.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <p className="text-muted">
              The page /blog/kategoria/{cat.urlSlug} will stop working (it shows “not found”). This can&apos;t be
              undone.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" name="confirm" required className="mt-1" />
              <span>Yes, delete &ldquo;{cat.label}&rdquo;</span>
            </label>
            <div>
              <Button type="submit" variant="danger">
                Delete category
              </Button>
            </div>
          </form>
        </details>
      )}
    </main>
  );
}
