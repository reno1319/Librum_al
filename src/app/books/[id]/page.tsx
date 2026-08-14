import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buyBook } from "./actions";
import type { Book, Profile } from "@/lib/types";

type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };

export default async function BookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ purchase?: string; error?: string }>;
}) {
  const { id } = await params;
  const { purchase, error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: book } = await supabase
    .from("books")
    .select("*, profiles(display_name)")
    .eq("id", id)
    .single<BookWithAuthor>();

  if (!book || (book.status !== "published" && book.author_id !== user?.id)) {
    notFound();
  }

  let owned = false;
  if (user) {
    const { data: purchaseRow } = await supabase
      .from("purchases")
      .select("id")
      .eq("book_id", id)
      .eq("reader_id", user.id)
      .maybeSingle();
    owned = !!purchaseRow;
  }

  const isAuthor = user?.id === book.author_id;
  const coverUrl = book.cover_path
    ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
    : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 gap-8 px-6 py-10">
      <div className="w-48 shrink-0">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            className="aspect-[2/3] w-full rounded-md object-cover"
          />
        ) : (
          <div className="aspect-[2/3] w-full rounded-md bg-gray-100" />
        )}
      </div>

      <div className="flex-1">
        <h1 className="text-2xl font-semibold">{book.title}</h1>
        <p className="mt-1 text-sm text-gray-500">
          by {book.profiles?.display_name}
        </p>
        <p className="mt-4 whitespace-pre-line text-gray-700">
          {book.description}
        </p>

        {purchase === "success" && (
          <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
            Purchase complete — thank you! It may take a few seconds to show
            as owned below.
          </p>
        )}
        {error && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center gap-4">
          <span className="text-xl font-semibold">
            ${(book.price_cents / 100).toFixed(2)}
          </span>

          {isAuthor ? (
            <span className="text-sm text-gray-500">This is your book</span>
          ) : owned ? (
            <span className="rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700">
              You own this book
            </span>
          ) : user ? (
            <form action={buyBook.bind(null, book.id)}>
              <button
                type="submit"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
              >
                Buy now
              </button>
            </form>
          ) : (
            <Link
              href={`/login?next=/books/${book.id}`}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              Log in to buy
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
