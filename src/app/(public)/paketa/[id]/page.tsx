import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BookCard } from "@/components/book-card";
import { authorPagePath, type PenNameRef } from "@/lib/pen-names";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";
import {
  bundleCheckoutNotice,
  formatBundleSavingsAll,
  resolveBundleSavingsAll,
} from "@/lib/bundle-catalog";
import type { PublicBook, PublicBundle } from "@/lib/types";
import type { Metadata } from "next";
import { bundlePagePath, canonicalMetadata } from "@/lib/seo";

// LIBRUM 2.0 SEO-1: static title, not "<bundle title> | Librum" -- same
// reasoning as the author profile page (generateMetadata() can't see
// the page component's own already-fetched bundle without a second,
// metadata-only query or a React.cache() restructure, both out of
// scope here). Also sidesteps having to independently replicate the
// page's own unpublished/visibility gate just for a title.
//
// P2 (Renato 4b): plus the canonical /paketa/<id> link. Built from the
// address alone (no bundle query, so the page's own visibility gate
// stays the only one), and only for a well-formed id, so a malformed
// address never gets a canonical link echoing it.
const BUNDLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return {
    title: "Paketë",
    description: "Një paketë librash në Librum.",
    ...(BUNDLE_ID_PATTERN.test(id) ? canonicalMetadata(bundlePagePath(id.toLowerCase())) : {}),
  };
}

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see V3 §3.
export const dynamic = "force-dynamic";

// PEN-NAMES-1 (migration 20261019184512): a bundle belongs to one pen
// name (11a); its byline is that pen name, embedded from the
// public_pen_names view as `pen`, linking to /autore/<pen name id>.
//
// ALL-WIRING-5: the bundle's own columns are selected by name, and the
// legacy `price_cents` is not among them -- this page's price, its
// savings line and its checkout notice all come from `price_all`.
//
// PEN-NAMES-2: the bundle and its books come from public_bundles and
// public_books (no account columns); the author check is an own-row query.
type BundleWithAuthor = Pick<
  PublicBundle,
  "id" | "title" | "description" | "status" | "price_all"
> & {
  pen: PenNameRef | null;
};
type BundleBookRow = { book_id: string; books: PublicBook | null };

