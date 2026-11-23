import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BookCard } from "@/components/book-card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { followPenName, unfollowPenName } from "../../autore/[id]/actions";
import { getAuthorInitials } from "@/lib/author-initials";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import {
  authorPagePath,
  housePagePath,
  penNameLinkLabel,
  readPenNameLinks,
  type PublicPenName,
} from "@/lib/pen-names";
import type { PublicBook } from "@/lib/types";
import { canonicalMetadata } from "@/lib/seo";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { LISTED_BOOK_STATUSES } from "@/lib/preorder-reader";

// BUILD 2b (b1 a, pf2 a): a publishing house's public page. Keyed by the
// house's DEFAULT pen name, read from public_pen_names like the author
// page (no account columns): only a row whose house_id is its own id is
// a house page; anything else is "not found". It lists the house's
// authors (its other public pen names) and every listed, priced book
// under the house's pen names, each with its author name. Following the
// house follows its own pen name (b3 a: the new-book email covers all
// of the house's books, see src/lib/email.ts).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

const getHouse = cache(async (id: string) => {
  if (!UUID_PATTERN.test(id)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("public_pen_names")
    .select("id, name, bio, avatar_path, links, house_id")
    .eq("id", id)
    .maybeSingle<PublicPenName>();
  return data && data.house_id === data.id ? data : null;
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return {};
  }
  const { id } = await params;
  const house = await getHouse(id);
  if (!house) return {};
  return {
    title: house.name,
    description: `Librat e shtëpisë botuese ${house.name} në Librum.`,
    ...canonicalMetadata(housePagePath(house.id)),
  };
}

export default async function PublishingHousePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ success?: string; error?: string }>;
}) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const { success: rawSuccess, error: rawError } = (await searchParams) ?? {};
  const success = pageSuccessMessage(rawSuccess);
  const error = pageErrorMessage(rawError);
  const supabase = await createClient();

  const [
    {
      data: { user },
    },
    house,
  ] = await Promise.all([supabase.auth.getUser(), getHouse(id)]);
  if (!house) {
    notFound();
  }

  const admin = createAdminClient();
  const [ownResult, authorsResult, followerCountResult] = await Promise.all([
    user
      ? supabase.from("pen_names").select("id").eq("id", id).eq("author_id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("public_pen_names")
      .select("id, name")
      .eq("house_id", id)
      .neq("id", id)
      .order("name", { ascending: true })
      .returns<{ id: string; name: string }[]>(),
    admin.from("pen_name_follows").select("pen_name_id", { count: "exact", head: true }).eq("pen_name_id", id),
  ]);
  const isSelf = !!ownResult.data;
  const authors = authorsResult.data ?? [];
  const nameByPen = new Map<string, string>([[id, house.name], ...authors.map((a) => [a.id, a.name] as const)]);

  const [{ data: books }, followResult] = await Promise.all([
    supabase
      .from("public_books")
      .select("*")
      .in("pen_name_id", Array.from(nameByPen.keys()))
      .in("status", LISTED_BOOK_STATUSES)
      .not("price_all", "is", null)
      .order("created_at", { ascending: false })
      .returns<PublicBook[]>(),
    user && !isSelf
      ? supabase
          .from("pen_name_follows")
          .select("pen_name_id")
          .eq("follower_id", user.id)
          .eq("pen_name_id", id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const houseBooks = books ?? [];
  const isFollowing = !!followResult.data;
  const followerCount = followerCountResult.count ?? 0;
  const links = readPenNameLinks(house.links);
  const logoUrl = house.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(house.avatar_path).data.publicUrl
    : null;

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

      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-6">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="size-20 shrink-0 rounded-full object-cover shadow-sm sm:size-28" />
        ) : (
          <div
            aria-hidden="true"
            className="flex size-20 shrink-0 items-center justify-center rounded-full bg-border text-lg font-semibold text-foreground/70 sm:size-28 sm:text-2xl"
          >
            {getAuthorInitials(house.name)}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Shtëpi botuese</p>
          <h1 className="mt-1 font-serif text-2xl font-normal text-foreground sm:text-3xl">{house.name}</h1>
          {house.bio && (
            <p className="mt-3 max-w-[42.5rem] whitespace-pre-line text-sm text-foreground/90 sm:text-base">
              {house.bio}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">{followerCount} ndjekës</p>

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
              <form action={(isFollowing ? unfollowPenName : followPenName).bind(null, id)} className="mt-4">
                <button type="submit" className={buttonClasses(isFollowing ? "outline" : "primary", "md")}>
                  {isFollowing ? "Po e ndiqni" : "Ndiqni"}
                </button>
              </form>
            ) : (
              <Link href={`/login?next=${housePagePath(id)}`} className={`${buttonClasses("outline", "md")} mt-4`}>
                Hyr për ta ndjekur
              </Link>
            ))}
        </div>
      </div>

      {authors.length > 0 && (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-serif text-xl font-normal">Autorët</h2>
          <ul className="mt-5 flex flex-wrap gap-2.5">
            {authors.map((author) => (
              <li key={author.id} className="min-w-0 max-w-full">
                <Link
                  href={authorPagePath(author.id)}
                  className="focus-ring inline-block max-w-full break-words rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-foreground hover:bg-surface-hover"
                >
                  {author.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={`mt-12 pt-8 ${authors.length > 0 ? "" : "border-t border-border"}`}>
        <h2 className="font-serif text-xl font-normal">Librat nga {house.name}</h2>
        {houseBooks.length === 0 ? (
          <div className="mt-6 max-w-2xl">
            <EmptyState
              title="Ende nuk ka libra të botuar."
              description="Librat e kësaj shtëpie botuese do të shfaqen këtu kur të botohen."
            />
          </div>
        ) : (
          <ul className="mt-6 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {houseBooks.map((book) => {
              const coverUrl = book.cover_path
                ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
                : null;
              return (
                <li key={book.id}>
                  <BookCard
                    book={book}
                    coverUrl={coverUrl}
                    authorName={book.pen_name_id ? nameByPen.get(book.pen_name_id) ?? null : null}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
