import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPublishChecklist } from "@/lib/publish-checklist";
import { inReviewIdsFrom, resolveDashboardAttention } from "@/lib/dashboard-attention";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import { isSchedulerEnabled } from "@/lib/payout-scheduler";
import { computeNextPayoutCycleDate, formatPayoutCycleDate } from "@/lib/payout-cycle";
import { formatTransactionMinorUnits, type CurrencyTotals } from "@/lib/transaction-money";
import { AuthorBookRow } from "@/components/author-book-row";
import { loadAuthorTakedownNotices } from "@/lib/book-takedowns";
import { loadAuthorReviewNotices } from "@/lib/book-reviews";
import type { AuthorReviewNotice } from "@/lib/book-review-copy";
import { editorPath } from "@/lib/book-editor-copy";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";
import { changedPendingFields, readShelfPendingChanges } from "@/lib/book-pending-changes";
import { countWaitingReaders } from "@/lib/preorders";
import {
  SHELF_FILTERS,
  SHELF_SORTS,
  SHELF_VIEWS,
  groupShelfBooks,
  matchesShelfFilter,
  parseShelfQuery,
  resolveShelfState,
  sortShelfBooks,
  type ShelfState,
} from "@/lib/bookshelf";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import {
  formatMonthComparison,
  loadDashboardSales,
  type DashboardSalesResult,
} from "./dashboard-sales";
import type { Book } from "@/lib/types";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { ebookCoverNotice } from "@/lib/ebook-cover-notice";

