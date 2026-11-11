import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { removePreorderNotice } from "@/app/(public)/libra/[id]/preorder-actions";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { resolveBookByline } from "@/lib/book-byline";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import {
  MY_NOTICES_PATH,
  MY_NOTICES_TITLE,
  NOTIFY_REMOVE_LABEL,
  isWaitingNotice,
  preorderReleaseLabel,
  tiranaToday,
} from "@/lib/preorder-reader";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: MY_NOTICES_TITLE,
  description: "Librat në parapublikim për të cilët keni kërkuar njoftim.",
};

export const dynamic = "force-dynamic";

// BD16 P4 (plan D8): "Njoftimet e mia" -- the pre-orders this reader
// asked to hear about, each with "Hiq". The reader's own rows (RLS: own
// rows only), then the books through public_books; only live pre-orders
// whose email is still to come are shown (a released, cancelled or
// paused one is left out).
type NoticeRow = { book_id: string; notified_at: string | null; book_cancelled_at: string | null };
type NoticeBook = Pick<
  PublicBook,
  "id" | "title" | "status" | "release_date" | "pen_name_id" | "original_author"
> & { pen: PenNameRef | null };

export default async function MyNoticesPage({
  searchParams,
}: {
  // "error" after a failed "Hiq" (words only; anything else: nothing).
  searchParams: Promise<{ notify?: string }>;
}) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }
  const { notify } = await searchParams;
  const removeFailed = notify === "error";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${MY_NOTICES_PATH}`);
  }

  const { data: rows } = await supabase
    .from("preorder_notify_requests")
    .select("book_id, notified_at, book_cancelled_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .returns<NoticeRow[]>();
  const bookIds = (rows ?? []).filter(isWaitingNotice).map((r) => r.book_id);

  const { data: books } =
    bookIds.length > 0
      ? await supabase
          .from("public_books")
          .select("id, title, status, release_date, pen_name_id, original_author, pen:public_pen_names(id, name)")
          .in("id", bookIds)
          .eq("status", "preorder")
          .returns<NoticeBook[]>()
      : { data: [] as NoticeBook[] };

  // Newest request first, as read above (.in() keeps no order).
  const byId = new Map((books ?? []).map((b) => [b.id, b]));
  const ordered = bookIds.map((bookId) => byId.get(bookId)).filter((b): b is NoticeBook => !!b);
  const today = tiranaToday();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
      <PageHeader
        title={MY_NOTICES_TITLE}
        description="Do t'ju dërgojmë email kur të dalë secili prej këtyre librave, ose nëse ndryshon data apo anulohet parapublikimi."
      />

      {removeFailed && (
        <p role="alert" className="mt-6 rounded-[3px] bg-red-50 px-3 py-2 text-sm text-red-700">
          Nuk u hoq. Provoni përsëri.
        </p>
      )}

      {ordered.length === 0 ? (
        <EmptyState className="mt-8" title="Nuk keni kërkuar ende asnjë njoftim." />
      ) : (
        <ul className="mt-8 flex flex-col gap-3">
          {ordered.map((book) => {
            const byline = resolveBookByline(book);
            return (
              <li
                key={book.id}
                className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-surface p-4 shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/libra/${book.id}`}
                    className="focus-ring rounded-sm font-serif font-medium hover:underline"
                  >
                    {book.title}
                  </Link>
                  {byline && <p className="text-sm text-muted">{byline}</p>}
                  <p className="text-sm font-medium text-[#5c480b]">
                    {preorderReleaseLabel(book.release_date, today)}
                  </p>
                </div>
                <form action={removePreorderNotice.bind(null, book.id, "list")}>
                  <button type="submit" className={buttonClasses("outline", "sm")}>
                    {NOTIFY_REMOVE_LABEL}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
