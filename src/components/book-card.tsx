import Link from "next/link";
import type { Book } from "@/lib/types";

export function BookCard({
  book,
  coverUrl,
  authorName,
}: {
  book: Pick<Book, "id" | "title" | "genre" | "price_cents" | "author_id">;
  coverUrl: string | null;
  authorName?: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Link
        href={`/books/${book.id}`}
        className="group"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            className="aspect-[2/3] w-full rounded-lg object-cover shadow-sm transition-shadow group-hover:shadow-md"
          />
        ) : (
          <div className="aspect-[2/3] w-full rounded-lg bg-border" />
        )}
        {book.genre && (
          <span className="text-xs uppercase tracking-wide text-muted">
            {book.genre}
          </span>
        )}
        <span className="font-serif text-sm font-medium">{book.title}</span>
      </Link>
      {authorName && (
        <Link
          href={`/authors/${book.author_id}`}
          className="w-fit text-xs text-muted hover:underline"
        >
          {authorName}
        </Link>
      )}
      <span className="text-sm font-semibold text-primary">
        ${(book.price_cents / 100).toFixed(2)}
      </span>
    </div>
  );
}
