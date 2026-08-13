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
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-3xl font-semibold">Discover ebooks</h1>
      <p className="mt-2 text-gray-600">
        Independently published, straight from the author.
      </p>

      {!books || books.length === 0 ? (
        <p className="mt-12 rounded-md border border-dashed border-gray-300 px-6 py-16 text-center text-gray-500">
          No books have been published yet. Check back soon.
        </p>
      ) : (
        <ul className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4">
          {books.map((book) => (
            <li key={book.id} className="flex flex-col gap-2">
              <div className="aspect-[2/3] w-full rounded-md bg-gray-100" />
              <span className="text-sm font-medium">{book.title}</span>
              <span className="text-xs text-gray-500">
                {book.profiles?.display_name}
              </span>
              <span className="text-sm font-semibold">
                ${(book.price_cents / 100).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
