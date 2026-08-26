import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AuthorBookRow } from "@/components/author-book-row";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-6: the full author book list -- what the Dashboard
// overview's "View all books" links to, since its own list is capped
// at the 5 most recent. Inherits the author-role guard from
// dashboard/layout.tsx (untouched). Deliberately no overview metrics,
// no Sales/Payouts/Tools here -- this route is management-only, one
// job: see and act on every book you have.
export default async function AllBooksPage() {
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

  const allBooks = books ?? [];

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader
          title="All books"
          description="Manage your drafts and published books."
          actions={
            <Link href="/dashboard/books/new" className={buttonClasses("primary", "md")}>
              New book
            </Link>
          }
        />
      </div>

      {allBooks.length === 0 ? (
        <EmptyState
          className="mt-8"
          title="You haven't added any books yet."
          action={
            <Link href="/dashboard/books/new" className={buttonClasses("primary", "md")}>
              New book
            </Link>
          }
        />
      ) : (
        <ul className="mt-8 divide-y divide-border">
          {allBooks.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
              : null;
            return <AuthorBookRow key={book.id} book={book} coverUrl={coverUrl} />;
          })}
        </ul>
      )}
    </main>
  );
}
