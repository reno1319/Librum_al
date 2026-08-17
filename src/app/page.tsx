import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GENRES } from "@/lib/genres";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { BookCard } from "@/components/book-card";
import { BookShelf } from "@/components/book-shelf";
import {
  IconUpload,
  IconBolt,
  IconBookOpen,
  IconBank,
  IconChart,
  IconTag,
  IconLayers,
  IconShield,
  IconCheck,
  IconCoins,
  IconUnlock,
} from "@/components/icons";
import type { Book, Profile } from "@/lib/types";
import type { ComponentType, CSSProperties } from "react";

type Icon = ComponentType<{ className?: string; style?: CSSProperties }>;

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

async function fetchHeroCovers(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("books")
    .select("id, cover_path")
    .eq("status", "published")
    .not("cover_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(8)
    .returns<Pick<Book, "id" | "cover_path">[]>();

  return (data ?? []).map((b) => ({
    id: b.id,
    url: supabase.storage.from("covers").getPublicUrl(b.cover_path!).data
      .publicUrl,
  }));
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let isLoggedInAuthor = false;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    isLoggedInAuthor = profile?.role === "author";
  }

  // The author pitch is the "front door" for logged-out visitors and
  // readers — once someone is publishing on Librum already, they know
  // how it works, so skip straight to the marketplace for them.
  const showAuthorPitch = !isFiltered && !isLoggedInAuthor;
  const heroCovers = showAuthorPitch ? await fetchHeroCovers(supabase) : [];

  return (
    <main className="flex-1">
      {account === "deleted" && (
        <div className="mx-auto w-full max-w-5xl px-4 pt-10 sm:px-6">
          <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            Your account has been deleted.
          </p>
        </div>
      )}

      {showAuthorPitch && (
        <div style={{ backgroundColor: "#f8ece7" }}>
          <div
            className="mx-auto w-full max-w-5xl px-4 sm:px-6"
            style={{ paddingTop: "2.5rem", paddingBottom: "4rem" }}
          >
            <AuthorPitch covers={heroCovers} />
          </div>
        </div>
      )}

      <div id="marketplace" style={{ backgroundColor: "#eef3ee" }}>
        <div
          className="mx-auto w-full max-w-5xl px-4 sm:px-6"
          style={{
            paddingTop: showAuthorPitch ? "4rem" : "2.5rem",
            paddingBottom: "2.5rem",
          }}
        >
          <span
            className="w-fit rounded-full px-3 py-1 text-xs font-medium"
            style={{ backgroundColor: "rgba(63, 107, 79, 0.12)", color: "#3f6b4f" }}
          >
            For readers
          </span>
          {showAuthorPitch ? (
            <h2 className="mt-3 font-serif text-4xl font-semibold">
              Discover ebooks
            </h2>
          ) : (
            <h1 className="mt-3 font-serif text-4xl font-semibold">
              Discover ebooks
            </h1>
          )}
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
        </div>
      </div>
    </main>
  );
}

const PUBLISHING_STEPS: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Upload your book",
    body: "Add your EPUB manuscript, a cover, a description, and a price. Takes a few minutes.",
    icon: IconUpload,
  },
  {
    title: "Publish instantly",
    body: "No submission queue, no approval wait — your book goes live the moment you hit publish.",
    icon: IconBolt,
  },
  {
    title: "Readers buy directly",
    body: "Secure checkout, real DRM-free EPUB files — readers get a book they actually own.",
    icon: IconBookOpen,
  },
  {
    title: "Get paid automatically",
    body: `Every sale splits instantly — you keep ${100 - PLATFORM_FEE_PERCENT}%, paid straight to your bank account.`,
    icon: IconBank,
  },
];

const AUTHOR_STRIP = [
  "No setup fees",
  "No minimum sales",
  `Keep ${100 - PLATFORM_FEE_PERCENT}% of every sale`,
  "Payouts via Stripe",
];

const PUBLISHING_TOOLS: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Sales dashboard",
    body: "Revenue, units sold, and a 14-day chart — broken down per book, so you know what's working.",
    icon: IconChart,
  },
  {
    title: "Discount codes",
    body: "Run a percentage- or dollar-off promo on any book, with an optional expiry date.",
    icon: IconTag,
  },
  {
    title: "Series",
    body: "Group your books in reading order — shown right on each book's page, linking readers to the next one.",
    icon: IconLayers,
  },
  {
    title: "Watermarked downloads",
    body: "Every sale is stamped with the buyer's email — lightweight anti-piracy, no DRM, no restrictions for readers.",
    icon: IconShield,
  },
];

