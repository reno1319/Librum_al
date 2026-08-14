import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Book, Profile } from "@/lib/types";

type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };

export default async function Home() {
  const supabase = await createClient();
  const { data: books } = await supabase
    .from("books")
    .select("*, profiles(display_name)")
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .returns<BookWithAuthor[]>();

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Discover ebooks</h1>
      <p className="mt-2 text-muted">
        Independently published, straight from the author.
      </p>

      {!books || books.length === 0 ? (
        <p className="mt-12 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          No books have been published yet. Check back soon.
        </p>
      ) : (
        <ul className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4">
          {books.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path)
                  .data.publicUrl
              : null;

            return (
              <li key={book.id}>
                <Link href={`/books/${book.id}`} className="group flex flex-col gap-2">
                  {coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={coverUrl}
                      alt=""
                      className="aspect-[2/3] w-full rounded-lg object-cover shadow-sm transition-shadow group-hover:shadow-md"
                    />
                  ) : (
                    <div className="aspect-[2/3] w-full rounded-lg bg-border" />
                  )}
                  <span className="font-serif text-sm font-medium">
                    {book.title}
                  </span>
                  <span className="text-xs text-muted">
                    {book.profiles?.display_name}
                  </span>
                  <span className="text-sm font-semibold text-primary">
                    ${(book.price_cents / 100).toFixed(2)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
