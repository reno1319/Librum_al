import Link from "next/link";
import type { Metadata } from "next";
import { requireStaff } from "@/lib/staff";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { loadAdminCategories } from "./load";
import { moveBlogCategoryAction } from "./actions";

export const metadata: Metadata = { title: "Blog categories" };

// Patch B (b5 a): owner and admin only.
export default async function AdminBlogCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  await requireStaff("blog.categories");
  const { success: rawSuccess, error: rawError } = await searchParams;
  const success = pageSuccessMessage(rawSuccess);
  const error = pageErrorMessage(rawError);
  const cats = await loadAdminCategories();
  const movable = cats.filter((c) => c.value !== "editorial");

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin/blog" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to Blog
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Categories"
          description="The order here is the order of the buttons and bands on /blog. Editorial always comes first."
          actions={
            <Link href="/admin/blog/categories/new">
              <Button type="button">New category</Button>
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

      <ul className="mt-6 flex flex-col gap-3">
        {cats.map((c) => {
          const i = movable.findIndex((m) => m.value === c.value);
          return (
            <li
              key={c.value}
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-sm"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-card font-serif text-lg"
                  style={{ backgroundColor: c.tint, color: c.ink }}
                >
                  Aa
                </span>
                <div className="min-w-0">
                  <p className="font-medium" style={{ color: c.ink }}>
                    {c.label}
                  </p>
                  <p className="text-xs text-muted">
                    Button: {c.shortLabel} · /blog/kategoria/{c.urlSlug} · {c.articleCount} article
                    {c.articleCount === 1 ? "" : "s"}
                    {c.value === "editorial" && " · can be renamed, not deleted"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {c.value === "editorial" ? (
                  <span className="text-xs text-muted">Always first</span>
                ) : (
                  <form className="flex items-center gap-2">
                    <button
                      formAction={moveBlogCategoryAction.bind(null, c.value, "up")}
                      disabled={i === 0}
                      aria-label={`Move ${c.label} up`}
                      className="focus-ring rounded-full border border-border px-2.5 py-1 text-sm disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      formAction={moveBlogCategoryAction.bind(null, c.value, "down")}
                      disabled={i === movable.length - 1}
                      aria-label={`Move ${c.label} down`}
                      className="focus-ring rounded-full border border-border px-2.5 py-1 text-sm disabled:opacity-30"
                    >
                      ↓
                    </button>
                  </form>
                )}
                <Link
                  href={`/admin/blog/categories/${c.value}/edit`}
                  className="ml-1 text-sm text-primary underline underline-offset-2 hover:decoration-2"
                >
                  Edit
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
