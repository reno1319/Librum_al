import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Book } from "@/lib/types";

type PurchaseWithBook = { book_id: string; books: Book | null };

export default async function LibraryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/library");
  }

  const { data: purchases } = await supabase
    .from("purchases")
    .select("book_id, books(*)")
    .eq("reader_id", user.id)
    .order("created_at", { ascending: false })
    .returns<PurchaseWithBook[]>();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold">Your library</h1>

      {!purchases || purchases.length === 0 ? (
        <p className="mt-8 rounded-md border border-dashed border-gray-300 px-6 py-16 text-center text-gray-500">
          You haven&apos;t bought any books yet.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-gray-200">
          {purchases.map(({ books: book }) =>
            book ? (
              <li
                key={book.id}
                className="flex items-center justify-between py-4"
              >
                <Link
                  href={`/books/${book.id}`}
                  className="font-medium hover:underline"
                >
                  {book.title}
                </Link>
                <a
                  href={`/api/books/${book.id}/download`}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  Download EPUB
                </a>
              </li>
            ) : null,
          )}
        </ul>
      )}
    </main>
  );
}
