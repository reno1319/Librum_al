import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { GENRES } from "@/lib/genres";
import type { Book, Profile } from "@/lib/types";

type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

async function fetchBooks(
  supabase: SupabaseClient,
  { q, genre }: { q?: string; genre?: string },
) {
  const baseQuery = () => {
    let query = supabase
      .from("books")
      .select("*, profiles(display_name)")
      .eq("status", "published");
    if (genre) query = query.eq("genre", genre);
    return query;
  };

  const term = q?.trim();
  if (!term) {
    const { data } = await baseQuery()
      .order("created_at", { ascending: false })
      .returns<BookWithAuthor[]>();
    return data ?? [];
  }

  // Two separate ilike() queries (title, description) merged in JS, rather
  // than one .or() filter string — .or() requires manually escaping commas
  // and parentheses in the search term to stay valid, which is easy to get
  // wrong. This is simpler and just as correct at our scale.
  const pattern = `%${term}%`;
  const [{ data: byTitle }, { data: byDescription }] = await Promise.all([
    baseQuery().ilike("title", pattern).returns<BookWithAuthor[]>(),
    baseQuery().ilike("description", pattern).returns<BookWithAuthor[]>(),
  ]);

  const merged = new Map<string, BookWithAuthor>();
  for (const book of [...(byTitle ?? []), ...(byDescription ?? [])]) {
    merged.set(book.id, book);
  }

  return [...merged.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; genre?: string }>;
}) {
  const { q, genre } = await searchParams;
  const supabase = await createClient();
  const books = await fetchBooks(supabase, { q, genre });
  const isFiltered = Boolean(q?.trim() || genre);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Discover ebooks</h1>
      <p className="mt-2 text-muted">
        Independently published, straight from the author.
      </p>

      <form action="/" method="get" className="mt-6 flex flex-wrap gap-3">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search titles or descriptions..."
          className="min-w-48 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        />
        <select
          name="genre"
          defaultValue={genre ?? ""}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        >
          <option value="">All genres</option>
          {GENRES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Search
        </button>
        {isFiltered && (
          <Link
            href="/"
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover"
          >
            Clear
          </Link>
        )}
      </form>

      {books.length === 0 ? (
        <p className="mt-12 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          {isFiltered
            ? "No books match your search."
            : "No books have been published yet. Check back soon."}
        </p>
      ) : (
        <ul className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4">
          {books.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path)
                  .data.publicUrl
              : null;

            return (
              <li key={book.id}>
                <Link href={`/books/${book.id}`} className="group flex flex-col gap-2">
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
                  <span className="font-serif text-sm font-medium">
                    {book.title}
                  </span>
                  <span className="text-xs text-muted">
                    {book.profiles?.display_name}
                  </span>
                  <span className="text-sm font-semibold text-primary">
                    ${(book.price_cents / 100).toFixed(2)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
