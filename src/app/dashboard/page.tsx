import { createClient } from "@/lib/supabase/server";
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
      </div>

      {!books || books.length === 0 ? (
        <div className="mt-8 rounded-md border border-dashed border-gray-300 px-6 py-16 text-center text-gray-500">
          <p>You haven&apos;t added any books yet.</p>
          <p className="mt-1 text-sm">
            Book upload is coming in the next phase of this project.
          </p>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-gray-200">
          {books.map((book) => (
            <li key={book.id} className="flex items-center justify-between py-4">
              <div>
                <p className="font-medium">{book.title}</p>
                <p className="text-sm text-gray-500 capitalize">{book.status}</p>
              </div>
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
