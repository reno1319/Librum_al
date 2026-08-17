import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  createBundle,
  publishBundle,
  unpublishBundle,
  deleteBundle,
} from "./actions";
import type { Book, Bundle } from "@/lib/types";

export default async function BundlesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: books } = await supabase
    .from("books")
    .select("id, title")
    .eq("author_id", user!.id)
    .eq("status", "published")
    .order("title")
    .returns<Pick<Book, "id" | "title">[]>();

  const { data: bundles } = await supabase
    .from("bundles")
    .select("*")
    .eq("author_id", user!.id)
    .order("created_at", { ascending: false })
    .returns<Bundle[]>();

  const bundleIds = (bundles ?? []).map((b) => b.id);
  const { data: bundleBookRows } =
    bundleIds.length > 0
      ? await supabase
          .from("bundle_books")
          .select("bundle_id, book_id")
          .in("bundle_id", bundleIds)
      : { data: [] as { bundle_id: string; book_id: string }[] };

  const bookCountByBundle = new Map<string, number>();
  for (const row of bundleBookRows ?? []) {
    bookCountByBundle.set(row.bundle_id, (bookCountByBundle.get(row.bundle_id) ?? 0) + 1);
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Bundles</h1>
      <p className="mt-1 text-sm text-muted">
        Combine two or more of your published books into a single
        discounted purchase — one checkout unlocks every book in it.
      </p>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {success}
        </p>
      )}

      {!books || books.length < 2 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted">
          You need at least 2 published books before you can create a
          bundle.
        </p>
      ) : (
        <form
          action={createBundle}
          className="mt-6 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-sm"
        >
          <label className="flex flex-col gap-1 text-sm">
            Bundle title
            <input
              name="title"
              type="text"
              required
              placeholder="e.g. The Complete Collection"
              className="rounded-lg border border-border bg-surface px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Description (optional)
            <textarea
              name="description"
              rows={3}
              className="rounded-lg border border-border bg-surface px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Bundle price (USD)
            <input
              name="price"
              type="number"
              min="0"
              step="0.01"
              required
              className="w-40 rounded-lg border border-border bg-surface px-3 py-2"
            />
          </label>

          <fieldset>
            <legend className="text-sm">Books in this bundle</legend>
            <div
              className="mt-2 rounded-lg border border-border p-3"
              style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
            >
              {books.map((book) => (
                <label key={book.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="bookIds" value={book.id} />
                  {book.title}
                </label>
              ))}
            </div>
            <span className="text-xs text-muted">Choose at least 2.</span>
          </fieldset>

          <button
            type="submit"
            className="w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Create bundle
          </button>
        </form>
      )}

      <ul className="mt-8 flex flex-col gap-3">
        {(bundles ?? []).map((bundle) => (
          <li
            key={bundle.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm"
          >
            <div style={{ flex: "1 1 12rem" }}>
              <p className="font-medium">
                {bundle.title}{" "}
                <span className="text-muted">
                  · ${(bundle.price_cents / 100).toFixed(2)}
                </span>
              </p>
              <p className="text-xs text-muted capitalize">
                {bundle.status} · {bookCountByBundle.get(bundle.id) ?? 0} books
              </p>
            </div>
            <Link
              href={`/dashboard/bundles/${bundle.id}/edit`}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
            >
              Edit
            </Link>
            {bundle.status === "draft" ? (
              <form action={publishBundle.bind(null, bundle.id)}>
                <button
                  type="submit"
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                >
                  Publish
                </button>
              </form>
            ) : (
              <form action={unpublishBundle.bind(null, bundle.id)}>
                <button
                  type="submit"
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                >
                  Unpublish
                </button>
              </form>
            )}
            <form action={deleteBundle.bind(null, bundle.id)}>
              <button
                type="submit"
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </form>
          </li>
        ))}
        {(bundles ?? []).length === 0 && (
          <p className="text-sm text-muted">No bundles yet.</p>
        )}
      </ul>
    </main>
  );
}
