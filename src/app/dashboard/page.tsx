import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { publishBook, unpublishBook, deleteBook } from "./books/actions";
import { getPublishChecklist } from "@/lib/publish-checklist";
import type { Book } from "@/lib/types";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_payouts_enabled")
    .eq("id", user!.id)
    .single();

  const { data: books } = await supabase
    .from("books")
    .select("*")
    .eq("author_id", user!.id)
    .order("created_at", { ascending: false })
    .returns<Book[]>();

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-3xl font-semibold">Your books</h1>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/sales"
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-hover"
          >
            Sales
          </Link>
          <Link
            href="/dashboard/discounts"
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-hover"
          >
            Discounts
          </Link>
          <Link
            href="/dashboard/series"
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-hover"
          >
            Series
          </Link>
          <Link
            href="/dashboard/profile"
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-hover"
          >
            Profile
          </Link>
          <Link
            href="/dashboard/payouts"
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-hover"
          >
            Payouts
          </Link>
          <Link
            href="/dashboard/books/new"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Add new book
          </Link>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {success && (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {success}
        </p>
      )}

      {!profile?.stripe_payouts_enabled && (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You need to{" "}
          <Link href="/dashboard/payouts" className="font-medium underline">
            connect a payout account
          </Link>{" "}
          before you can publish a book.
        </p>
      )}

      {!books || books.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          <p>You haven&apos;t added any books yet.</p>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-border">
          {books.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path)
                  .data.publicUrl
              : null;

            const incompleteChecklist =
              book.status === "draft"
                ? getPublishChecklist(book).filter((item) => !item.done)
                : [];

            return (
              <li
                key={book.id}
                className="py-4"
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
              >
                <div className="flex flex-wrap items-center gap-4">
                  {coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={coverUrl}
                      alt=""
                      className="h-16 w-11 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-16 w-11 shrink-0 rounded bg-border" />
                  )}

                  <div className="min-w-32 flex-1">
                    <p className="font-serif font-medium">{book.title}</p>
                    <p className="text-sm text-muted capitalize">
                      {book.status}
                    </p>
                  </div>

                  <span className="text-sm font-semibold text-primary">
                    ${(book.price_cents / 100).toFixed(2)}
                  </span>

                  <Link
                    href={`/dashboard/books/${book.id}/edit`}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                  >
                    Edit
                  </Link>

                  {book.status === "draft" ? (
                    <form action={publishBook.bind(null, book.id)}>
                      <button
                        type="submit"
                        className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                      >
                        Publish
                      </button>
                    </form>
                  ) : (
                    <form action={unpublishBook.bind(null, book.id)}>
                      <button
                        type="submit"
                        className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                      >
                        Unpublish
                      </button>
                    </form>
                  )}

                  <form action={deleteBook.bind(null, book.id)}>
                    <button
                      type="submit"
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </form>
                </div>

                {incompleteChecklist.length > 0 && (
                  <details className="w-full rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-xs text-muted">
                    <summary className="cursor-pointer font-medium">
                      {incompleteChecklist.length}{" "}
                      {incompleteChecklist.length === 1 ? "thing" : "things"}{" "}
                      to consider before publishing
                    </summary>
                    <ul className="mt-2 flex flex-col" style={{ gap: "0.25rem" }}>
                      {incompleteChecklist.map((item) => (
                        <li key={item.label}>&middot; {item.label}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
