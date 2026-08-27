import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { BookCard } from "@/components/book-card";
import { orderSeriesBooks } from "@/lib/series-order";
import type { Book, Profile } from "@/lib/types";

// LIBRUM 2.0 PRODUCT-3: the public series page didn't exist before this
// pass -- see the PRODUCT-3 audit (no /series/[id] route, no series
// links anywhere pointed at one). A pure discovery surface, entirely
// public and entirely without user-specific state: unlike Book Detail
// or the author page, a series itself has no ownership/purchase/follow
// concept of its own, so this never calls getUser() or touches any
// per-visitor data -- BookCard already renders each book's real price
// with no purchase logic attached.

type PublicSeries = {
  id: string;
  title: string;
  author_id: string;
  profiles: Pick<Profile, "display_name"> | null;
};

type PublicSeriesPageData = {
  series: PublicSeries;
  books: Book[];
};

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
// two queries once each -- not once per caller. `profiles(display_name)`
// stays narrow (never `profiles(*)`), same discipline as the author
// page's own getPublicAuthor -- no Stripe/private profile columns ride
// along on the join.
const getPublicSeriesPageData = cache(
  async (id: string): Promise<PublicSeriesPageData | null> => {
    const supabase = await createClient();

    const { data: series } = await supabase
      .from("series")
      .select("id, title, author_id, profiles(display_name)")
      .eq("id", id)
      .single<PublicSeries>();

    if (!series) {
      return null;
    }

    // The only other query a valid request needs -- one round trip,
    // regardless of how many books the series has. Published only, same
    // rule every other public book-listing surface in this app applies.
    const { data: booksRaw } = await supabase
      .from("books")
      .select("*")
      .eq("series_id", id)
      .eq("status", "published")
      .returns<Book[]>();

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
  const { id } = await params;
  const data = await getPublicSeriesPageData(id);

  // Covers "no such series" and "series exists but nothing public in
  // it" identically -- neither ever gets series-specific title/
  // description. Falls back to the root layout's generic site metadata,
  // same as every other not-found path in this app.
  if (!data) {
    return {};
  }

  const authorName = data.series.profiles?.display_name;
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
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      {/* ============================================================
          Series hero -- title, author attribution, book count. No
          description field exists on this schema (series has only id/
          author_id/title/created_at -- see schema.sql), so none is
          invented or derived from book descriptions.
          ============================================================ */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Series</p>
      <h1 className="mt-1 font-serif text-3xl font-semibold text-foreground sm:text-4xl">
        {series.title}
      </h1>
      {series.profiles?.display_name && (
        <p className="mt-2 text-sm text-muted">
          by{" "}
          <Link
            href={`/authors/${series.author_id}`}
            className="focus-ring rounded-sm font-medium text-foreground hover:underline"
          >
            {series.profiles.display_name}
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
        <h2 className="font-serif text-xl font-semibold">Books in this series</h2>
        <ol className="mt-6 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
                    same one author, already named in the hero above. */}
                <BookCard book={book} coverUrl={coverUrl} />
              </li>
            );
          })}
        </ol>
      </section>
    </main>
  );
}
