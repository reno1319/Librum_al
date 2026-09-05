import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BookCard } from "@/components/book-card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { formatPrice } from "@/lib/pricing";
import { followAuthor, unfollowAuthor } from "./actions";
import { groupPublishedBooksBySeries } from "@/lib/author-series";
import { getAuthorInitials } from "@/lib/author-initials";
import { resolvePublicAuthorName } from "@/lib/author-name";
import type { Book, Bundle, Profile, Series } from "@/lib/types";

// LIBRUM 2.0 PRODUCT-2: this is a public DISCOVERY surface, not a
// dashboard or a social profile -- see the PRODUCT-2 audit. It shows
// only what the product already treats as public and trustworthy:
// public_author_name/bio/avatar_path (AUTHOR-1C: via the safe
// public_author_profiles view, which guarantees public_author_name is
// never null for an author row), published books, and public series
// grouping derived from those same books. Following stays exactly the
// system PRODUCT-2 was told to reuse, not redesign: same followAuthor/
// unfollowAuthor actions, same self-follow exclusion, same
// admin-client-only follower count (author_follows has no public
// SELECT policy -- see schema.sql).
//
// LIBRUM 2.0 AUTHOR-1C: reads the safe public_author_profiles VIEW
// (migration 045), not the base profiles table -- that view physically
// has no display_name column (and is already filtered to role='author'
// internally, so the explicit .eq("role", "author") this query used to
// need is gone too -- a reader id simply has no row in the view at
// all, same "not found" outcome as before). There is no display_name to
// accidentally fall back to or leak here any more; the resolved public
// name is computed exactly once, right after this fetch resolves (see
// authorPublicName in the page component below), and every render site
// (H1, initials, metadata, "Books by", series/bundle copy) reads that
// one resolved string.
type PublicAuthor = Pick<Profile, "id" | "public_author_name" | "bio" | "avatar_path">;
type SeriesRow = Pick<Series, "id" | "title">;

