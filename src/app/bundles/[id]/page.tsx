import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buyBundle } from "./actions";
import { BookCard } from "@/components/book-card";
import type { Book, Bundle, Profile } from "@/lib/types";

type BundleWithAuthor = Bundle & { profiles: Pick<Profile, "display_name"> | null };
type BundleBookRow = { book_id: string; books: Book | null };

export default async function BundleDetailPage({
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

  const { data: bundle } = await supabase
    .from("bundles")
    .select("*, profiles(display_name)")
    .eq("id", id)
    .single<BundleWithAuthor>();

  if (!bundle || (bundle.status !== "published" && bundle.author_id !== user?.id)) {
    notFound();
  }

  const { data: bundleBookRows } = await supabase
    .from("bundle_books")
    .select("book_id, books(*)")
    .eq("bundle_id", id)
    .returns<BundleBookRow[]>();

  const books = (bundleBookRows ?? [])
    .map((row) => row.books)
    .filter((b): b is Book => !!b);

  const isAuthor = user?.id === bundle.author_id;
  const originalTotalCents = books.reduce((sum, b) => sum + b.price_cents, 0);
  const savingsCents = Math.max(0, originalTotalCents - bundle.price_cents);

  let ownsEverything = false;
  if (user && books.length > 0) {
    const { data: owned } = await supabase
      .from("purchases")
      .select("book_id")
      .eq("reader_id", user.id)
      .in(
        "book_id",
        books.map((b) => b.id),
      )
      .is("refunded_at", null);
    const ownedIds = new Set((owned ?? []).map((p) => p.book_id));
    ownsEverything = books.every((b) => ownedIds.has(b.id));
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <span className="text-xs uppercase tracking-wide text-muted">
        Bundle
      </span>
      <h1 className="font-serif text-3xl font-semibold">{bundle.title}</h1>
      <p className="mt-1 text-sm text-muted">
        by{" "}
        <Link href={`/authors/${bundle.author_id}`} className="hover:underline">
          {bundle.profiles?.display_name}
        </Link>
      </p>

      {bundle.description && (
        <p className="mt-4 whitespace-pre-line text-foreground/90">
          {bundle.description}
        </p>
      )}

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
          ${(bundle.price_cents / 100).toFixed(2)}
        </span>
        {savingsCents > 0 && (
          <span className="text-sm text-muted">
            <span className="line-through">
              ${(originalTotalCents / 100).toFixed(2)}
            </span>{" "}
            — you save ${(savingsCents / 100).toFixed(2)}
          </span>
        )}

        {isAuthor ? (
          <span className="text-sm text-muted">This is your bundle</span>
        ) : ownsEverything ? (
          <span className="rounded-lg bg-surface-hover px-4 py-2 text-sm font-medium">
            You own every book in this bundle
          </span>
        ) : user ? (
          <form action={buyBundle.bind(null, bundle.id)}>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Buy bundle
            </button>
          </form>
        ) : (
          <Link
            href={`/login?next=/bundles/${bundle.id}`}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Log in to buy
          </Link>
        )}
      </div>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        {books.length} book{books.length === 1 ? "" : "s"} in this bundle
      </h2>
      <ul
        className="mt-6"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: "1.5rem",
        }}
      >
        {books.map((book) => {
          const coverUrl = book.cover_path
            ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data
                .publicUrl
            : null;

          return (
            <li key={book.id}>
              <BookCard book={book} coverUrl={coverUrl} />
            </li>
          );
        })}
      </ul>
    </main>
  );
}
