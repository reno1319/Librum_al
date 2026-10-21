import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateBundle } from "../../actions";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { MAXIMUM_CATALOG_PRICE_ALL, MINIMUM_PAID_CATALOG_PRICE_ALL } from "@/lib/catalog-price";
import type { Book, Bundle } from "@/lib/types";
import type { Metadata } from "next";

// LIBRUM 2.0 SEO-1: static title, same reasoning as the book-edit route
// -- avoids a metadata-only query and its own auth/ownership check for
// a private authenticated page.
export const metadata: Metadata = {
  title: "Edit bundle",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see the exhaustive
// route audit (bundles.price_all is rendered for editing below).
export const dynamic = "force-dynamic";

export default async function EditBundlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive page -- renders
  // bundles.price_all for editing (exhaustive route audit) -- checked
  // as the first statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // ALL-WIRING-5: only the columns this form uses. The legacy
  // `price_cents` is not fetched, so it cannot be prefilled into the
  // price field and saved back as if it were lek.
  const { data: bundle } = await supabase
    .from("bundles")
    .select("id, author_id, title, description, price_all, pen_name_id")
    .eq("id", id)
    .single<Pick<Bundle, "id" | "author_id" | "title" | "description" | "price_all" | "pen_name_id">>();

  if (!bundle || bundle.author_id !== user.id) {
    notFound();
  }

  const { data: publishedBooks } = await supabase
    .from("books")
    .select("id, title, pen_name_id")
    .eq("author_id", user.id)
    .eq("status", "published")
    .order("title")
    .returns<Pick<Book, "id" | "title" | "pen_name_id">[]>();

  const { data: currentBookRows } = await supabase
    .from("bundle_books")
    .select("book_id")
    .eq("bundle_id", id);

  const currentBookIds = new Set((currentBookRows ?? []).map((r) => r.book_id));

  // PEN-NAMES-1 (11a): only books of the bundle's pen name are offered
  // (plus any current member, so an older mixed bundle can be fixed by
  // unticking; saving a mixed set is refused with a clear message).
  const books = (publishedBooks ?? []).filter(
    (book) => !bundle.pen_name_id || book.pen_name_id === bundle.pen_name_id || currentBookIds.has(book.id),
  );
  const { data: bundlePenName } = bundle.pen_name_id
    ? await supabase
        .from("pen_names")
        .select("name")
        .eq("id", bundle.pen_name_id)
        .eq("author_id", user.id)
        .maybeSingle<{ name: string }>()
    : { data: null };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
      <Link href="/dashboard/bundles" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to bundles
      </Link>

      <div className="mt-2">
        <PageHeader title="Edit bundle" />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
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
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Description (optional)
          <textarea
            name="description"
            rows={3}
            defaultValue={bundle.description}
            className={formControlClasses}
          />
        </label>

        {/* ALL-WIRING-5: whole lek. A bundle with no ALL price opens
            with an EMPTY field -- never a value derived from the legacy
            USD column -- so saving the form requires the author to
            supply one. */}
        <label className="flex flex-col gap-1 text-sm">
          Bundle price (ALL)
          <input
            name="price"
            type="text"
            inputMode="decimal"
            required
            defaultValue={bundle.price_all == null ? "" : String(bundle.price_all)}
            className={`w-40 ${formControlClasses}`}
          />
          <span className="text-sm text-muted">
            Whole lek: 0 for a free bundle, or {MINIMUM_PAID_CATALOG_PRICE_ALL} to{" "}
            {MAXIMUM_CATALOG_PRICE_ALL}.
          </span>
        </label>

        <fieldset>
          <legend className="text-sm">
            Books in this bundle{bundlePenName ? ` (${bundlePenName.name})` : ""}
          </legend>
          <div className="mt-2 flex flex-col gap-2 rounded-card border border-border p-3">
            {books.map((book) => (
              <label key={book.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="bookIds"
                  value={book.id}
                  defaultChecked={currentBookIds.has(book.id)}
                  className="focus-ring"
                />
                {book.title}
              </label>
            ))}
          </div>
          <span className="text-sm text-muted">
            Choose at least 2. A bundle holds books of one pen name only.
          </span>
        </fieldset>

        <button type="submit" className={buttonClasses("primary", "md", "mt-2 w-fit")}>
          Save changes
        </button>
      </form>
    </main>
  );
}
