import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BookCard } from "@/components/book-card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { followPenName, removePenNameLinks, unfollowPenName } from "./actions";
import { groupPublishedBooksBySeries } from "@/lib/author-series";
import { getAuthorInitials } from "@/lib/author-initials";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";
import { hasPermission } from "@/lib/staff";
import {
  authorPagePath,
  penNameLinkLabel,
  readPenNameLinks,
  type PublicPenName,
} from "@/lib/pen-names";
import { Alert } from "@/components/ui/alert";
import type { PublicBook, PublicBundle, PublicSeries } from "@/lib/types";
import { CoverPlaceholder } from "@/components/cover-placeholder";

// LIBRUM 2.0 PRODUCT-2: this is a public DISCOVERY surface, not a
// dashboard or a social profile -- see the PRODUCT-2 audit.
//
// PEN-NAMES-1 (migration 20261019184512): the page is keyed by a PEN
// NAME id (1a) and reads the public_pen_names view, which has no
// author_id: the name, the books, series and bundles under that pen
// name only, and the follower count of that pen name. Bio, photo and
// links show only when the author added them (2a, 7a, 8a); nothing
// links to the author's other pen names. An old /authors/<account id>
// URL has no row in the view and is "not found" like any unknown id.
// Staff with reports.resolve (13a) also see the account behind the pen
// name and a "Remove links" button (audited in the database).
type SeriesRow = Pick<PublicSeries, "id" | "title">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see V3 §3.
export const dynamic = "force-dynamic";

// LIBRUM 2.0 PRODUCT-2: mirrors Book Detail's own PERF-1 pattern
// (getBookForDetail) -- generateMetadata() and the page component are
// separate invocations that don't otherwise see each other's data, so
// this narrow, public-columns-only, request-scoped cache() is what lets
// both share one row instead of two. Deliberately NOT `select("*")`:
// even the safe view could in principle grow columns later that this
// page has no reason to pull into a request just because they're on
// the same row.
const getPublicPenName = cache(async (id: string) => {
  if (!UUID_PATTERN.test(id)) return null;
  const supabase = await createClient();
  const { data: penName } = await supabase
    .from("public_pen_names")
    .select("id, name, bio, avatar_path, links")
    .eq("id", id)
    .maybeSingle<PublicPenName>();
  return penName ?? null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  // ALL-CUTOVER APP-A: no author-specific metadata (and no Supabase
  // call via getPublicPenName) while maintenance is active -- the same
  // {} fallback this function already uses for a missing/non-author id.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return {};
  }

  const { id } = await params;
  const penName = await getPublicPenName(id);

  // A missing id gets the same generic root-layout metadata a 404 gets
  // anywhere else in this app.
  if (!penName) {
    return {};
  }

  const authorPublicName = penName.name;

  return {
    title: authorPublicName,
    description: `Books and author information for ${authorPublicName} on Librum.`,
  };
}

