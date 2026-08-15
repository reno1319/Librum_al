import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GENRES } from "@/lib/genres";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { BookCard } from "@/components/book-card";
import { BookShelf } from "@/components/book-shelf";
import type { Book, Profile } from "@/lib/types";

type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

async function fetchSearchResults(
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

  // Separate ilike() queries (title, description, keywords) merged in JS,
  // rather than one .or() filter string — .or() requires manually escaping
  // commas and parentheses in the search term to stay valid, which is easy
  // to get wrong. This is simpler and just as correct at our scale.
  const pattern = `%${term}%`;
  const [{ data: byTitle }, { data: byDescription }, { data: byKeywords }] =
    await Promise.all([
      baseQuery().ilike("title", pattern).returns<BookWithAuthor[]>(),
      baseQuery().ilike("description", pattern).returns<BookWithAuthor[]>(),
      baseQuery().ilike("keywords", pattern).returns<BookWithAuthor[]>(),
    ]);

  const merged = new Map<string, BookWithAuthor>();
  for (const book of [
    ...(byTitle ?? []),
    ...(byDescription ?? []),
    ...(byKeywords ?? []),
  ]) {
    merged.set(book.id, book);
  }

  return [...merged.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

async function fetchCuratedHome(supabase: SupabaseClient) {
  const { data: latest } = await supabase
    .from("books")
    .select("*, profiles(display_name)")
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(9)
    .returns<BookWithAuthor[]>();

  const releases = latest ?? [];
  const hero = releases[0] ?? null;
  const newReleases = releases.slice(1);

  // Purchase counts span every reader, not just the current visitor, so
  // this needs the admin client — regular RLS only lets a user see their
  // own purchases (or an author see purchases of their own books). Only
  // book_id counts are read here, never who bought what.
  const admin = createAdminClient();
  const { data: purchases } = await admin
    .from("purchases")
    .select("book_id")
    .is("refunded_at", null);

  const counts = new Map<string, number>();
  for (const p of purchases ?? []) {
    counts.set(p.book_id, (counts.get(p.book_id) ?? 0) + 1);
  }

  const topBookIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id]) => id);

  let bestsellers: BookWithAuthor[] = [];
  if (topBookIds.length > 0) {
    const { data: bestsellerBooks } = await supabase
      .from("books")
      .select("*, profiles(display_name)")
      .eq("status", "published")
      .in("id", topBookIds)
      .returns<BookWithAuthor[]>();

    const byId = new Map((bestsellerBooks ?? []).map((b) => [b.id, b]));
    bestsellers = topBookIds
      .map((id) => byId.get(id))
      .filter((b): b is BookWithAuthor => !!b);
  }

  return { hero, newReleases, bestsellers };
}

async function fetchStorefrontStats(supabase: SupabaseClient) {
  const { count } = await supabase
    .from("books")
    .select("id", { count: "exact", head: true })
    .eq("status", "published");

  const { data: authorRows } = await supabase
    .from("books")
    .select("author_id")
    .eq("status", "published");

  const authorCount = new Set((authorRows ?? []).map((b) => b.author_id)).size;

  return { bookCount: count ?? 0, authorCount };
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; genre?: string; account?: string }>;
}) {
  const { q, genre, account } = await searchParams;
  const supabase = await createClient();
  const isFiltered = Boolean(q?.trim() || genre);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      {account === "deleted" && (
        <p className="mb-6 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          Your account has been deleted.
        </p>
      )}

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

      {isFiltered ? (
        <SearchResults supabase={supabase} q={q} genre={genre} />
      ) : (
        <CuratedHome supabase={supabase} />
      )}
    </main>
  );
}

async function SearchResults({
  supabase,
  q,
  genre,
}: {
  supabase: SupabaseClient;
  q?: string;
  genre?: string;
}) {
  const books = await fetchSearchResults(supabase, { q, genre });

  if (books.length === 0) {
    return (
      <p className="mt-12 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
        No books match your search.
      </p>
    );
  }

  return (
    <ul className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4">
      {books.map((book) => {
        const coverUrl = book.cover_path
          ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data
              .publicUrl
          : null;

        return (
          <li key={book.id}>
            <BookCard
              book={book}
              coverUrl={coverUrl}
              authorName={book.profiles?.display_name}
            />
          </li>
        );
      })}
    </ul>
  );
}

