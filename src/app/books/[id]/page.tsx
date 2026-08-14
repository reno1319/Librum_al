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
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:flex-row sm:px-6">
      <div className="mx-auto w-48 shrink-0 sm:mx-0">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            className="aspect-[2/3] w-full rounded-lg object-cover shadow-sm"
          />
        ) : (
          <div className="aspect-[2/3] w-full rounded-lg bg-border" />
        )}
      </div>

      <div className="flex-1">
        <h1 className="font-serif text-3xl font-semibold">{book.title}</h1>
        <p className="mt-1 text-sm text-muted">
          by {book.profiles?.display_name}
        </p>
        <p className="mt-4 whitespace-pre-line text-foreground/90">
          {book.description}
        </p>

        {purchase === "success" && (
          <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            Purchase complete — thank you! It may take a few seconds to show
            as owned below.
          </p>
        )}
        {error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <span className="text-xl font-semibold text-primary">
            ${(book.price_cents / 100).toFixed(2)}
          </span>

          {isAuthor ? (
            <>
              <span className="text-sm text-muted">This is your book</span>
              <a
                href={`/api/books/${book.id}/download`}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover"
              >
                Download EPUB
              </a>
            </>
          ) : owned ? (
            <>
              <span className="rounded-lg bg-surface-hover px-4 py-2 text-sm font-medium">
                You own this book
              </span>
              <a
                href={`/api/books/${book.id}/download`}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                Download EPUB
              </a>
            </>
          ) : user ? (
            <form action={buyBook.bind(null, book.id)}>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                Buy now
              </button>
            </form>
          ) : (
            <Link
              href={`/login?next=/books/${book.id}`}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Log in to buy
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
