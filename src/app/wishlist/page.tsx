import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { removeFromWishlist } from "@/app/books/[id]/actions";
import { BookCard } from "@/components/book-card";
import type { Book, Profile } from "@/lib/types";

type WishlistItemWithBook = {
  book_id: string;
  books: (Book & { profiles: Pick<Profile, "display_name"> | null }) | null;
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
    .select("book_id, books(*, profiles(display_name))")
    .eq("reader_id", user.id)
    .order("created_at", { ascending: false })
    .returns<WishlistItemWithBook[]>();

  const validItems = (items ?? []).filter(
    (item): item is WishlistItemWithBook & { books: NonNullable<WishlistItemWithBook["books"]> } =>
      item.books !== null,
  );

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold">Your wishlist</h1>

      {validItems.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          You haven&apos;t saved any books yet.
        </p>
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
                  authorName={book.profiles?.display_name}
                />
                <form action={removeFromWishlist.bind(null, book.id)}>
                  <button
                    type="submit"
                    className="w-fit rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface-hover"
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
