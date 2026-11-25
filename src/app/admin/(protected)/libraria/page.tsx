import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { GENRES } from "@/lib/genres";
import { MAX_CATEGORY_BUTTONS } from "@/lib/libraria-store";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { saveCategoryButtons } from "./actions";

export const metadata: Metadata = {
  title: "Libraria",
};

// LR1 patch 2 (lb5 a, lr2-3 a, lr2-4 b, lr2-5 b): staff (catalog.feature:
// owner and admin) choose up to 6 category buttons for Libraria's "Më
// të rinjtë në Librum" shelf, in order. Each chosen category shows even
// while it has no book. With none chosen the page shows the first 4
// categories with books, A–Zh.
const LOAD_ERROR = "Couldn’t load the category buttons. Please reload the page.";

export default async function AdminLibrariaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  await requireStaff("catalog.feature");
  const { error: rawError, success: rawSuccess } = await searchParams;
  const error = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);

  const supabase = await createClient();
  const { data, error: readError } = await supabase
    .from("libraria_category_buttons")
    .select("position, category")
    .order("position", { ascending: true })
    .returns<{ position: number; category: string }[]>();
  if (readError) console.error("Admin Libraria: failed to load the category buttons:", readError);
  const chosen = (data ?? []).map((r) => r.category);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to admin
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Libraria</h1>

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

      <section className="mt-6" aria-labelledby="category-buttons">
        <h2 id="category-buttons" className="font-serif text-xl font-semibold">
          Category buttons
        </h2>
        <p className="mt-1 text-sm text-muted">
          Up to {MAX_CATEGORY_BUTTONS} buttons under “Më të rinjtë në Librum”, in this order. Leave all empty to show
          the first 4 categories with books, A–Zh.
        </p>
        {readError ? (
          <Alert variant="error" className="mt-3">
            {LOAD_ERROR}
          </Alert>
        ) : (
          <form action={saveCategoryButtons} className="mt-4 flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-sm sm:p-5">
            <ol className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: MAX_CATEGORY_BUTTONS }, (_, i) => (
                <li key={i}>
                  <label className="flex flex-col gap-1 text-sm font-medium">
                    Button {i + 1}
                    <select
                      name={`slot${i + 1}`}
                      defaultValue={chosen[i] ?? ""}
                      className={`${formControlClasses} min-h-11`}
                    >
                      <option value="">None</option>
                      {GENRES.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
            </ol>
            <div>
              <button type="submit" className={buttonClasses("primary", "md", "min-h-11 rounded-full px-5")}>
                Save
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