const VALUE_PROPS = [
  {
    title: `Authors keep ${100 - PLATFORM_FEE_PERCENT}%`,
    body: "Buy a book and your money goes straight to the person who wrote it — Librum's cut is a flat platform fee, nothing more.",
  },
  {
    title: "No DRM, ever",
    body: "Every purchase is a real EPUB file you own outright. No apps to install, no restrictions on how you read it.",
  },
  {
    title: "Published instantly",
    body: "No submission queue, no gatekeepers — authors publish directly, so you're reading it the day it's finished.",
  },
];

async function CuratedHome({ supabase }: { supabase: SupabaseClient }) {
  const [{ hero, newReleases, bestsellers }, stats] = await Promise.all([
    fetchCuratedHome(supabase),
    fetchStorefrontStats(supabase),
  ]);

  if (!hero) {
    return (
      <p className="mt-12 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
        No books have been published yet. Check back soon.
      </p>
    );
  }

  const heroCoverUrl = hero.cover_path
    ? supabase.storage.from("covers").getPublicUrl(hero.cover_path).data
        .publicUrl
    : null;
  const heroDescription =
    hero.description.length > 220
      ? `${hero.description.slice(0, 220).trimEnd()}…`
      : hero.description;

  return (
    <>
      <section
        className="mt-10 flex flex-col gap-8 rounded-lg border border-border p-6 shadow-sm sm:flex-row sm:p-10"
        style={{
          background:
            "linear-gradient(135deg, var(--color-surface) 0%, var(--color-background) 100%)",
        }}
      >
        <Link
          href={`/books/${hero.id}`}
          className="mx-auto w-48 shrink-0 sm:mx-0 sm:w-56"
        >
          {heroCoverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={heroCoverUrl}
              alt=""
              className="aspect-[2/3] w-full rounded-lg object-cover shadow-sm"
            />
          ) : (
            <div className="aspect-[2/3] w-full rounded-lg bg-border" />
          )}
        </Link>
        <div className="flex flex-1 flex-col justify-center">
          <span className="w-fit rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            Just published
          </span>
          <h2 className="mt-3 font-serif text-4xl font-semibold sm:text-5xl">
            <Link href={`/books/${hero.id}`} className="hover:underline">
              {hero.title}
            </Link>
          </h2>
          <p className="mt-2 text-sm text-muted">
            by{" "}
            <Link
              href={`/authors/${hero.author_id}`}
              className="hover:underline"
            >
              {hero.profiles?.display_name}
            </Link>
          </p>
          <p className="mt-4 text-foreground/90">{heroDescription}</p>
          <div className="mt-6 flex items-center gap-3">
            <span className="text-lg font-semibold text-primary">
              ${(hero.price_cents / 100).toFixed(2)}
            </span>
            <Link
              href={`/books/${hero.id}`}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              View book
            </Link>
          </div>
        </div>
      </section>

      <div
        className="mt-8 flex flex-wrap justify-center rounded-lg border border-border bg-surface py-6 text-center shadow-sm"
        style={{ gap: "1.5rem 3rem" }}
      >
        <div>
          <p className="font-serif text-2xl font-semibold text-primary">
            {stats.bookCount}
          </p>
          <p className="text-xs uppercase tracking-wide text-muted">
            {stats.bookCount === 1 ? "Book" : "Books"} published
          </p>
        </div>
        <div>
          <p className="font-serif text-2xl font-semibold text-primary">
            {stats.authorCount}
          </p>
          <p className="text-xs uppercase tracking-wide text-muted">
            {stats.authorCount === 1 ? "Author" : "Authors"}
          </p>
        </div>
        <div>
          <p className="font-serif text-2xl font-semibold text-primary">
            {GENRES.length}
          </p>
          <p className="text-xs uppercase tracking-wide text-muted">Genres</p>
        </div>
      </div>

      <BookShelf title="Bestsellers" books={bestsellers} supabase={supabase} />
      <BookShelf title="New releases" books={newReleases} supabase={supabase} />

      <section className="mt-14 grid grid-cols-1 gap-8 sm:grid-cols-3">
        {VALUE_PROPS.map((prop) => (
          <div key={prop.title}>
            <h3 className="font-serif text-lg font-semibold">{prop.title}</h3>
            <p className="mt-2 text-sm text-foreground/90">{prop.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-14">
        <h2 className="font-serif text-xl font-semibold">Browse by genre</h2>
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {GENRES.map((g) => (
            <li key={g}>
              <Link
                href={`/?genre=${encodeURIComponent(g)}`}
                className="flex h-20 items-center justify-center rounded-lg border border-border bg-surface px-3 text-center font-serif text-sm hover:bg-surface-hover"
              >
                {g}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