export default async function BundleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ purchase?: string; error?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive public bundle detail page
  // (V3 §3) -- checked as the first statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const { purchase, error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: bundle } = await supabase
    .from("public_bundles")
    .select(
      "id, title, description, status, price_all, pen:public_pen_names(id, name)",
    )
    .eq("id", id)
    .single<BundleWithAuthor>();

  // An own-row query: true only for the bundle's author.
  let isAuthor = false;
  if (user && bundle) {
    const { data: ownRow } = await supabase
      .from("bundles")
      .select("id")
      .eq("id", id)
      .eq("author_id", user.id)
      .maybeSingle();
    isAuthor = !!ownRow;
  }

  // ALL-WIRING-5: visibility is UNCHANGED and deliberately not keyed on
  // price. A published bundle with no ALL price stays reachable at its
  // own address -- it says "Price unavailable" and offers nothing -- and
  // is only dropped from the discovery rails (bookstore, author page).
  if (!bundle || (bundle.status !== "published" && !isAuthor)) {
    notFound();
  }

  const { data: bundleBookRows } = await supabase
    .from("bundle_books")
    // ALL-WIRING-2: a bundle's contents are DELIBERATELY unfiltered on
    // price_all. This list describes what a buyer would receive, so
    // dropping a member because its author has not set an ALL price
    // would misrepresent the bundle itself -- a correctness problem,
    // not a presentation one. Each card renders "Price unavailable" for
    // such a member, and bundle checkout is unconditionally closed
    // anyway, so nothing here offers an unpriced book for sale.
    .select("book_id, books:public_books(*)")
    .eq("bundle_id", id)
    .returns<BundleBookRow[]>();

  const books = (bundleBookRows ?? [])
    .map((row) => row.books)
    .filter((b): b is PublicBook => !!b);

  // ALL-WIRING-5: "bought separately" in whole lek, from `price_all`
  // only -- the bundle's and every member's. It is fed the UNFILTERED
  // membership rows, so a member this viewer cannot resolve counts as
  // an unknown price and withholds the comparison, rather than quietly
  // shrinking the total the bundle is compared against.
  const savings = formatBundleSavingsAll(
    resolveBundleSavingsAll(
      bundle.price_all,
      (bundleBookRows ?? []).map((row) => row.books),
    ),
  );

  // LAUNCH-1 P1-7A: per-book, via user_owns_book() (also excludes a
  // purchase whose payment intent has a dispute at status 'lost')
  // rather than a raw multi-book purchases select -- payment_disputes
  // is fully closed to this request-scoped client. This is a display
  // check, not a security boundary -- buyBundle and create_bundle_
  // checkout_snapshot independently re-verify.
  let ownsEverything = false;
  if (user && books.length > 0) {
    const ownershipChecks = await Promise.all(
      books.map((b) => supabase.rpc("user_owns_book", { target_book_id: b.id })),
    );
    ownsEverything = ownershipChecks.every((result) => !!result.data);
  }

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      <span className="text-xs uppercase tracking-wide text-muted">
        Paketë
      </span>
      <h1 className="font-serif text-3xl font-normal">{bundle.title}</h1>
      {bundle.pen && (
        <p className="mt-1 text-sm text-muted">
          nga{" "}
          <Link href={authorPagePath(bundle.pen.id)} className="hover:underline">
            {bundle.pen.name}
          </Link>
        </p>
      )}

      {bundle.description && (
        <p className="mt-4 max-w-[42.5rem] whitespace-pre-line text-foreground/90">
          {bundle.description}
        </p>
      )}

      {purchase === "success" && (
        <p className="mt-4 rounded-card bg-green-50 px-3 py-2 text-sm text-green-700">
          Blerja u krye. Faleminderit! Mund të duhen disa sekonda që librat
          të shfaqen më poshtë si tuajat.
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="text-xl font-semibold text-primary">
          {formatCatalogPriceLabel(bundle.price_all)}
        </span>
        {savings && (
          <span className="text-sm text-muted">
            <span className="line-through">{savings.originalTotal}</span>{" "}
            — kurseni {savings.savings}
          </span>
        )}

        {isAuthor ? (
          <span className="text-sm text-muted">Kjo është paketa juaj</span>
        ) : ownsEverything ? (
          <span className="rounded-control bg-surface-hover px-4 py-2 text-sm font-medium">
            I keni të gjithë librat e kësaj pakete
          </span>
        ) : (
          // STRIPE-DISABLE-1: bundle checkout is unavailable under every
          // configuration (locked product decision) -- a non-clickable
          // notice rather than a login link or a working buy form, since
          // acquiring a bundle isn't possible for anyone right now
          // regardless of auth state. buyBundle itself also
          // independently fails closed for a direct/stale POST.
          // ALL-WIRING-5: the wording follows the bundle's price_all --
          // "Not available right now" with no ALL price, otherwise a
          // neutral "coming soon" that is true of a free bundle too.
          // Neither branch renders a control.
          <span
            className="cursor-not-allowed rounded-control bg-surface-hover px-4 py-2 text-sm font-medium text-muted"
            aria-disabled="true"
          >
            {bundleCheckoutNotice(bundle.price_all)}
          </span>
        )}
      </div>

      <h2 className="mt-10 font-serif text-xl font-normal">
        {books.length} {books.length === 1 ? "libër" : "libra"} në këtë paketë
      </h2>
      {/* V1: exactly the Bookstore "All books" grid (bookstore/page.tsx),
          so a wide page adds columns instead of growing the cards. */}
      <ul className="mt-6 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {books.map((book) => {
          const coverUrl = book.cover_path
            ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data
                .publicUrl
            : null;

          return (
            <li key={book.id}>
              <BookCard book={book} coverUrl={coverUrl} />
            </li>
          );
        })}
      </ul>
    </main>
  );
}
