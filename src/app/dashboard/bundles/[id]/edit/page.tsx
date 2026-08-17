import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateBundle } from "../../actions";
import type { Book, Bundle } from "@/lib/types";

export default async function EditBundlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: bundle } = await supabase
    .from("bundles")
    .select("*")
    .eq("id", id)
    .single<Bundle>();

  if (!bundle || bundle.author_id !== user.id) {
    notFound();
  }

  const { data: books } = await supabase
    .from("books")
    .select("id, title")
    .eq("author_id", user.id)
    .eq("status", "published")
    .order("title")
    .returns<Pick<Book, "id" | "title">[]>();

  const { data: currentBookRows } = await supabase
    .from("bundle_books")
    .select("book_id")
    .eq("bundle_id", id);

  const currentBookIds = new Set((currentBookRows ?? []).map((r) => r.book_id));

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard/bundles" className="text-sm text-muted hover:underline">
        &larr; Back to bundles
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Edit bundle</h1>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form
        action={updateBundle.bind(null, bundle.id)}
        className="mt-6 flex flex-col gap-4"
      >
        <label className="flex flex-col gap-1 text-sm">
          Bundle title
          <input
            name="title"
            type="text"
            required
            defaultValue={bundle.title}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Description (optional)
          <textarea
            name="description"
            rows={3}
            defaultValue={bundle.description}
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
            defaultValue={(bundle.price_cents / 100).toFixed(2)}
            className="w-40 rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <fieldset>
          <legend className="text-sm">Books in this bundle</legend>
          <div
            className="mt-2 rounded-lg border border-border p-3"
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
          >
            {(books ?? []).map((book) => (
              <label key={book.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="bookIds"
                  value={book.id}
                  defaultChecked={currentBookIds.has(book.id)}
                />
                {book.title}
              </label>
            ))}
          </div>
          <span className="text-xs text-muted">Choose at least 2.</span>
        </fieldset>

        <button
          type="submit"
          className="mt-2 w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Save changes
        </button>
      </form>
    </main>
  );
}
