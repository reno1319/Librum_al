import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createSeries, deleteSeries } from "./actions";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
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

  const [{ data: series }, { data: penNames }] = await Promise.all([
    supabase
      .from("series")
      .select("*")
      .eq("author_id", user.id)
      .order("created_at", { ascending: false })
      .returns<Series[]>(),
    // PEN-NAMES-1 (11a): the author's own pen names, default first, for
    // the new series' pen name and each series' label.
    supabase
      .from("pen_names")
      .select("id, name, is_default")
      .eq("author_id", user.id)
      .order("is_default", { ascending: false })
      .order("created_at")
      .returns<{ id: string; name: string; is_default: boolean }[]>(),
  ]);
  const penNameById = new Map((penNames ?? []).map((p) => [p.id, p.name]));

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
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Series"
          description="Create a series here, then assign each book to it (and set its reading order) from the book's edit page. All books in a series use the series' pen name."
        />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      <form
        action={createSeries}
        className="mt-6 flex flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-sm sm:flex-row sm:items-end"
      >
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Series title
          <input
            name="title"
            type="text"
            required
            placeholder="e.g. The Ashfall Trilogy"
            className={formControlClasses}
          />
        </label>
        {/* PEN-NAMES-1 (11a): every book in the series must use this
            pen name. Shown only when the author has more than one. */}
        {(penNames ?? []).length > 1 && (
          <label className="flex flex-col gap-1 text-sm">
            Pen name
            <select name="penNameId" defaultValue={penNames![0].id} className={formControlClasses}>
              {penNames!.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className={buttonClasses("primary", "md", "w-fit")}>
          Create series
        </button>
      </form>

      <ul className="mt-8 flex flex-col gap-3">
        {(series ?? []).map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-sm"
          >
            <div>
              <p className="font-medium">{s.title}</p>
              <p className="text-xs text-muted">
                {counts.get(s.id) ?? 0}{" "}
                {(counts.get(s.id) ?? 0) === 1 ? "book" : "books"}
                {(penNames ?? []).length > 1 && s.pen_name_id && penNameById.get(s.pen_name_id)
                  ? ` · ${penNameById.get(s.pen_name_id)}`
                  : ""}
              </p>
            </div>
            <form action={deleteSeries.bind(null, s.id)}>
              <button
                type="submit"
                className="focus-ring rounded-control border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </form>
          </li>
        ))}
        {(series ?? []).length === 0 && (
          <li>
            <EmptyState description="No series yet." />
          </li>
        )}
      </ul>
    </main>
  );
}
