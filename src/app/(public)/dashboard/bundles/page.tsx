import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  createBundle,
  publishBundle,
  unpublishBundle,
} from "./actions";
import { DeleteBundleButton } from "./delete-bundle-button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import {
  MAXIMUM_CATALOG_PRICE_ALL,
  MINIMUM_PAID_CATALOG_PRICE_ALL,
  formatCatalogPriceLabel,
  groupAllDigits,
} from "@/lib/catalog-price";
import type { Book, Bundle } from "@/lib/types";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Paketat",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see the exhaustive
// route audit (bundles.price_all is rendered in the bundle list below).
export const dynamic = "force-dynamic";

// ALBANIAN-10: the stored status stays English; this is what the author reads.
function bundleStatusLabel(status: string): string {
  if (status === "published") return "E publikuar";
  if (status === "draft") return "Draft";
  return status;
}

export default async function BundlesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; pen?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive page -- renders bundles.price_all
  // in the bundle list (exhaustive route audit) -- checked as the first
  // statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { error: rawError, success: rawSuccess, pen } = await searchParams;

  const error = pageErrorMessage(rawError);

  const success = pageSuccessMessage(rawSuccess);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/bundles");
  }

  const [{ data: publishedBooks }, { data: penNames }] = await Promise.all([
    supabase
      .from("books")
      .select("id, title, pen_name_id")
      .eq("author_id", user.id)
      .eq("status", "published")
      .order("title")
      .returns<Pick<Book, "id" | "title" | "pen_name_id">[]>(),
    supabase
      .from("pen_names")
      .select("id, name, is_default")
      .eq("author_id", user.id)
      .order("is_default", { ascending: false })
      .order("created_at")
      .returns<{ id: string; name: string; is_default: boolean }[]>(),
  ]);

  // PEN-NAMES-1 (11a): a bundle holds books of one pen name only, so the
  // form offers the books of ONE pen name at a time -- chosen with ?pen=
  // when the author has published books under more than one.
  const penNamesWithBooks = (penNames ?? []).filter((p) =>
    (publishedBooks ?? []).some((b) => b.pen_name_id === p.id),
  );
  const chosenPenName =
    penNamesWithBooks.find((p) => p.id === pen) ??
    penNamesWithBooks.find((p) => (publishedBooks ?? []).filter((b) => b.pen_name_id === p.id).length >= 2) ??
    penNamesWithBooks[0] ??
    null;
  const books = chosenPenName
    ? (publishedBooks ?? []).filter((b) => b.pen_name_id === chosenPenName.id)
    : (publishedBooks ?? []);

  // ALL-WIRING-5: every one of the author's bundles, priced or not, and
  // deliberately NOT filtered on price_all -- this list is where an
  // author finds a bundle with no ALL price and repairs it. Only the
  // columns rendered are selected, so the legacy `price_cents` is not
  // fetched at all.
  const { data: bundles } = await supabase
    .from("bundles")
    .select("id, title, status, price_all")
    .eq("author_id", user.id)
    .order("created_at", { ascending: false })
    .returns<Pick<Bundle, "id" | "title" | "status" | "price_all">[]>();

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
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Kthehuni te paneli
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Paketat"
          description="Bashkoni dy ose më shumë nga librat tuaj të publikuar në një blerje të vetme me zbritje: një pagesë hap çdo libër të paketës."
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

      {penNamesWithBooks.length > 1 && (
        <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Pseudonimi
            <select name="pen" defaultValue={chosenPenName?.id} className={formControlClasses}>
              {penNamesWithBooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClasses("outline", "md", "w-fit")}>
            Shfaqni librat
          </button>
          <span className="basis-full text-sm text-muted">
            Një paketë mban vetëm libra me të njëjtin pseudonim.
          </span>
        </form>
      )}

      {books.length < 2 ? (
        <EmptyState
          className="mt-6"
          title={
            penNamesWithBooks.length > 1
              ? "Ju duhen të paktën 2 libra të publikuar me këtë pseudonim për të krijuar një paketë."
              : "Ju duhen të paktën 2 libra të publikuar para se të krijoni një paketë."
          }
        />
      ) : (
        <form
          action={createBundle}
          className="mt-6 flex flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-sm"
        >
          {chosenPenName && <input type="hidden" name="penNameId" value={chosenPenName.id} />}
          <label className="flex flex-col gap-1 text-sm">
            Titulli i paketës
            <input
              name="title"
              type="text"
              required
              placeholder="p.sh. Koleksioni i plotë"
              className={formControlClasses}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Përshkrimi (opsional)
            <textarea name="description" rows={3} className={formControlClasses} />
          </label>

          {/* ALL-WIRING-5: whole lek, parsed server-side by
              parseCatalogPriceAll. A text input with a decimal keyboard,
              as on the book forms: `type="number"` cannot submit the
              accepted "99,00" form at all. */}
          <label className="flex flex-col gap-1 text-sm">
            Çmimi i paketës (lekë)
            <input
              name="price"
              type="text"
              inputMode="decimal"
              required
              className={`w-40 ${formControlClasses}`}
            />
            <span className="text-sm text-muted">
              Lekë të plota: 0 për paketë falas, ose nga {MINIMUM_PAID_CATALOG_PRICE_ALL} deri në{" "}
              {groupAllDigits(MAXIMUM_CATALOG_PRICE_ALL)}.
            </span>
          </label>

          <fieldset>
            <legend className="text-sm">
              Librat në këtë paketë
              {penNamesWithBooks.length > 1 && chosenPenName ? ` (${chosenPenName.name})` : ""}
            </legend>
            <div className="mt-2 flex flex-col gap-2 rounded-card border border-border p-3">
              {books.map((book) => (
                <label key={book.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="bookIds" value={book.id} className="focus-ring" />
                  {book.title}
                </label>
              ))}
            </div>
            <span className="text-sm text-muted">Zgjidhni të paktën 2.</span>
          </fieldset>

          <button type="submit" className={buttonClasses("primary", "md", "w-fit")}>
            Krijoni paketën
          </button>
        </form>
      )}

      <ul className="mt-8 flex flex-col gap-3">
        {(bundles ?? []).map((bundle) => (
          <li
            key={bundle.id}
            className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface p-4 shadow-sm"
          >
            <div className="flex-[1_1_12rem]">
              <p className="font-medium">
                {bundle.title}{" "}
                <span className="text-muted">
                  · {formatCatalogPriceLabel(bundle.price_all)}
                </span>
              </p>
              <p className="text-xs text-muted">
                {bundleStatusLabel(bundle.status)} · {bookCountByBundle.get(bundle.id) ?? 0}{" "}
                {(bookCountByBundle.get(bundle.id) ?? 0) === 1 ? "libër" : "libra"}
              </p>
            </div>
            <Link href={`/dashboard/bundles/${bundle.id}/edit`} className={buttonClasses("outline", "sm")}>
              Ndryshoni
            </Link>
            {bundle.status === "draft" ? (
              <form action={publishBundle.bind(null, bundle.id)}>
                <button type="submit" className={buttonClasses("outline", "sm")}>
                  Publikoni
                </button>
              </form>
            ) : (
              <form action={unpublishBundle.bind(null, bundle.id)}>
                <button type="submit" className={buttonClasses("outline", "sm")}>
                  Hiqeni nga publikimi
                </button>
              </form>
            )}
            {/* BUNDLE-DELETE-SAFETY-1: asks for confirmation naming this
                row's exact title before deleteBundle runs for this row's id. */}
            <DeleteBundleButton bundleId={bundle.id} title={bundle.title} status={bundle.status} />
          </li>
        ))}
        {(bundles ?? []).length === 0 && (
          <li>
            <EmptyState description="Ende nuk keni asnjë paketë." />
          </li>
        )}
      </ul>
    </main>
  );
}