// LIBRUM 2.0 PRODUCT-2: mirrors Book Detail's own PERF-1 pattern
// (getBookForDetail) -- generateMetadata() and the page component are
// separate invocations that don't otherwise see each other's data, so
// this narrow, public-columns-only, request-scoped cache() is what lets
// both share one row instead of two. Deliberately NOT `select("*")`:
// even the safe view could in principle grow columns later that this
// page has no reason to pull into a request just because they're on
// the same row.
const getPublicAuthor = cache(async (id: string) => {
  const supabase = await createClient();
  const { data: author } = await supabase
    .from("public_author_profiles")
    .select("id, public_author_name, bio, avatar_path")
    .eq("id", id)
    .single<PublicAuthor>();
  return author;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const author = await getPublicAuthor(id);

  // No private-profile leak: a missing/non-author id gets the same
  // generic root-layout metadata a 404 gets anywhere else in this app,
  // never an author-shaped title/description for an id that isn't one.
  if (!author) {
    return {};
  }

  const authorPublicName = resolvePublicAuthorName(author);

  return {
    title: authorPublicName,
    description: `Books and author information for ${authorPublicName} on Librum.`,
  };
}

export default async function AuthorProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // LIBRUM 2.0 PRODUCT-2: getUser() and the author fetch are
  // independent of each other (same reasoning as Book Detail's own
  // PERF-1 pass) -- dispatched together rather than one after another.
  const [
    {
      data: { user },
    },
    author,
  ] = await Promise.all([supabase.auth.getUser(), getPublicAuthor(id)]);

  // Covers both "no profile with this id" and "profile exists but
  // isn't role='author'" -- a reader/admin id (or any invalid id) 404s
  // exactly like a nonexistent one, never exposing which case it was.
  if (!author) {
    notFound();
  }

  const isSelf = user?.id === id;
  const admin = createAdminClient();

  // LIBRUM 2.0 PRODUCT-2: everything below depends only on `id` (known
  // before this point), never on each other -- dispatched as one
  // batch instead of four sequential round trips. The follow-state
  // query is the one genuinely conditional member (only meaningful for
  // a logged-in visitor viewing someone else's page); it uses
  // Promise.resolve({ data: null }) to keep the batch's shape uniform
  // rather than skipping the slot, same convention Book Detail's own
  // PERF-1 batch uses.
  const [{ data: books }, { data: bundles }, followerCountResult, followResult] =
    await Promise.all([
      supabase
        .from("books")
        .select("*")
        .eq("author_id", id)
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .returns<Book[]>(),
      supabase
        .from("bundles")
        .select("*")
        .eq("author_id", id)
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .returns<Bundle[]>(),
      admin.from("author_follows").select("id", { count: "exact", head: true }).eq("author_id", id),
      user && !isSelf
        ? supabase
            .from("author_follows")
            .select("id")
            .eq("follower_id", user.id)
            .eq("author_id", id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const publishedBooks = books ?? [];
  const followerCount = followerCountResult.count ?? 0;
  const isFollowing = !!followResult.data;

  // LIBRUM 2.0 PRODUCT-2: the ONLY query here that couldn't join the
  // batch above -- it needs the series_ids the books query just
  // returned. Still a single `.in()` lookup regardless of how many
  // series this author has, never one query per series (see
  // groupPublishedBooksBySeries's own comment for why the books already
  // in hand are enough for everything else -- counts, ordering, and the
  // cover strip).
  const seriesIds = Array.from(
    new Set(publishedBooks.map((b) => b.series_id).filter((v): v is string => !!v)),
  );
  const { data: seriesRows } =
    seriesIds.length > 0
      ? await supabase.from("series").select("id, title").in("id", seriesIds).returns<SeriesRow[]>()
      : { data: [] as SeriesRow[] };

  const seriesGroups = groupPublishedBooksBySeries(publishedBooks, seriesRows ?? []);

  const avatarUrl = author.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(author.avatar_path).data.publicUrl
    : null;
  // LIBRUM 2.0 AUTHOR-1B / AUTHOR-1C: the one resolved public name every
  // render site below reads from. `author` no longer even HAS a
  // display_name field to fall back to (see PublicAuthor's own comment
  // above) -- the "Unknown author" fallback here is purely a defensive
  // placeholder for the CHECK-constraint-guaranteed-impossible case of a
  // null public_author_name, never a path back to a private name.
  const authorPublicName = resolvePublicAuthorName(author) ?? "Unknown author";
  const authorInitials = getAuthorInitials(authorPublicName);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      {/* ============================================================
          Author hero -- identity, bio, follow. Restrained on purpose:
          no cover photo, no stat dashboard, no social-profile framing.
          ============================================================ */}
      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-6">
        {avatarUrl ? (
          // Decorative: the author's name is always the very next
          // element, matching how every other avatar in this app
          // (Book Detail's About the Author, /following) treats alt
          // text when a name label sits right next to it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            className="size-20 shrink-0 rounded-full object-cover shadow-sm sm:size-28"
          />
        ) : (
          // LIBRUM 2.0 PRODUCT-2 PRE-COMMIT CORRECTION: a plain neutral
          // circle read as a missing/broken image, not an intentional
          // placeholder. Initials derived from the same resolved public
          // name every other author surface already uses --
          // aria-hidden because the name itself is the very next
          // element (same "decorative, name is adjacent" reasoning as
          // the real-avatar branch's alt="").
          <div
            aria-hidden="true"
            className="flex size-20 shrink-0 items-center justify-center rounded-full bg-border text-lg font-semibold text-foreground/70 sm:size-28 sm:text-2xl"
          >
            {authorInitials}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-semibold text-foreground sm:text-3xl">
            {authorPublicName}
          </h1>
          {/* Quiet by design -- a small text line, not a stat card:
              this page is a discovery surface, not a dashboard. Kept
              because it's already a real, cheap, authoritative count
              (admin-client select, see above), not added fresh here. */}
          <p className="mt-1 text-xs text-muted">
            {followerCount} follower{followerCount === 1 ? "" : "s"}
          </p>

          {author.bio ? (
            <p className="mt-3 max-w-xl text-sm text-foreground/90 sm:text-base">{author.bio}</p>
          ) : (
            <p className="mt-3 text-sm text-muted">No biography added yet.</p>
          )}

          {!isSelf &&
            (user ? (
              <form
                action={(isFollowing ? unfollowAuthor : followAuthor).bind(null, id)}
                className="mt-4"
              >
                <button
                  type="submit"
                  className={buttonClasses(isFollowing ? "outline" : "primary", "md")}
                >
                  {isFollowing ? "Following" : "Follow"}
                </button>
              </form>
            ) : (
              <Link
                href={`/login?next=/authors/${id}`}
                className={`${buttonClasses("outline", "md")} mt-4`}
              >
                Log in to follow
              </Link>
            ))}
        </div>
      </div>

      {/* ============================================================
          Books by this author -- the page's primary content.
          ============================================================ */}
      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-semibold">Books by {authorPublicName}</h2>

        {publishedBooks.length === 0 ? (
          // LIBRUM 2.0 PRODUCT-2 PRE-COMMIT CORRECTION: EmptyState
          // itself is unchanged (same component, same copy) -- only
          // constrained to a narrower width here so it doesn't stretch
          // across the full page width and read as more dominant than
          // an author with books actually publishing would produce.
          <div className="mt-6 max-w-2xl">
            <EmptyState
              title="No published books yet."
              description="Books from this author will appear here when they are published."
            />
          </div>
        ) : (
          <ul className="mt-6 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {publishedBooks.map((book) => {
              const coverUrl = book.cover_path
                ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
                : null;

              return (
                <li key={book.id}>
                  {/* No authorName -- we're already on this author's own
                      page, so BookCard's author byline would just link
                      back to the page the reader is already on. */}
                  <BookCard book={book} coverUrl={coverUrl} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ============================================================
          Series -- only when this author's published books actually
          form one. LIBRUM 2.0 PRODUCT-2 PRE-COMMIT CORRECTION: a single
          full-width column previously stretched each series entry
          nearly as wide as the page for very little content (a title,
          a count, three small thumbnails). A 2-column grid (1 column on
          mobile) keeps Series visibly subordinate to the Books grid
          above it without shrinking any individual card's own content;
          covers are moderately larger than before so they read as book
          covers rather than icons, still capped at 4 and still nowhere
          near BookCard's own size -- not a carousel, no new queries,
          groupPublishedBooksBySeries() itself untouched.
          LIBRUM 2.0 PRODUCT-3: now that a real /series/[id] page
          exists, these cards became genuine navigation entry points --
          the title and a small "View series" link both go there;
          cover thumbnails keep linking straight to their own book, same
          as before. Title link and cover links are siblings, not
          nested, so this stays valid markup.
          ============================================================ */}
      {seriesGroups.length > 0 && (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-serif text-xl font-semibold">Series</h2>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {seriesGroups.map((group) => (
              <li
                key={group.id}
                className="rounded-lg border border-border bg-surface p-4 shadow-sm"
              >
                <Link
                  href={`/series/${group.id}`}
                  className="focus-ring rounded-sm font-serif font-medium text-foreground hover:underline"
                >
                  {group.title}
                </Link>
                <p className="mt-0.5 text-xs text-muted">
                  {group.bookCount} book{group.bookCount === 1 ? "" : "s"}
                </p>
                <div className="mt-3 flex gap-2.5">
                  {group.covers.map((book) => {
                    const coverUrl = book.cover_path
                      ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data
                          .publicUrl
                      : null;
                    return (
                      <Link
                        key={book.id}
                        href={`/books/${book.id}`}
                        aria-label={book.title}
                        className="focus-ring block w-16 shrink-0 rounded-sm"
                      >
                        {coverUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={coverUrl}
                            alt=""
                            className="aspect-[2/3] w-full rounded-sm object-cover shadow-sm"
                          />
                        ) : (
                          <div className="aspect-[2/3] w-full rounded-sm bg-border" />
                        )}
                      </Link>
                    );
                  })}
                </div>
                <Link
                  href={`/series/${group.id}`}
                  className="focus-ring mt-3 inline-block rounded-sm text-xs font-medium text-primary hover:underline"
                >
                  View series &rarr;
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ============================================================
          Bundles -- unchanged query/behavior, restyled only to match
          this page's section rhythm (border-t + consistent spacing).
          ============================================================ */}
      {bundles && bundles.length > 0 && (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-serif text-xl font-semibold">Bundles</h2>
          <ul className="mt-6 flex flex-col gap-3">
            {bundles.map((bundle) => (
              <li key={bundle.id}>
                <Link
                  href={`/bundles/${bundle.id}`}
                  className="focus-ring flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-4 shadow-sm hover:bg-surface-hover"
                >
                  <span className="font-serif font-medium">{bundle.title}</span>
                  <span className="text-sm font-semibold text-primary">
                    {formatPrice(bundle.price_cents)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
