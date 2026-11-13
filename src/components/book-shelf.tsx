import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BookCard } from "@/components/book-card";
import { resolveBookByline } from "@/lib/book-byline";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";

// LIBRUM 2.0 AUTHOR-1B / AUTHOR-1C: resolved here at the render boundary
// via resolvePublicAuthorName(), never a raw display_name read. BookCard
// itself is untouched: it only ever receives the already-resolved
// string, never a profile object. AUTHOR-1C: every caller now queries
// the safe public_author_profiles view (aliased as `profiles`), which
// physically has no display_name column -- dropped from this type too.
// PEN-NAMES-1: callers embed the book's pen name (BOOK_PEN_NAME_EMBED,
// public_pen_names view) as `pen`; that is the byline.
type BookWithAuthor = PublicBook & {
  pen: PenNameRef | null;
};
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export function BookShelf({
  title,
  books,
  supabase,
  inline = false,
  headingClassName,
  seeAllHref,
}: {
  title: string;
  books: BookWithAuthor[];
  supabase: SupabaseClient;
  // P1 book page (design B): the "More by" row inside "Rreth autorit" --
  // a small h3 heading and less space, under that section's own h2.
  inline?: boolean;
  // P1 book page: that page's own section heading look.
  headingClassName?: string;
  // Patch A: optional "Shiko të gjitha" link next to the heading.
  seeAllHref?: string;
}) {
  if (books.length === 0) return null;

  const Heading = inline ? "h3" : "h2";
  return (
    // REDESIGN STEP 3: A2 heading (thin green serif) and the restyled
    // BookCard, in the same sideways-scrolling row.
    <section style={{ marginTop: inline ? "1.75rem" : "3.5rem" }}>
      <div className="flex flex-wrap items-center justify-between gap-x-4">
      <Heading
        className={
          headingClassName ??
          (inline
            ? "text-[0.9375rem] font-semibold text-foreground"
            : "font-serif text-[1.75rem] font-normal leading-tight text-primary")
        }
      >
        {title}
      </Heading>
      {seeAllHref && (
        <Link
          href={seeAllHref}
          className="focus-ring inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
        >
          Shiko të gjitha &rarr;
        </Link>
      )}
      </div>
      <div
        className="overflow-x-auto pb-2"
        style={{ display: "flex", gap: inline ? "1rem" : "1.5rem", marginTop: inline ? "0.75rem" : "1.25rem" }}
      >
        {books.map((book) => {
          const coverUrl = book.cover_path
            ? supabase.storage.from("covers").getPublicUrl(book.cover_path)
                .data.publicUrl
            : null;

          return (
            <div
              key={book.id}
              style={{ width: inline ? "7.5rem" : "9rem", flexShrink: 0 }}
            >
              <BookCard
                book={book}
                coverUrl={coverUrl}
                authorName={resolveBookByline(book)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
