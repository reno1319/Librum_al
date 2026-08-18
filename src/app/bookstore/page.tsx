import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GENRES } from "@/lib/genres";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { BookCard } from "@/components/book-card";
import { BookShelf } from "@/components/book-shelf";
import { IconCoins, IconUnlock, IconBolt } from "@/components/icons";
import type { Book, Profile } from "@/lib/types";
import type { ComponentType, CSSProperties } from "react";

type Icon = ComponentType<{ className?: string; style?: CSSProperties }>;

type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

async function fetchSearchResults(
  supabase: SupabaseClient,
  {
    q,
    genre,
    sort,
    minPriceCents,
    maxPriceCents,
  }: {
    q?: string;
    genre?: string;
    sort?: string;
    minPriceCents?: number;
    maxPriceCents?: number;
  },
) {
  const baseQuery = () => {
    let query = supabase
      .from("books")
      .select("*, profiles(display_name)")
      .eq("status", "published");
    if (genre) query = query.eq("genre", genre);
    if (minPriceCents != null) query = query.gte("price_cents", minPriceCents);
    if (maxPriceCents != null) query = query.lte("price_cents", maxPriceCents);
    return query;
  };

  const term = q?.trim();
  let results: BookWithAuthor[];
  if (!term) {
    const { data } = await baseQuery()
      .order("created_at", { ascending: false })
      .returns<BookWithAuthor[]>();
    results = data ?? [];
  } else {
    // Separate ilike() queries (title, description, keywords) merged in JS,
    // rather than one .or() filter string — .or() requires manually
    // escaping commas and parentheses in the search term to stay valid,
    // which is easy to get wrong. This is simpler and just as correct at
    // our scale.
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

    results = [...merged.values()].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }

  if (sort === "price_asc") {
    results = [...results].sort((a, b) => a.price_cents - b.price_cents);
  } else if (sort === "price_desc") {
    results = [...results].sort((a, b) => b.price_cents - a.price_cents);
  } else if (sort === "bestselling") {
    // Purchase counts span every reader, not just the current visitor, so
    // this needs the admin client — see fetchCuratedHome for the same
    // pattern. Only book_id counts are read here, never who bought what.
    const admin = createAdminClient();
    const { data: purchases } = await admin
      .from("purchases")
      .select("book_id")
      .is("refunded_at", null);

    const counts = new Map<string, number>();
    for (const p of purchases ?? []) {
      counts.set(p.book_id, (counts.get(p.book_id) ?? 0) + 1);
    }

    results = [...results].sort(
      (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0),
    );
  }

  return results;
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

export default async function BookstorePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    genre?: string;
    sort?: string;
    minPrice?: string;
    maxPrice?: string;
  }>;
}) {
  const { q, genre, sort, minPrice, maxPrice } = await searchParams;
  const supabase = await createClient();
  const minPriceCents =
    minPrice && Number.isFinite(Number(minPrice))
      ? Math.round(Number(minPrice) * 100)
      : undefined;
  const maxPriceCents =
    maxPrice && Number.isFinite(Number(maxPrice))
      ? Math.round(Number(maxPrice) * 100)
      : undefined;
  const isFiltered = Boolean(
    q?.trim() || genre || sort || minPriceCents != null || maxPriceCents != null,
  );

  return (
    <main className="flex-1" style={{ backgroundColor: "#fdf0e3" }}>
      <div
        className="mx-auto w-full max-w-5xl px-4 sm:px-6"
        style={{ paddingTop: "2.5rem", paddingBottom: "2.5rem" }}
      >
        <span
          className="w-fit rounded-full px-3 py-1 text-xs font-medium"
          style={{ backgroundColor: "rgba(226, 117, 31, 0.12)", color: "#e2751f" }}
        >
          For readers
        </span>
        <h1 className="mt-3 font-serif text-4xl font-semibold">
          Discover ebooks
        </h1>
        <p className="mt-2 text-muted">
          Independently published, straight from the author.
        </p>

        <form
          action="/bookstore"
          method="get"
          className="mt-6 flex flex-wrap gap-3"
        >
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
          <select
            name="sort"
            defaultValue={sort ?? ""}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="">Newest</option>
            <option value="bestselling">Bestselling</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
          </select>
          <input
            type="number"
            name="minPrice"
            defaultValue={minPrice ?? ""}
            placeholder="Min $"
            min="0"
            step="0.01"
            className="w-24 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <input
            type="number"
            name="maxPrice"
            defaultValue={maxPrice ?? ""}
            placeholder="Max $"
            min="0"
            step="0.01"
            className="w-24 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Search
          </button>
          {isFiltered && (
            <Link
              href="/bookstore"
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover"
            >
              Clear
            </Link>
          )}
        </form>

        {isFiltered ? (
          <SearchResults
            supabase={supabase}
            q={q}
            genre={genre}
            sort={sort}
            minPriceCents={minPriceCents}
            maxPriceCents={maxPriceCents}
          />
        ) : (
          <CuratedHome supabase={supabase} />
        )}
      </div>
    </main>
  );
}

