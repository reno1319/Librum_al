import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { BookCard } from "@/components/book-card";
import { orderSeriesBooks } from "@/lib/series-order";
import { authorPagePath, type PenNameRef } from "@/lib/pen-names";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import type { PublicBook } from "@/lib/types";

// LIBRUM 2.0 PRODUCT-3: the public series page didn't exist before this
// pass -- see the PRODUCT-3 audit (no /series/[id] route, no series
// links anywhere pointed at one). A pure discovery surface, entirely
// public and entirely without user-specific state: unlike Book Detail
// or the author page, a series itself has no ownership/purchase/follow
// concept of its own, so this never calls getUser() or touches any
// per-visitor data -- BookCard already renders each book's real price
// with no purchase logic attached.

// PEN-NAMES-1 (migration 20261019184512): a series belongs to one pen
// name (11a); its byline is that pen name, embedded from the
// public_pen_names view as `pen`, linking to /authors/<pen name id>.
type PublicSeries = {
  id: string;
  title: string;
  pen: PenNameRef | null;
};

type PublicSeriesPageData = {
  series: PublicSeries;
  books: PublicBook[];
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see the exhaustive
// route audit (getPublicSeriesPageData selects books.* below, including
// price_all, even though BookCard is the only render site that
// actually displays it).
export const dynamic = "force-dynamic";

// LIBRUM 2.0 PRODUCT-3 PRE-COMMIT CORRECTION: originally two separate
// concerns -- a cached series-row fetch, plus the page component's own
// separate published-books query and its own separate "zero books ->
// notFound()" check -- which let generateMetadata() (which only ever
// saw the series row) expose a zero-published series' title/author/SEO
// description even though the page body itself correctly 404s for that
// exact series. PRODUCT-3's own chosen rule is that a series with zero
// published books is NOT public; metadata disagreeing with the page
// about what's public is the actual defect this correction closes.
//
// Fixed by collapsing "is this series publicly visible, and if so what
// is its content" into ONE cached fetcher that both generateMetadata()
// and the page component call with the same id -- mirrors the
// getBookForDetail/getPublicAuthor pattern (Book Detail, Author Page),
// just resolving to null for BOTH "no such series" and "series exists
// but has no public content" instead of only the former. Because this
// is wrapped in React.cache(), calling it from both generateMetadata()
// and the page component within the same request still only runs its
// two queries once each -- not once per caller. The profiles join
// stays narrow (never `profiles(*)`) -- AUTHOR-1C: it now targets the
// safe public_author_profiles view rather than the base table, so
// there is no display_name/Stripe/private profile column to even
// accidentally select here any more. PEN-NAMES-1: the join is now the
// series' pen name (public_pen_names view) instead.
const getPublicSeriesPageData = cache(
  async (id: string): Promise<PublicSeriesPageData | null> => {
    const supabase = await createClient();

    // PEN-NAMES-2: public_series (no account column).
    const { data: series } = await supabase
      .from("public_series")
      .select("id, title, pen:public_pen_names(id, name)")
      .eq("id", id)
      .single<PublicSeries>();

    if (!series) {
      return null;
    }

    // The only other query a valid request needs -- one round trip,
    // regardless of how many books the series has. Published only, same
    // rule every other public book-listing surface in this app applies.
    // ALL-WIRING-2: `.not("price_all", "is", null)` joins the
    // published-only rule for the same reason it exists -- a series page
    // is a discovery surface (this file's own comment below says so),
    // and a book with no authored ALL price is not ALL-ready: neither
    // free nor purchasable. Consequence worth stating: a series whose
    // books are ALL unpriced now has no public content and renders as
    // not-found, exactly as a series with zero published books already
    // did.
    const { data: booksRaw } = await supabase
      .from("public_books")
      .select("*")
      .eq("series_id", id)
      .eq("status", "published")
      .not("price_all", "is", null)
      .returns<PublicBook[]>();

    const books = orderSeriesBooks(booksRaw ?? []);

    // LIBRUM 2.0 PRODUCT-3: deliberate choice, audited and reported, not
    // an accident -- a series page is a discovery surface, not an
    // author profile. A series with zero published books has no public
    // content at all, so BOTH metadata and the page body treat it as
    // not public (unlike the author page, which intentionally keeps an
    // author's own profile valid even with zero books).
    if (books.length === 0) {
      return null;
    }

    return { series, books };
  },
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  // ALL-CUTOVER APP-A: no series-specific metadata (and no Supabase call
  // via getPublicSeriesPageData, which selects books.price_all) while
  // maintenance is active -- the same {} fallback this function already
  // uses for a missing/not-public series.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return {};
  }

  const { id } = await params;
  const data = await getPublicSeriesPageData(id);

  // Covers "no such series" and "series exists but nothing public in
  // it" identically -- neither ever gets series-specific title/
  // description. Falls back to the root layout's generic site metadata,
  // same as every other not-found path in this app.
  if (!data) {
    return {};
  }

  const authorName = data.series.pen?.name ?? null;
  return {
    title: data.series.title,
    description: authorName
      ? `Books in the ${data.series.title} series by ${authorName} on Librum.`
      : `Books in the ${data.series.title} series on Librum.`,
  };
}

export default async function SeriesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive page -- renders books.price_all
  // via BookCard (exhaustive route audit) -- checked as the first
  // statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const data = await getPublicSeriesPageData(id);

  if (!data) {
    notFound();
  }

  const { series, books } = data;
  // Local URL construction only (no network call) -- same reasoning
  // Book Detail's own generateMetadata() already relies on for reusing
  // a client purely for getPublicUrl() without a second `books` fetch.
  const supabase = await createClient();

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      {/* ============================================================
          Series hero -- title, author attribution, book count. No
          description field exists on this schema (series has only id/
          author_id/title/created_at -- see schema.sql), so none is
          invented or derived from book descriptions.
          ============================================================ */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Series</p>
      <h1 className="mt-1 font-serif text-3xl font-normal text-foreground sm:text-4xl">
        {series.title}
      </h1>
      {series.pen && (
        <p className="mt-2 text-sm text-muted">
          by{" "}
          <Link
            href={authorPagePath(series.pen.id)}
            className="focus-ring rounded-sm font-medium text-foreground hover:underline"
          >
            {series.pen.name}
          </Link>
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        {books.length} book{books.length === 1 ? "" : "s"}
      </p>

      {/* ============================================================
          Books in this series -- ordered, with each book's canonical
          series position surfaced above its cover rather than left
          implicit in grid order alone. `null`/unpositioned books never
          get a fabricated number -- "In this series" instead, per the
          PRODUCT-3 brief.
          ============================================================ */}
      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-normal">Books in this series</h2>
        <ol className="mt-6 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {books.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
              : null;
            const positionLabel =
              book.series_position != null ? `Book ${book.series_position}` : "In this series";

            return (
              <li key={book.id}>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  {positionLabel}
                </p>
                {/* No authorName -- every book on this page shares the
                    same one pen name (11a), already named in the hero
                    above. */}
                <BookCard book={book} coverUrl={coverUrl} />
              </li>
            );
          })}
        </ol>
      </section>
    </main>
  );
}