export const metadata: Metadata = {
  title: "Paneli i autorit",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see the exhaustive
// route audit (books.price_all is rendered via AuthorBookRow below,
// on the main post-login author hub).
export const dynamic = "force-dynamic";

// LIBRUM 2.0 UI-6: DASHBOARD = AUTHOR OPERATIONS / WORKSPACE. This page
// is the hub -- one prioritized next action, the author's books, and
// quiet link-outs to secondary tools.
//
// REDESIGN STEP 4 (A2 dashboard mockup, Renato's D1-D6): books first
// with a small money summary, KDP Bookshelf style. A menu row of the
// existing dashboard pages (D5); the heading and alerts unchanged (D6,
// M2); four small summary boxes -- sales this month with a comparison
// to last month (D1), net revenue this month, next payout cycle (D3),
// net revenue all time -- or one compact box on a phone; then EVERY
// book with All / Published / Drafts tabs and a title search (D4), each
// published book showing its last-30-days figure (D2). Tabs and search
// are plain URL search params, so they work without JavaScript.
//
// The sales figures come from loadDashboardSales() (./dashboard-sales.ts),
// which reuses the Sales page's reads, exclusions and net-revenue maths
// and fails safe: when any sales read fails, the summary and the 30-day
// figures are replaced by "Could not load sales data. Please try
// again." and the book list still renders.
//
// AUTHOR PAGES REDESIGN (Renato's Q12 c): the row of three link boxes
// under "Your books" (Sales & earnings, Financial balance, Payouts) is
// gone -- the dashboard menu already links each page -- and with it the
// payout-status label and the profiles read of stripe_account_id /
// stripe_payouts_enabled it alone needed. This page reads no
// profiles row (HEADER-NAME r2, Renato 11:52Z: the greeting moved to the
// site header, so PHONE PASS's Dashboard greeting and its read are gone
// again). Paid publishing is decided by
// canPublishPaidTitle() alone (see performPublish() in
// dashboard/books/actions.ts). The live POK build
// adds one "Bank account" box here.
//
// BD15 P6 (bookshelf; Renato 11-05 Q1 a: the one shelf is HERE, and
// /dashboard/books redirects to it): the All / Published / Drafts tabs
// became a toolbar of plain GET selects -- sort (newest, title A-Z,
// publish date; Q2 a: no "last changed", books.updated_at is never
// written), filter by state, view by series or flat, title search --
// so it still works without JavaScript. Each book's state comes from
// src/lib/bookshelf.ts. A live book's waiting changes are read from
// book_pending_changes (service_role only) with the trusted writer,
// for the ids the author's own session just read, AFTER auth; when that
// read fails the shelf says so in a visible line and shows those books
// as plainly live.

const TEXT_LINK_CLASSES =
  "focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";
const BOX_CLASSES = "rounded-[4px] border border-border bg-surface p-5";
const BOX_LABEL_CLASSES = "text-[0.8125rem] uppercase tracking-[0.06em] text-muted";
const BOX_FIGURE_CLASSES = "font-serif text-[2rem] leading-tight text-primary";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    success?: string;
    q?: string;
    sort?: string;
    filter?: string;
    view?: string;
    ebook_cover?: string;
  }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive page -- renders books.price_all
  // via AuthorBookRow (exhaustive route audit) -- checked as the first
  // statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const {
    error: rawError,
    success: rawSuccess,
    q: rawQ,
    sort: rawSort,
    filter: rawFilter,
    view: rawView,
    ebook_cover: rawEbookCover,
  } = await searchParams;

  const error = pageErrorMessage(rawError);

  const success = pageSuccessMessage(rawSuccess);
  // W7 r2 (Q1): one fixed sentence when the cover could not be put inside
  // a Librum-made ebook (src/lib/ebook-cover-notice.ts).
  const ebookCoverWarning = ebookCoverNotice(rawEbookCover);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard");
  }

  const { data: books } = await supabase
    .from("books")
    .select("*")
    .eq("author_id", user.id)
    .order("created_at", { ascending: false })
    .returns<Book[]>();

  const allBooks = books ?? [];
  // ADMIN-3-REVIEW (F, N9): the author's review rows, one read. BD15
  // P5b-3a: read before the attention card, which skips drafts in review.
  const reviewNotices =
    allBooks.length > 0 ? await loadAuthorReviewNotices(supabase, user.id) : new Map<string, AuthorReviewNotice>();

  const attention = resolveDashboardAttention({
    books: allBooks,
    paidPublishingAvailable: canPublishPaidTitle(),
    inReviewBookIds: inReviewIdsFrom(reviewNotices),
  });

  const heading = (
    <div className="mt-5 flex items-start justify-between gap-4 sm:mt-8 sm:items-end">
      {/* PHONE PASS (Renato 3a) dropped the grey description; HEADER-NAME
          r2 moved the greeting to the site header ("Hello, <name>"). */}
      <div className="min-w-0">
        <h1 className="font-serif text-[1.875rem] font-normal leading-tight text-primary sm:text-[2.5rem]">
          Paneli juaj
        </h1>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Link
          href="/dashboard/series"
          className={buttonClasses("outline", "md", "min-h-11 rounded-[3px] border-[#c9c0ae] px-4 font-semibold")}
        >
          + Seri e re
        </Link>
        <Link
          href="/dashboard/books/new"
          className={buttonClasses("primary", "md", "min-h-11 rounded-[3px] px-4 font-bold sm:px-5")}
        >
          + Libër i ri
        </Link>
      </div>
    </div>
  );

  const messages = (
    <>
      {error && (
        <Alert variant="error" className="mt-6">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-6">
          {success}
        </Alert>
      )}
      {ebookCoverWarning && (
        <Alert variant="warning" className="mt-6">
          {ebookCoverWarning}
        </Alert>
      )}
    </>
  );

  if (attention.kind === "zero-books") {
    return (
      <main className="page-container flex-1 pb-16">
        {heading}
        {messages}

        <EmptyState
          className="mt-8 rounded-[4px] border-solid"
          title="Libri juaj i parë fillon këtu."
          description="Ngarkoni dorëshkrimin, vendosni çmimin dhe publikojeni kur të jeni gati."
          action={
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/dashboard/books/new"
                className={buttonClasses("primary", "md", "min-h-11 rounded-[3px] px-5 font-bold")}
              >
                Libër i ri
              </Link>
              <Link href="/si-funksionon" className={TEXT_LINK_CLASSES}>
                Si funksionon botimi
              </Link>
            </div>
          }
        />
      </main>
    );
  }

  const sales = await loadDashboardSales({ supabase, authorId: user.id, books: allBooks, now: new Date() });
  // ADMIN-2-TAKEDOWN (G): the notices for books Librum took down, read
  // with the author's own session (RLS: own rows; named columns only).
  const takedownNotices = await loadAuthorTakedownNotices(supabase, user.id);
  const schedulerEnabled = isSchedulerEnabled(process.env.PAYOUT_SCHEDULER_ENABLED);

  // BD15 P6: the series names for the cards and the group headings
  // (the author's own rows, own session). Display only: unreadable names
  // show the books outside a series, with a visible line.
  const seriesIds = Array.from(new Set(allBooks.map((book) => book.series_id).filter((id): id is string => !!id)));
  const seriesRead =
    seriesIds.length > 0
      ? await supabase.from("series").select("id, title").eq("author_id", user.id).returns<{ id: string; title: string }[]>()
      : { data: [], error: null };
  if (seriesRead.error) console.error("DashboardPage: series read failed", { code: seriesRead.error.code ?? null });
  const seriesTitles = new Map((seriesRead.data ?? []).map((row) => [row.id, row.title]));

  // BD15 P6: the waiting changes of the author's live books (see above).
  // BD16 P2: a pre-order keeps waiting changes like a live book.
  const liveIds = allBooks
    .filter((book) => book.status === "published" || book.status === "preorder")
    .map((book) => book.id);
  const pendingRead =
    liveIds.length > 0 ? await readShelfPendingChanges(createCatalogWriteClient(), liveIds) : null;
  // BD16 P2: how many readers wait for each pre-order (a count only; the
  // author's own books; display only, null when unreadable).
  const preorderIds = allBooks.filter((book) => book.status === "preorder").map((book) => book.id);
  const waitingReaders =
    preorderIds.length > 0 ? await countWaitingReaders(createCatalogWriteClient(), preorderIds) : null;

  const states = new Map<string, ShelfState>();
  for (const book of allBooks) {
    const review = reviewNotices.get(book.id) ?? null;
    const waiting = pendingRead?.ok ? (pendingRead.byBook.get(book.id) ?? null) : null;
    const hasPendingChanges =
      waiting !== null &&
      changedPendingFields(
        {
          filePath: book.file_path,
          coverPath: book.cover_path,
          description: book.description,
          isAdult: book.is_adult ?? false,
          originalAuthor: book.original_author,
        },
        waiting.pending,
      ).length > 0;
    const pendingSentBack =
      waiting !== null &&
      review?.sentBack != null &&
      Date.parse(waiting.createdAt) <= Date.parse(review.sentBack.sentBackAt);
    states.set(
      book.id,
      resolveShelfState(book, {
        takenDown: takedownNotices.has(book.id),
        review,
        hasPendingChanges,
        pendingSentBack,
      }),
    );
  }

  const query = parseShelfQuery({ sort: rawSort, filter: rawFilter, view: rawView, q: rawQ });
  const needle = query.q.toLocaleLowerCase();
  const listedBooks = allBooks.filter(
    (book) =>
      matchesShelfFilter(states.get(book.id) ?? "draft", query.filter) &&
      (needle === "" || book.title.toLocaleLowerCase().includes(needle)),
  );
  const groups = groupShelfBooks(sortShelfBooks(listedBooks, query.sort), query.view, seriesTitles);
  const showGroupHeadings = groups.some((group) => group.seriesId !== null);

  const draftIncompleteCount =
    attention.kind === "continue-draft"
      ? getPublishChecklist(
          allBooks.find((book) => book.id === attention.book.id) ?? allBooks[0],
        ).filter((item) => !item.done).length
      : 0;

  return (
    <main className="page-container flex-1 pb-16">
      {heading}
      {messages}

      {/* PR-G: this copy must stay CONDITIONAL, never a hardcoded banner.
          On the protected staging deployment with PAID_PUBLISHING_MODE set,
          canPublishPaidTitle() is true and this alert correctly disappears;
          hardcoding it would make the app lie during that controlled test. */}
      {attention.kind === "paid-publishing-unavailable" && (
        <Alert
          variant="warning"
          title="Botimi me pagesë dhe pagesat për autorët nuk kanë nisur ende."
          className="mt-6"
        >
          {/* PR-G: no payout link in this alert: nothing an author can
              set up changes this outcome -- paid publishing is gated by
              canPublishPaidTitle() alone. */}
          <p>
            Mund të vazhdoni të publikoni libra falas, ndërsa Librum përfundon
            sistemet e pagesave.
          </p>
        </Alert>
      )}

      {attention.kind === "continue-draft" && (
        <Alert variant="info" title="Vazhdoni draftin tuaj" className="mt-6">
          <p>
            {attention.book.title}
            {draftIncompleteCount > 0 &&
              ` — ${draftIncompleteCount === 1 ? "1 gjë" : `${draftIncompleteCount} gjëra`} për të parë para publikimit.`}
          </p>
          <Link
            href={editorPath(attention.book.id, "details")}
            className="focus-ring rounded-sm font-medium underline"
          >
            Vazhdoni redaktimin
          </Link>
        </Alert>
      )}

      <MoneySummary
        sales={sales}
        nextPayoutCycle={
          schedulerEnabled ? formatPayoutCycleDate(computeNextPayoutCycleDate()) : "Nuk është caktuar ende"
        }
      />

      <section aria-labelledby="your-books-heading" className="mt-8 sm:mt-10">
        <h2 id="your-books-heading" className="font-serif text-2xl font-normal text-primary">
          Librat tuaj
        </h2>
        <div className="mt-4 rounded-[4px] border border-border bg-surface">
          <form
            action="/dashboard"
            method="get"
            role="search"
            className="grid grid-cols-2 items-end gap-3 border-b border-border px-4 py-4 sm:px-5 lg:grid-cols-[repeat(3,minmax(0,11rem))_1fr_auto]"
          >
            <ShelfSelect id="shelf-sort" name="sort" label="Rendit sipas" value={query.sort} options={SHELF_SORTS} />
            <ShelfSelect id="shelf-filter" name="filter" label="Filtro" value={query.filter} options={SHELF_FILTERS} />
            <ShelfSelect id="shelf-view" name="view" label="Shfaq" value={query.view} options={SHELF_VIEWS} />
            <label htmlFor="dashboard-book-search" className="col-span-2 flex flex-col gap-1 text-sm text-muted lg:col-span-1">
              Kërkoni sipas titullit
              <input
                id="dashboard-book-search"
                type="search"
                name="q"
                defaultValue={query.q}
                placeholder="Titulli"
                className="focus-ring min-h-11 min-w-0 rounded-[3px] border border-[#8c8472] bg-surface px-3 text-sm text-foreground"
              />
            </label>
            <button
              type="submit"
              className={buttonClasses("outline", "sm", "col-span-2 min-h-11 rounded-[3px] border-[#c9c0ae] px-4 font-semibold lg:col-span-1")}
            >
              Shfaqni
            </button>
          </form>

          {pendingRead && !pendingRead.ok && (
            <p role="status" className="border-b border-border px-4 py-3 text-sm text-[#b42318] sm:px-5">
              Nuk mundëm të kontrollojmë ndryshimet e papublikuara të librave live. Rifreskoni faqen.
            </p>
          )}
          {seriesRead.error && (
            <p role="status" className="border-b border-border px-4 py-3 text-sm text-[#b42318] sm:px-5">
              Emrat e serive nuk u ngarkuan. Rifreskoni faqen.
            </p>
          )}

          {groups.length === 0 ? (
            <EmptyState className="m-4 border-0 sm:m-5" title="Asnjë libër nuk përputhet me kërkimin." />
          ) : (
            groups.map((group) => (
              <section
                key={group.seriesId ?? "no-series"}
                aria-label={group.seriesTitle ? `Seria ${group.seriesTitle}` : showGroupHeadings ? "Libra më vete" : undefined}
              >
                {showGroupHeadings && (
                  <h3 className="flex flex-wrap items-baseline gap-x-3 border-b border-[#efe9dd] px-4 pt-5 pb-2 font-serif text-lg font-normal text-primary sm:px-5">
                    {group.seriesTitle ? (
                      <>
                        <span className="font-sans text-xs font-bold uppercase tracking-[0.06em] text-muted">Seri</span>
                        {group.seriesTitle}
                        <span className="font-sans text-sm text-muted">
                          {group.books.length === 1 ? "1 libër" : `${group.books.length} libra`}
                        </span>
                      </>
                    ) : (
                      <span className="font-sans text-xs font-bold uppercase tracking-[0.06em] text-muted">Libra më vete</span>
                    )}
                  </h3>
                )}
                <ul className="divide-y divide-[#efe9dd]">
                  {group.books.map((book) => {
                    const coverUrl = book.cover_path
                      ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
                      : null;
                    const state = states.get(book.id) ?? "draft";
                    return (
                      <AuthorBookRow
                        key={book.id}
                        book={book}
                        coverUrl={coverUrl}
                        state={state}
                        seriesTitle={
                          group.seriesId === null && book.series_id ? (seriesTitles.get(book.series_id) ?? null) : null
                        }
                        recentCopies={sales.ok ? (sales.summary.recentCopiesByBookId.get(book.id) ?? 0) : null}
                        takedown={takedownNotices.get(book.id) ?? null}
                        review={reviewNotices.get(book.id) ?? null}
                        waitingReaders={waitingReaders?.get(book.id) ?? (waitingReaders ? 0 : null)}
                        missing={
                          state === "draft"
                            ? getPublishChecklist(book)
                                .filter((item) => !item.done)
                                .map((item) => item.label)
                            : []
                        }
                      />
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-serif text-2xl font-normal text-primary">Mjetet</h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {DASHBOARD_TOOLS.map((tool) => (
            <li key={tool.href}>
              <Link
                href={tool.href}
                className="focus-ring flex h-full flex-col gap-1.5 rounded-[4px] border border-border bg-surface p-5 transition-colors hover:bg-surface-hover"
              >
                <span className="font-semibold text-primary">{tool.label}</span>
                <span className="text-sm text-muted">{tool.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

// BD15 P6: one labelled select of the shelf toolbar.
function ShelfSelect({
  id,
  name,
  label,
  value,
  options,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm text-muted">
      {label}
      <select
        id={id}
        name={name}
        defaultValue={value}
        className="focus-ring min-h-11 min-w-0 rounded-[3px] border border-[#8c8472] bg-surface px-2 text-sm text-foreground"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ALL-TXN-CURRENCY-4 (as on the Sales page): one line per currency,
// never a combined figure.
function CurrencyTotalsText({ totals, emptyLabel }: { totals: CurrencyTotals; emptyLabel: string }) {
  if (totals.totals.length === 0) {
    return <>{emptyLabel}</>;
  }
  return (
    <>
      {totals.totals.map((total) => (
        <span key={total.currency} className="block">
          {formatTransactionMinorUnits(total.amountMinor, total.currency)}
        </span>
      ))}
    </>
  );
}

function UnresolvedNote({ totals }: { totals: CurrencyTotals }) {
  if (totals.unresolvedCount === 0) return null;
  return (
    <p className="text-xs text-muted">
      {totals.unresolvedCount === 1
        ? "1 shitje nuk përfshihet: monedha e saj nuk u përcaktua dot."
        : `${totals.unresolvedCount} shitje nuk përfshihen: monedha e tyre nuk u përcaktua dot.`}
    </p>
  );
}

function MoneySummary({
  sales,
  nextPayoutCycle,
}: {
  sales: DashboardSalesResult;
  nextPayoutCycle: string;
}) {
  if (!sales.ok) {
    return (
      <section aria-label="Përmbledhja e parave" className={`mt-6 sm:mt-8 ${BOX_CLASSES}`}>
        <p className="text-sm text-foreground">Të dhënat e shitjeve nuk u ngarkuan. Provoni përsëri.</p>
      </section>
    );
  }

  const { salesThisMonth, salesLastMonth, netThisMonth, netAllTime } = sales.summary;
  const comparison = formatMonthComparison(salesThisMonth, salesLastMonth);

  return (
    <section aria-label="Përmbledhja e parave" className="mt-6 sm:mt-8">
      {/* Phone: the compact two-figure box from the phone mockup. */}
      <div className={`${BOX_CLASSES} grid grid-cols-2 gap-4 sm:hidden`}>
        <div>
          <p className={BOX_LABEL_CLASSES}>Këtë muaj</p>
          <p className="font-serif text-2xl leading-tight text-primary">
            <CurrencyTotalsText totals={netThisMonth} emptyLabel="Ende pa shitje" />
          </p>
        </div>
        <div>
          <p className={BOX_LABEL_CLASSES}>Shitje</p>
          <p className="font-serif text-2xl leading-tight text-primary">{salesThisMonth}</p>
        </div>
        <Link href="/dashboard/sales" className={`${TEXT_LINK_CLASSES} col-span-2`}>
          Shikoni shitjet dhe fitimet &rarr;
        </Link>
      </div>

      <div className="hidden gap-4 sm:grid sm:grid-cols-2 lg:grid-cols-4">
        <div className={`${BOX_CLASSES} flex flex-col gap-1.5`}>
          <p className={BOX_LABEL_CLASSES}>Shitje këtë muaj</p>
          <p className={BOX_FIGURE_CLASSES}>{salesThisMonth}</p>
          <p className={`text-[0.8125rem] ${salesThisMonth > salesLastMonth ? "text-[#2f6b4f]" : "text-muted"}`}>
            {comparison}
          </p>
        </div>
        <div className={`${BOX_CLASSES} flex flex-col gap-1.5`}>
          <p className={BOX_LABEL_CLASSES}>Të ardhurat neto këtë muaj</p>
          <p className={BOX_FIGURE_CLASSES}>
            <CurrencyTotalsText totals={netThisMonth} emptyLabel="Ende pa shitje" />
          </p>
          <UnresolvedNote totals={netThisMonth} />
        </div>
        <div className={`${BOX_CLASSES} flex flex-col gap-1.5`}>
          <p className={BOX_LABEL_CLASSES}>Pagesa e radhës për autorin</p>
          <p className="font-serif text-2xl leading-tight text-primary">{nextPayoutCycle}</p>
          <Link href="/dashboard/balance" className={TEXT_LINK_CLASSES}>
            Shikoni bilancin &rarr;
          </Link>
        </div>
        <div className={`${BOX_CLASSES} flex flex-col gap-1.5`}>
          <p className={BOX_LABEL_CLASSES}>Të ardhurat neto gjithsej</p>
          <p className={BOX_FIGURE_CLASSES}>
            <CurrencyTotalsText totals={netAllTime} emptyLabel="Ende pa shitje" />
          </p>
          <UnresolvedNote totals={netAllTime} />
          <Link href="/dashboard/sales" className={TEXT_LINK_CLASSES}>
            Shikoni shitjet dhe fitimet &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

const DASHBOARD_TOOLS: { href: string; label: string; description: string }[] = [
  {
    href: "/dashboard/bundles",
    label: "Paketat",
    description: "Bashkoni disa libra në një ofertë.",
  },
  {
    href: "/dashboard/series",
    label: "Seritë",
    description: "Renditni librat e lidhur sipas radhës së leximit.",
  },
  {
    href: "/dashboard/discounts",
    label: "Zbritjet",
    description: "Krijoni kode promocionale për shitjet që lejohen.",
  },
  {
    href: "/dashboard/profile",
    label: "Profili",
    description: "Menaxhoni të dhënat tuaja publike si autor.",
  },
];