// A staggered, slightly-rotated grid of real cover art from books already
// published on the platform — used as hero imagery instead of stock
// photography, which this environment has no way to fetch.
function BookCoverFan({ covers }: { covers: { id: string; url: string }[] }) {
  const shown = covers.slice(0, 6);
  if (shown.length === 0) return null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "1rem",
        width: "100%",
        maxWidth: "20rem",
      }}
    >
      {shown.map((cover, i) => (
        <div
          key={cover.id}
          style={{
            transform: `rotate(${i % 2 === 0 ? -4 : 4}deg) translateY(${i % 3 === 1 ? "-0.6rem" : "0"})`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cover.url}
            alt=""
            className="aspect-[2/3] w-full rounded-lg object-cover shadow-md"
          />
        </div>
      ))}
    </div>
  );
}

function AuthorPitch({ covers }: { covers: { id: string; url: string }[] }) {
  return (
    <>
      <section
        className="flex flex-col gap-8 rounded-lg border border-border p-6 shadow-sm sm:flex-row sm:items-center sm:p-10"
        style={{
          background:
            "linear-gradient(135deg, var(--color-surface) 0%, var(--color-background) 100%)",
        }}
      >
        <div className="flex flex-1 flex-col gap-6">
          <span className="w-fit rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            For authors
          </span>
          <h1 className="font-serif text-4xl font-semibold sm:text-5xl">
            Publish your ebook. Keep {100 - PLATFORM_FEE_PERCENT}% of every
            sale.
          </h1>
          <p className="max-w-xl text-lg text-foreground/90">
            Upload an EPUB, set your price, and go live today. Librum handles
            checkout, delivery, and payouts — no submission queue, no
            gatekeepers, no middleman between you and your readers.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/signup?role=author"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Start publishing — it&apos;s free
            </Link>
            <a
              href="#marketplace"
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover"
            >
              Browse the marketplace
            </a>
          </div>
        </div>

        {covers.length > 0 && (
          <div style={{ flexShrink: 0, margin: "0 auto" }}>
            <BookCoverFan covers={covers} />
          </div>
        )}
      </section>

      <div
        className="flex flex-wrap justify-center rounded-lg border border-border bg-surface py-5 text-center text-sm font-medium shadow-sm"
        style={{ gap: "1rem 3rem", marginTop: "2.5rem" }}
      >
        {AUTHOR_STRIP.map((item) => (
          <span key={item} className="flex items-center gap-2">
            <IconCheck
              className="text-primary"
              style={{ width: "1rem", height: "1rem" }}
            />
            {item}
          </span>
        ))}
      </div>

      <section style={{ marginTop: "5rem" }}>
        <h2 className="font-serif text-2xl font-semibold">
          How self-publishing works
        </h2>
        <ol
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "2.5rem",
            marginTop: "2rem",
          }}
        >
          {PUBLISHING_STEPS.map((step, i) => (
            <li key={step.title}>
              <div className="flex items-center gap-3">
                <step.icon
                  className="text-primary"
                  style={{ width: "1.75rem", height: "1.75rem" }}
                />
                <span className="font-serif text-2xl font-semibold text-primary">
                  {i + 1}
                </span>
              </div>
              <h3 className="mt-3 font-serif text-lg font-semibold">
                {step.title}
              </h3>
              <p className="mt-1 text-sm text-foreground/90">{step.body}</p>
            </li>
          ))}
        </ol>
        <Link
          href="/how-it-works"
          className="mt-6 inline-block text-sm font-medium text-primary hover:underline"
        >
          Read the full guide &rarr;
        </Link>
      </section>

      <section style={{ marginTop: "5rem" }}>
        <h2 className="font-serif text-2xl font-semibold">
          Everything you need to sell your book
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "2.5rem",
            marginTop: "2rem",
          }}
        >
          {PUBLISHING_TOOLS.map((tool) => (
            <div key={tool.title}>
              <tool.icon
                className="text-primary"
                style={{ width: "1.75rem", height: "1.75rem" }}
              />
              <h3 className="mt-3 font-serif text-lg font-semibold">
                {tool.title}
              </h3>
              <p className="mt-1 text-sm text-foreground/90">{tool.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
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
    <ul
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
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
            style={{ backgroundColor: "rgba(63, 107, 79, 0.12)", color: "#3f6b4f" }}
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
            style={{ color: "#3f6b4f" }}
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
            style={{ color: "#3f6b4f" }}
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
            style={{ color: "#3f6b4f" }}
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
                color: "#3f6b4f",
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
                href={`/?genre=${encodeURIComponent(g)}`}
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
