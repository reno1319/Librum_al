import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createSeries, deleteSeries } from "./actions";
import type { Series } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Series",
};

export default async function SeriesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/series");
  }

  const { data: series } = await supabase
    .from("series")
    .select("*")
    .eq("author_id", user.id)
    .order("created_at", { ascending: false })
    .returns<Series[]>();

  const { data: booksInSeries } = await supabase
    .from("books")
    .select("series_id")
    .eq("author_id", user.id)
    .not("series_id", "is", null);

  const counts = new Map<string, number>();
  for (const b of booksInSeries ?? []) {
    if (b.series_id) counts.set(b.series_id, (counts.get(b.series_id) ?? 0) + 1);
  }

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Series</h1>
      <p className="mt-1 text-sm text-muted">
        Create a series here, then assign each book to it (and set its
        reading order) from the book&apos;s edit page.
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

      <form
        action={createSeries}
        className="mt-6 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-sm sm:flex-row sm:items-end"
      >
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Series title
          <input
            name="title"
            type="text"
            required
            placeholder="e.g. The Ashfall Trilogy"
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>
        <button
          type="submit"
          className="w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Create series
        </button>
      </form>

      <ul className="mt-8 flex flex-col gap-3">
        {(series ?? []).map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm"
          >
            <div>
              <p className="font-medium">{s.title}</p>
              <p className="text-xs text-muted">
                {counts.get(s.id) ?? 0}{" "}
                {(counts.get(s.id) ?? 0) === 1 ? "book" : "books"}
              </p>
            </div>
            <form action={deleteSeries.bind(null, s.id)}>
              <button
                type="submit"
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-surface-hover"
              >
                Delete
              </button>
            </form>
          </li>
        ))}
        {(series ?? []).length === 0 && (
          <p className="text-sm text-muted">No series yet.</p>
        )}
      </ul>
    </main>
  );
}
