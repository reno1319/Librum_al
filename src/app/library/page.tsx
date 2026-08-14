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
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold">Your library</h1>

      {!purchases || purchases.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          You haven&apos;t bought any books yet.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-border">
          {purchases.map(({ books: book }) =>
            book ? (
              <li
                key={book.id}
                className="flex flex-wrap items-center justify-between gap-3 py-4"
              >
                <Link
                  href={`/books/${book.id}`}
                  className="font-serif font-medium hover:underline"
                >
                  {book.title}
                </Link>
                <a
                  href={`/api/books/${book.id}/download`}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
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