async function SearchResults({
  supabase,
  q,
  genre,
  sort,
  minPriceCents,
  maxPriceCents,
}: {
  supabase: SupabaseClient;
  q?: string;
  genre?: string;
  sort?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
}) {
  const books = await fetchSearchResults(supabase, {
    q,
    genre,
    sort,
    minPriceCents,
    maxPriceCents,
  });

  if (books.length === 0) {
    return (
      <p className="mt-12 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
        No books match your search.
      </p>
    );
  }

  return (
    <ul
      style={{
        display: "grid",
        // auto-fill (not auto-fit): with few results, auto-fit would
        // collapse the empty tracks and stretch the remaining item(s)
        // to fill the row — auto-fill keeps the reserved tracks so a
        // single result stays a normal card width instead of a huge one.
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: "1.5rem",
        marginTop: "2rem",
      }}
    >
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

const VALUE_PROPS: { title: string; body: string; icon: Icon }[] = [
  {
    title: `Authors keep ${100 - PLATFORM_FEE_PERCENT}%`,
    body: "Buy a book and your money goes straight to the person who wrote it — Librum's cut is a flat platform fee, nothing more.",
    icon: IconCoins,
  },
  {
    title: "No DRM, ever",
    body: "Every purchase is a real EPUB file you own outright. No apps to install, no restrictions on how you read it.",
    icon: IconUnlock,
  },
  {
    title: "Published instantly",
    body: "No submission queue, no gatekeepers — authors publish directly, so you're reading it the day it's finished.",
    icon: IconBolt,
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

  // A couple of other recent covers, faded behind the hero cover, so the
  // panel reads as "a shelf" rather than a single isolated cover.
  const backdropCovers = newReleases
    .slice(0, 2)
    .map((b) =>
      b.cover_path
        ? supabase.storage.from("covers").getPublicUrl(b.cover_path).data
            .publicUrl
        : null,
    )
    .filter((url): url is string => !!url);

  return (
    <>
      <section
        className="mt-10 flex flex-col gap-8 rounded-lg border border-border p-6 shadow-sm sm:flex-row sm:p-10"
        style={{
          background:
            "linear-gradient(135deg, var(--color-surface) 0%, var(--color-background) 100%)",
        }}
      >
        <div
          className="relative mx-auto w-48 sm:mx-0 sm:w-56"
          style={{ flexShrink: 0 }}
        >
          {backdropCovers.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt=""
              className="absolute inset-0 aspect-[2/3] w-full rounded-lg object-cover"
              style={{
                transform: `rotate(${i === 0 ? -6 : 6}deg) translateY(0.5rem)`,
                opacity: 0.45,
                zIndex: 0,
              }}
            />
          ))}
          <Link
            href={`/books/${hero.id}`}
            className="relative block"
            style={{ zIndex: 1 }}
          >
            {heroCoverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={heroCoverUrl}
                alt=""
                className="aspect-[2/3] w-full rounded-lg object-cover shadow-md"
              />
            ) : (
              <div className="aspect-[2/3] w-full rounded-lg bg-border" />
            )}
          </Link>
        </div>
        <div className="flex flex-1 flex-col justify-center">
          <span
            className="w-fit rounded-full px-3 py-1 text-xs font-medium"
            style={{ backgroundColor: "rgba(226, 117, 31, 0.12)", color: "#e2751f" }}
          >
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
        className="flex flex-wrap justify-center rounded-lg border border-border bg-surface py-6 text-center shadow-sm"
        style={{ gap: "1.5rem 3rem", marginTop: "2.5rem" }}
      >
        <div>
          <p
            className="font-serif text-2xl font-semibold"
            style={{ color: "#e2751f" }}
          >
            {stats.bookCount}
          </p>
          <p className="text-xs uppercase tracking-wide text-muted">
            {stats.bookCount === 1 ? "Book" : "Books"} published
          </p>
        </div>
        <div>
          <p
            className="font-serif text-2xl font-semibold"
            style={{ color: "#e2751f" }}
          >
            {stats.authorCount}
          </p>
          <p className="text-xs uppercase tracking-wide text-muted">
            {stats.authorCount === 1 ? "Author" : "Authors"}
          </p>
        </div>
        <div>
          <p
            className="font-serif text-2xl font-semibold"
            style={{ color: "#e2751f" }}
          >
            {GENRES.length}
          </p>
          <p className="text-xs uppercase tracking-wide text-muted">Genres</p>
        </div>
      </div>

      <BookShelf title="Bestsellers" books={bestsellers} supabase={supabase} />
      <BookShelf title="New releases" books={newReleases} supabase={supabase} />

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "2.5rem",
          marginTop: "5rem",
        }}
      >
        {VALUE_PROPS.map((prop) => (
          <div key={prop.title}>
            <prop.icon
              style={{
                color: "#e2751f",
                width: "1.75rem",
                height: "1.75rem",
              }}
            />
            <h3 className="mt-3 font-serif text-lg font-semibold">
              {prop.title}
            </h3>
            <p className="mt-2 text-sm text-foreground/90">{prop.body}</p>
          </div>
        ))}
      </section>

      <section style={{ marginTop: "5rem" }}>
        <h2 className="font-serif text-2xl font-semibold">Browse by genre</h2>
        <ul
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "1rem",
            marginTop: "1.5rem",
          }}
        >
          {GENRES.map((g) => (
            <li key={g}>
              <Link
                href={`/bookstore?genre=${encodeURIComponent(g)}`}
                className="flex h-24 items-center justify-center rounded-lg border border-border bg-surface px-3 text-center font-serif text-sm hover:bg-surface-hover"
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
