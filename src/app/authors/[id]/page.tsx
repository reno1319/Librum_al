import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BookCard } from "@/components/book-card";
import type { Book, Profile } from "@/lib/types";

export default async function AuthorProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: author } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", id)
    .eq("role", "author")
    .single<Profile>();

  if (!author) {
    notFound();
  }

  const { data: books } = await supabase
    .from("books")
    .select("*")
    .eq("author_id", id)
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .returns<Book[]>();

  const avatarUrl = author.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(author.avatar_path).data
        .publicUrl
    : null;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center gap-6">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            className="h-24 w-24 rounded-full object-cover shadow-sm"
          />
        ) : (
          <div className="h-24 w-24 rounded-full bg-border" />
        )}
        <div>
          <h1 className="font-serif text-3xl font-semibold">
            {author.display_name}
          </h1>
          {author.bio && (
            <p className="mt-2 max-w-xl text-foreground/90">{author.bio}</p>
          )}
        </div>
      </div>

      <h2 className="mt-10 font-serif text-xl font-semibold">Books</h2>

      {!books || books.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          No published books yet.
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4">
          {books.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path)
                  .data.publicUrl
              : null;

            return (
              <li key={book.id}>
                <BookCard book={book} coverUrl={coverUrl} />
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
