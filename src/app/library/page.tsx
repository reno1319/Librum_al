import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Book } from "@/lib/types";

type PurchaseWithBook = {
  book_id: string;
  amount_cents: number;
  created_at: string;
  books: Book | null;
};

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
    .select("book_id, amount_cents, created_at, books(*)")
    .eq("reader_id", user.id)
    .order("created_at", { ascending: false })
    .returns<PurchaseWithBook[]>();

  const allPurchases = purchases ?? [];
  const totalSpentCents = allPurchases.reduce((sum, p) => sum + p.amount_cents, 0);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold">Your library</h1>
      <p className="mt-1 text-sm text-muted">
        Everything you&apos;ve bought, with purchase details.
      </p>

      {allPurchases.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          You haven&apos;t bought any books yet.
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm text-muted">
            Total spent:{" "}
            <span className="font-semibold text-primary">
              ${(totalSpentCents / 100).toFixed(2)}
            </span>
          </p>

          <ul className="mt-4 divide-y divide-border">
            {allPurchases.map((purchase) =>
              purchase.books ? (
                <li
                  key={purchase.book_id}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div>
                    <Link
                      href={`/books/${purchase.book_id}`}
                      className="font-serif font-medium hover:underline"
                    >
                      {purchase.books.title}
                    </Link>
                    <p className="text-xs text-muted">
                      Purchased{" "}
                      {new Date(purchase.created_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      · ${(purchase.amount_cents / 100).toFixed(2)}
                    </p>
                  </div>
                  <a
                    href={`/api/books/${purchase.book_id}/download`}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                  >
                    Download EPUB
                  </a>
                </li>
              ) : null,
            )}
          </ul>
        </>
      )}
    </main>
  );
}
