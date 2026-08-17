import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateBook } from "../../actions";
import { GENRES } from "@/lib/genres";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { getPublishChecklist } from "@/lib/publish-checklist";
import type { Book, Series } from "@/lib/types";

export default async function EditBookPage({
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

  const { data: book } = await supabase
    .from("books")
    .select("*")
    .eq("id", id)
    .single<Book>();

  if (!book || book.author_id !== user.id) {
    notFound();
  }

  const { data: series } = await supabase
    .from("series")
    .select("*")
    .eq("author_id", user.id)
    .order("title")
    .returns<Series[]>();

  const coverUrl = book.cover_path
    ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
    : null;
  const manuscriptName = book.file_path?.split("/").pop() ?? null;
  const incompleteChecklist =
    book.status === "draft"
      ? getPublishChecklist(book).filter((item) => !item.done)
      : [];

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Edit book</h1>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {incompleteChecklist.length > 0 && (
        <div className="mt-4 rounded-lg border border-dashed border-border bg-surface px-4 py-3 text-sm">
          <p className="font-medium">Before you publish, consider:</p>
          <ul className="mt-2 flex flex-col text-muted" style={{ gap: "0.25rem" }}>
            {incompleteChecklist.map((item) => (
              <li key={item.label}>&middot; {item.label}</li>
            ))}
          </ul>
        </div>
      )}

      <form
        action={updateBook.bind(null, book.id)}
        className="mt-6 flex flex-col gap-4"
      >
        <label className="flex flex-col gap-1 text-sm">
          Title
          <input
            name="title"
            type="text"
            required
            defaultValue={book.title}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Description
          <textarea
            name="description"
            rows={4}
            defaultValue={book.description}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Preview excerpt (optional)
          <textarea
            name="previewText"
            rows={8}
            defaultValue={book.preview_text}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
          <span className="text-xs text-muted">
            Shown to readers under &quot;Look inside&quot; before they buy —
            the opening page or two works well. Leave blank to skip.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Keywords (optional)
          <input
            name="keywords"
            type="text"
            defaultValue={book.keywords}
            placeholder="e.g. space opera, first contact, hard sci-fi"
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
          <span className="text-xs text-muted">
            Comma-separated. Helps readers find your book by terms beyond
            its genre — up to 15.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Genre
          <select
            name="genre"
            required
            defaultValue={book.genre ?? ""}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          >
            <option value="" disabled>
              Choose a genre
            </option>
            {GENRES.map((genre) => (
              <option key={genre} value={genre}>
                {genre}
              </option>
            ))}
          </select>
        </label>

        {series && series.length === 0 && (
          <p className="text-xs text-muted">
            Want to group this with other books as a series?{" "}
            <Link href="/dashboard/series" className="underline">
              Create a series first
            </Link>
            , then come back here.
          </p>
        )}

        {series && series.length > 0 && (
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Series (optional)
              <select
                name="seriesId"
                defaultValue={book.series_id ?? ""}
                className="rounded-lg border border-border bg-surface px-3 py-2"
              >
                <option value="">None</option>
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Position
              <input
                name="seriesPosition"
                type="number"
                min="1"
                step="1"
                defaultValue={book.series_position ?? ""}
                placeholder="1"
                className="w-24 rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>
          </div>
        )}

        <label className="flex flex-col gap-1 text-sm">
          Price (USD)
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={(book.price_cents / 100).toFixed(2)}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
          <span className="text-xs text-muted">
            Librum takes a {PLATFORM_FEE_PERCENT}% platform fee — you keep
            the rest of every sale.
          </span>
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {coverUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverUrl}
              alt=""
              className="h-24 w-16 rounded object-cover"
            />
          )}
          <label className="flex flex-col gap-1 text-sm">
            Replace cover image (JPG or PNG, up to 5MB)
            <input
              name="cover"
              type="file"
              accept="image/png,image/jpeg"
              className="text-sm"
            />
            <span className="text-xs text-muted">
              Leave blank to keep the current cover.
            </span>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Replace manuscript (EPUB file, up to 50MB)
          {manuscriptName && (
            <span className="text-xs text-muted">
              Current file: {manuscriptName}
            </span>
          )}
          <input
            name="manuscript"
            type="file"
            accept=".epub,application/epub+zip"
            className="text-sm"
          />
          <span className="text-xs text-muted">
            Leave blank to keep the current manuscript.
          </span>
        </label>

        <button
          type="submit"
          className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Save changes
        </button>
      </form>
    </main>
  );
}
