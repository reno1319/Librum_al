import { createClient } from "@/lib/supabase/server";
import { BookCard } from "@/components/book-card";
import type { Book, Profile } from "@/lib/types";

type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };
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
    <section style={{ marginTop: "3rem" }}>
      <h2 className="font-serif text-xl font-semibold">{title}</h2>
      <div
        className="overflow-x-auto pb-2"
        style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}
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
                authorName={book.profiles?.display_name}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
