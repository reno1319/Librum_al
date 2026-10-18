import { createClient } from "@/lib/supabase/server";
import { BookCard } from "@/components/book-card";
import { resolveBookByline } from "@/lib/book-byline";
import type { Book, Profile } from "@/lib/types";

// LIBRUM 2.0 AUTHOR-1B / AUTHOR-1C: resolved here at the render boundary
// via resolvePublicAuthorName(), never a raw display_name read. BookCard
// itself is untouched: it only ever receives the already-resolved
// string, never a profile object. AUTHOR-1C: every caller now queries
// the safe public_author_profiles view (aliased as `profiles`), which
// physically has no display_name column -- dropped from this type too.
// F4: the string is now the book's byline (its pen name, else the
// author's public name; resolveBookByline).
type BookWithAuthor = Book & {
  profiles: Pick<Profile, "public_author_name"> | null;
};
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export function BookShelf({
  title,
  books,
  supabase,
}: {
  title: string;
  books: BookWithAuthor[];
  supabase: SupabaseClient;
}) {
  if (books.length === 0) return null;

  return (
    // REDESIGN STEP 3: A2 heading (thin green serif) and the restyled
    // BookCard, in the same sideways-scrolling row.
    <section style={{ marginTop: "3.5rem" }}>
      <h2 className="font-serif text-[1.75rem] font-normal leading-tight text-primary">{title}</h2>
      <div
        className="overflow-x-auto pb-2"
        style={{ display: "flex", gap: "1.5rem", marginTop: "1.25rem" }}
      >
        {books.map((book) => {
          const coverUrl = book.cover_path
            ? supabase.storage.from("covers").getPublicUrl(book.cover_path)
                .data.publicUrl
            : null;

          return (
            <div
              key={book.id}
              style={{ width: "9rem", flexShrink: 0 }}
            >
              <BookCard
                book={book}
                coverUrl={coverUrl}
                authorName={resolveBookByline(book, book.profiles)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
