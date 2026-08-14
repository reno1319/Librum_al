import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { publishBook, unpublishBook, deleteBook } from "./books/actions";
import type { Book } from "@/lib/types";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: books } = await supabase
    .from("books")
    .select("*")
    .eq("author_id", user!.id)
    .order("created_at", { ascending: false })
    .returns<Book[]>();

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your books</h1>
        <Link
          href="/dashboard/books/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Add new book
        </Link>
      </div>

      {!books || books.length === 0 ? (
        <div className="mt-8 rounded-md border border-dashed border-gray-300 px-6 py-16 text-center text-gray-500">
          <p>You haven&apos;t added any books yet.</p>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-gray-200">
          {books.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path)
                  .data.publicUrl
              : null;

            return (
              <li key={book.id} className="flex items-center gap-4 py-4">
                {coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={coverUrl}
                    alt=""
                    className="h-16 w-11 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-16 w-11 shrink-0 rounded bg-gray-100" />
                )}

                <div className="flex-1">
                  <p className="font-medium">{book.title}</p>
                  <p className="text-sm text-gray-500 capitalize">{book.status}</p>
                </div>

                <span className="text-sm font-semibold">
                  ${(book.price_cents / 100).toFixed(2)}
                </span>

                {book.status === "draft" ? (
                  <form action={publishBook.bind(null, book.id)}>
                    <button
                      type="submit"
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                    >
                      Publish
                    </button>
                  </form>
                ) : (
                  <form action={unpublishBook.bind(null, book.id)}>
                    <button
                      type="submit"
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                    >
                      Unpublish
                    </button>
                  </form>
                )}

                <form action={deleteBook.bind(null, book.id)}>
                  <button
                    type="submit"
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                  >
                    Delete
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