export default async function AuthorProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ success?: string; error?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive public author profile page
  // (V3 §3) -- checked as the first statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const { success, error } = (await searchParams) ?? {};
  const supabase = await createClient();

  // LIBRUM 2.0 PRODUCT-2: getUser() and the pen name fetch are
  // independent of each other (same reasoning as Book Detail's own
  // PERF-1 pass) -- dispatched together rather than one after another.
  const [
    {
      data: { user },
    },
    author,
  ] = await Promise.all([supabase.auth.getUser(), getPublicPenName(id)]);

  // Covers "no pen name with this id", "pen name not used by any book,
  // series or bundle" and every old /authors/<account id> URL alike.
  if (!author) {
    notFound();
  }

  const admin = createAdminClient();

  // "Is this one of my own pen names?" -- pen_names RLS shows a
  // signed-in author their own rows (and staff every row, hence the
  // author_id filter). Hides the Follow button; the database refuses a
  // self-follow anyway (LB457).
  const [ownPenNameResult, isStaffReviewer] = await Promise.all([
    user
      ? supabase
          .from("pen_names")
          .select("id")
          .eq("id", id)
          .eq("author_id", user.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    user ? hasPermission("reports.resolve") : Promise.resolve(false),
  ]);
  const isSelf = !!ownPenNameResult.data;

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
      // ALL-WIRING-2: an author's public shelf is a discovery surface,
      // so a book with no authored ALL price is excluded here the same
      // way it is from the bookstore. The author still sees every one of
      // their books, priced or not, on their own dashboard -- which is
      // where the missing price gets fixed.
      // PEN-NAMES-2: public_books (no account columns).
      supabase
        .from("public_books")
        .select("*")
        .eq("pen_name_id", id)
        .eq("status", "published")
        .not("price_all", "is", null)
        .order("created_at", { ascending: false })
        .returns<PublicBook[]>(),
      // ALL-WIRING-5: the bundle rail is a discovery surface too, so a
      // bundle with no authored ALL price is excluded on the same terms
      // as a book -- still published, still reachable at its own
      // address, still on its author's dashboard. Only the rendered
      // columns are selected; the legacy `price_cents` is not.
      supabase
        .from("public_bundles")
        .select("id, title, price_all")
        .eq("pen_name_id", id)
        .eq("status", "published")
        .not("price_all", "is", null)
        .order("created_at", { ascending: false })
        .returns<Pick<PublicBundle, "id" | "title" | "price_all">[]>(),
      // PEN-NAMES-1: followers of THIS pen name (4a). pen_name_follows
      // has no public SELECT policy, so the count stays admin-only.
      admin
        .from("pen_name_follows")
        .select("pen_name_id", { count: "exact", head: true })
        .eq("pen_name_id", id),
      user && !isSelf
        ? supabase
            .from("pen_name_follows")
            .select("pen_name_id")
            .eq("follower_id", user.id)
            .eq("pen_name_id", id)
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
      ? await supabase.from("public_series").select("id, title").in("id", seriesIds).returns<SeriesRow[]>()
      : { data: [] as SeriesRow[] };

  const seriesGroups = groupPublishedBooksBySeries(publishedBooks, seriesRows ?? []);

  // 13a: the account behind this pen name, for staff with reports.resolve
  // only (service-role read, rendered for them alone).
  let staffAccount: { id: string; label: string } | null = null;
  if (isStaffReviewer) {
    const { data: penRow } = await admin
      .from("pen_names")
      .select("author_id")
      .eq("id", id)
      .maybeSingle<{ author_id: string }>();
    if (penRow) {
      const { data: account } = await admin
        .from("profiles")
        .select("public_author_name")
        .eq("id", penRow.author_id)
        .maybeSingle<{ public_author_name: string | null }>();
      staffAccount = {
        id: penRow.author_id,
        label: account?.public_author_name ?? "Account without an author name",
      };
    }
  }
  const links = readPenNameLinks(author.links);

  const avatarUrl = author.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(author.avatar_path).data.publicUrl
    : null;
  const authorPublicName = author.name;
  const authorInitials = getAuthorInitials(authorPublicName);

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      {error && (
        <Alert variant="error" className="mb-6">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mb-6">
          {success}
        </Alert>
      )}

      {/* 13a / 8a / 15a: staff only. */}
      {staffAccount && (
        <section
          aria-label="Staff"
          className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 text-sm"
        >
          <p className="min-w-0">
            <span className="font-semibold">Staff:</span> pen name of account{" "}
            <span className="font-medium">{staffAccount.label}</span>{" "}
            <span className="break-all text-muted">({staffAccount.id})</span>
          </p>
          {links.length > 0 ? (
            <form action={removePenNameLinks.bind(null, id)}>
              <button type="submit" className={buttonClasses("outline", "sm")}>
                Remove links
              </button>
            </form>
          ) : (
            <span className="text-muted">No links</span>
          )}
        </section>
      )}

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
          <h1 className="font-serif text-2xl font-normal text-foreground sm:text-3xl">
            {authorPublicName}
          </h1>
          {/* Quiet by design -- a small text line, not a stat card:
              this page is a discovery surface, not a dashboard. Kept
              because it's already a real, cheap, authoritative count
              (admin-client select, see above), not added fresh here. */}
          <p className="mt-1 text-xs text-muted">
            {followerCount} follower{followerCount === 1 ? "" : "s"}
          </p>

          {/* 7a: bio and links only when the author added them -- no
              placeholder line for a missing bio. */}
          {author.bio && (
            <p className="mt-3 max-w-[42.5rem] whitespace-pre-line text-sm text-foreground/90 sm:text-base">
              {author.bio}
            </p>
          )}

          {links.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {links.map((link) => (
                <li key={link} className="min-w-0 max-w-full">
                  <a
                    href={link}
                    rel="nofollow ugc noopener noreferrer"
                    target="_blank"
                    className="focus-ring break-all rounded-sm text-primary underline underline-offset-2 hover:decoration-2"
                  >
                    {penNameLinkLabel(link)}
                  </a>
                </li>
              ))}
            </ul>
          )}

          {!isSelf &&
            (user ? (
              <form
                action={(isFollowing ? unfollowPenName : followPenName).bind(null, id)}
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
                href={`/login?next=${authorPagePath(id)}`}
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
        <h2 className="font-serif text-xl font-normal">Books by {authorPublicName}</h2>

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
          <ul className="mt-6 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
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
          <h2 className="font-serif text-xl font-normal">Series</h2>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {seriesGroups.map((group) => (
              <li
                key={group.id}
                className="rounded-card border border-border bg-surface p-4 shadow-sm"
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
                        className="focus-ring block w-16 shrink-0 rounded-[2px]"
                      >
                        {coverUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={coverUrl}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="aspect-[2/3] w-full rounded-[2px] object-cover shadow-sm"
                          />
                        ) : (
                          <CoverPlaceholder
                            title={book.title}
                            authorName={authorPublicName}
                            className="aspect-[2/3] w-full rounded-[2px]"
                          />
                        )}
                      </Link>
                    );
                  })}
                </div>
                <Link
                  href={`/series/${group.id}`}
                  className="focus-ring mt-3 inline-block rounded-sm text-xs font-medium text-primary underline underline-offset-2 hover:decoration-2"
                >
                  View series &rarr;
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ============================================================
          Bundles -- restyled to match this page's section rhythm
          (border-t + consistent spacing). ALL-WIRING-5: priced from
          price_all; unpriced bundles never reach this list (see the
          query above).
          ============================================================ */}
      {bundles && bundles.length > 0 && (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-serif text-xl font-normal">Bundles</h2>
          <ul className="mt-6 flex max-w-[42.5rem] flex-col gap-3">
            {bundles.map((bundle) => (
              <li key={bundle.id}>
                <Link
                  href={`/bundles/${bundle.id}`}
                  className="focus-ring flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface p-4 shadow-sm hover:bg-surface-hover"
                >
                  <span className="font-serif font-medium">{bundle.title}</span>
                  <span className="text-sm font-semibold text-primary">
                    {formatCatalogPriceLabel(bundle.price_all)}
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
