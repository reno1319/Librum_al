import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { removeFromWishlist } from "@/app/(public)/books/[id]/actions";
import { BookCard } from "@/components/book-card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { resolvePublicAuthorName } from "@/lib/author-name";
import type { Book, Profile } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wishlist",
  description: "Books you've saved to buy later on Librum.",
};

// LIBRUM 2.0 AUTHOR-1B / AUTHOR-1C: resolved via resolvePublicAuthorName().
// AUTHOR-1C moved this join onto the safe public_author_profiles VIEW
// (migration 045, aliased back to `profiles`), which physically has no
// display_name column.
type WishlistItemWithBook = {
  book_id: string;
  books: (Book & { profiles: Pick<Profile, "public_author_name"> | null }) | null;
};

export default async function WishlistPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/wishlist");
  }

  const { data: items } = await supabase
    .from("wishlist_items")
    .select("book_id, books(*, profiles:public_author_profiles(public_author_name))")
    .eq("reader_id", user.id)
    .order("created_at", { ascending: false })
    .returns<WishlistItemWithBook[]>();

  const validItems = (items ?? []).filter(
    (item): item is WishlistItemWithBook & { books: NonNullable<WishlistItemWithBook["books"]> } =>
      item.books !== null,
  );

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <PageHeader title="Your wishlist" />

      {validItems.length === 0 ? (
        <EmptyState
          className="mt-8"
          title="Your wishlist is empty."
          description="Books you save for later will appear here."
          action={
            <Link href="/bookstore" className={buttonClasses("primary", "md")}>
              Browse the Bookstore
            </Link>
          }
        />
      ) : (
        <ul className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4">
          {validItems.map(({ books: book }) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path)
                  .data.publicUrl
              : null;

            return (
              <li key={book.id} className="flex flex-col gap-2">
                <BookCard
                  book={book}
                  coverUrl={coverUrl}
                  authorName={resolvePublicAuthorName(book.profiles)}
                />
                <form action={removeFromWishlist.bind(null, book.id)}>
                  <button
                    type="submit"
                    className="focus-ring w-fit rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface-hover"
                  >
                    Remove
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
