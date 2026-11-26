import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { EmptyState } from "@/components/ui/empty-state";
import { LibrariaPickBox } from "@/components/libraria-pick";
import { resolveBookByline } from "@/lib/book-byline";
import { storeCardAction } from "@/lib/libraria-store";
import { PICK_PAGE_LIMIT, pickMonthLabel } from "@/lib/libraria-picks";
import {
  fetchCartBookIds,
  fetchOwnedOrOwnBookIds,
  fetchRatings,
  fetchReadingPicks,
} from "@/lib/libraria-picks-read";

export const metadata: Metadata = {
  title: "Çfarë po lexojmë",
  description: "Librat që ka zgjedhur Librum, me shënimin tonë dhe një citim nga secili.",
};

// Reads the maintenance env var on every request, as Libraria does.
export const dynamic = "force-dynamic";

// LR1 patch 4 (lb3 a, lr4-2 a): Libraria's "Më shumë ›" page. Every
// pick whose book Libraria lists now, newest first, each as the same box
// as on Libraria with the month it was picked. The first one is the
// pick Libraria shows now. A pick whose book is off sale is hidden
// (lr4-3 a).
export default async function ReadingPicksPage() {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [picks, cartBookIds, ownedOrOwnBookIds] = await Promise.all([
    fetchReadingPicks(supabase, PICK_PAGE_LIMIT),
    user ? fetchCartBookIds(supabase, user.id) : Promise.resolve(new Set<string>()),
    user ? fetchOwnedOrOwnBookIds(supabase, user.id) : Promise.resolve(new Set<string>()),
  ]);
  const ratings = await fetchRatings(supabase, [...new Set(picks.map((p) => p.book.id))]);
  const cover = (path: string | null | undefined) =>
    path ? supabase.storage.from("covers").getPublicUrl(path).data.publicUrl : null;

  return (
    <main className="flex-1 bg-surface">
      <div className="page-container pt-5 pb-10 sm:pt-6 md:pb-12">
        <nav aria-label="Rruga" className="text-sm text-muted">
          <Link href="/librari" className="focus-ring rounded-sm underline underline-offset-2 hover:decoration-2">
            Libraria
          </Link>
          <span aria-hidden="true"> › </span>
          <span>Çfarë po lexojmë</span>
        </nav>
        <h1 className="mt-3 border-b border-border pb-4 font-serif text-[2.25rem] leading-tight font-normal text-primary sm:text-[2.75rem]">
          Çfarë po lexojmë
        </h1>

        {picks.length === 0 ? (
          <EmptyState
            className="mt-10"
            title="Ende nuk ka zgjedhje."
            description="Kthehuni së shpejti."
            action={
              <Link
                href="/librari"
                className="focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
              >
                Kthehu te Libraria
              </Link>
            }
          />
        ) : (
          <ol className="mt-8 flex flex-col gap-12">
            {picks.map((pick) => (
              <li key={pick.id}>
                <p className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">
                  {pickMonthLabel(pick.publishedAt)}
                </p>
                <LibrariaPickBox
                  headingLevel={2}
                  pick={{
                    book: pick.book,
                    coverUrl: cover(pick.book.cover_path),
                    authorName: resolveBookByline(pick.book),
                    rating: ratings.get(pick.book.id) ?? null,
                    action: storeCardAction(
                      pick.book,
                      !!user,
                      cartBookIds.has(pick.book.id),
                      ownedOrOwnBookIds.has(pick.book.id),
                    ),
                    badge: pick.badge,
                    note: pick.note,
                    quote: pick.quote,
                    quoteFrom: pick.quoteFrom,
                  }}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}
