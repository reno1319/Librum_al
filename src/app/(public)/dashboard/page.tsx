import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPublishChecklist } from "@/lib/publish-checklist";
import { resolveDashboardAttention } from "@/lib/dashboard-attention";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import { isSchedulerEnabled } from "@/lib/payout-scheduler";
import { computeNextPayoutCycleDate, formatPayoutCycleDate } from "@/lib/payout-cycle";
import { formatTransactionMinorUnits, type CurrencyTotals } from "@/lib/transaction-money";
import { AuthorBookRow } from "@/components/author-book-row";
import { loadAuthorTakedownNotices } from "@/lib/book-takedowns";
import { loadAuthorReviewNotices } from "@/lib/book-reviews";
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

type BookTab = "all" | "published" | "drafts";

const TEXT_LINK_CLASSES =
  "focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";
const BOX_CLASSES = "rounded-[4px] border border-border bg-surface p-5";
const BOX_LABEL_CLASSES = "text-[0.8125rem] uppercase tracking-[0.06em] text-muted";
const BOX_FIGURE_CLASSES = "font-serif text-[2rem] leading-tight text-primary";

function parseTab(value: string | undefined): BookTab {
  return value === "published" || value === "drafts" ? value : "all";
}

function dashboardHref(tab: BookTab, q: string): string {
  const params = new URLSearchParams();
  if (tab !== "all") params.set("tab", tab);
  if (q) params.set("q", q);
  const query = params.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; tab?: string; q?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive page -- renders books.price_all
  // via AuthorBookRow (exhaustive route audit) -- checked as the first
  // statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { error: rawError, success: rawSuccess, tab: rawTab, q: rawQ } = await searchParams;

  const error = pageErrorMessage(rawError);

  const success = pageSuccessMessage(rawSuccess);
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

  const attention = resolveDashboardAttention({
    books: allBooks,
    paidPublishingAvailable: canPublishPaidTitle(),
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
      <Link
        href="/dashboard/books/new"
        className={buttonClasses("primary", "md", "min-h-11 shrink-0 rounded-[3px] px-4 font-bold sm:px-5")}
      >
        Libër i ri
      </Link>
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
  // ADMIN-3-REVIEW (F, N9): the author's review rows, one read.
  const reviewNotices = await loadAuthorReviewNotices(supabase, user.id);
  const schedulerEnabled = isSchedulerEnabled(process.env.PAYOUT_SCHEDULER_ENABLED);

  const publishedCount = allBooks.filter((book) => book.status === "published").length;
  const draftCount = allBooks.filter((book) => book.status === "draft").length;

  const tab = parseTab(rawTab);
  const q = (rawQ ?? "").trim();
  const needle = q.toLocaleLowerCase();
  const listedBooks = allBooks.filter(
    (book) =>
      (tab === "all" ||
        (tab === "published" && book.status === "published") ||
        (tab === "drafts" && book.status === "draft")) &&
      (needle === "" || book.title.toLocaleLowerCase().includes(needle)),
  );

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
            href={`/dashboard/books/${attention.book.id}/edit`}
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
            <nav aria-label="Librat tuaj" className="flex flex-wrap gap-2">
              <BookTabLink label={`Të gjithë (${allBooks.length})`} href={dashboardHref("all", q)} active={tab === "all"} />
              <BookTabLink
                label={`Të publikuar (${publishedCount})`}
                href={dashboardHref("published", q)}
                active={tab === "published"}
                disabled={publishedCount === 0}
              />
              <BookTabLink
                label={`Drafte (${draftCount})`}
                href={dashboardHref("drafts", q)}
                active={tab === "drafts"}
                disabled={draftCount === 0}
              />
            </nav>
            <form action="/dashboard" method="get" role="search" className="flex w-full items-center gap-2 sm:w-auto">
              <label htmlFor="dashboard-book-search" className="text-sm text-muted">
                Kërkoni
              </label>
              {tab !== "all" && <input type="hidden" name="tab" value={tab} />}
              <input
                id="dashboard-book-search"
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Titulli"
                className="focus-ring min-h-11 min-w-0 flex-1 rounded-[3px] border border-[#8c8472] bg-surface px-3 text-sm sm:w-52 sm:flex-none"
              />
            </form>
          </div>

          {listedBooks.length === 0 ? (
            <EmptyState className="m-4 border-0 sm:m-5" title="Asnjë libër nuk përputhet me kërkimin." />
          ) : (
            <ul className="divide-y divide-[#efe9dd]">
              {listedBooks.map((book) => {
                const coverUrl = book.cover_path
                  ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
                  : null;
                return (
                  <AuthorBookRow
                    key={book.id}
                    book={book}
                    coverUrl={coverUrl}
                    recentCopies={sales.ok ? (sales.summary.recentCopiesByBookId.get(book.id) ?? 0) : null}
                    takedown={takedownNotices.get(book.id) ?? null}
                    review={reviewNotices.get(book.id) ?? null}
                    missing={
                      book.status === "draft"
                        ? getPublishChecklist(book)
                            .filter((item) => !item.done)
                            .map((item) => item.label)
                        : []
                    }
                  />
                );
              })}
            </ul>
          )}
        </div>
        <Link href="/dashboard/books" className={`${TEXT_LINK_CLASSES} mt-4 inline-block`}>
          Shikoni të gjithë librat &rarr;
        </Link>
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

function BookTabLink({
  label,
  href,
  active,
  disabled = false,
}: {
  label: string;
  href: string;
  active: boolean;
  disabled?: boolean;
}) {
  const base = "flex min-h-11 items-center rounded-[3px] border px-3.5 text-sm font-semibold";
  // An empty tab (e.g. Drafts (0)) is shown but not a link: there is
  // nothing to list there.
  if (disabled && !active) {
    return <span className={`${base} border-border bg-surface text-muted`}>{label}</span>;
  }
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`focus-ring ${base} transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-[#c9c0ae] bg-surface text-foreground hover:bg-surface-hover"
      }`}
    >
      {label}
    </Link>
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
