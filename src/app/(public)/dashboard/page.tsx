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

export const metadata: Metadata = {
  title: "Dashboard",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see the exhaustive
// route audit (books.price_all is rendered via AuthorBookRow below,
// on the main post-login author hub).
export const dynamic = "force-dynamic";

// LIBRUM 2.0 UI-6: DASHBOARD = AUTHOR OPERATIONS / WORKSPACE. This page
// is the hub -- one prioritized next action, the author's books, and
// quiet link-outs to Sales, Payouts, and secondary tools.
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
// PR-G: stripe_payouts_enabled is read HERE AND ONLY HERE on this page,
// and only to choose the payout status LABEL. It is NOT a publishing
// input any more and must never become one again: paid publishing is
// decided by canPublishPaidTitle() alone (see performPublish() in
// dashboard/books/actions.ts, which reads no profiles row at all). The
// column stays because an author's legacy Stripe Connect state is real
// operational history that later payout work will still need to know.

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

  const { error, success, tab: rawTab, q: rawQ } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_account_id, stripe_payouts_enabled")
    .eq("id", user.id)
    .single();

  const { data: books } = await supabase
    .from("books")
    .select("*")
    .eq("author_id", user.id)
    .order("created_at", { ascending: false })
    .returns<Book[]>();

  const allBooks = books ?? [];
  // Payout STATUS only -- see the note at the top of this file. The
  // attention decision below takes the paid-publishing capability
  // instead, which is the thing performPublish() actually enforces.
  const payoutsEnabled = !!profile?.stripe_payouts_enabled;

  const attention = resolveDashboardAttention({
    books: allBooks,
    paidPublishingAvailable: canPublishPaidTitle(),
  });

  const heading = (
    <div className="mt-5 flex items-start justify-between gap-4 sm:mt-8 sm:items-end">
      <div>
        <h1 className="font-serif text-[1.875rem] font-normal leading-tight text-primary sm:text-[2.5rem]">
          Your dashboard
        </h1>
        <p className="mt-2 text-muted">Manage your books, sales, and earnings.</p>
      </div>
      <Link
        href="/dashboard/books/new"
        className={buttonClasses("primary", "md", "min-h-11 shrink-0 rounded-[3px] px-4 font-bold sm:px-5")}
      >
        New book
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
          title="Your first book starts here."
          description="Upload your manuscript, set a price, and publish when you're ready."
          action={
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/dashboard/books/new"
                className={buttonClasses("primary", "md", "min-h-11 rounded-[3px] px-5 font-bold")}
              >
                New book
              </Link>
              <Link href="/how-it-works" className={TEXT_LINK_CLASSES}>
                How publishing works
              </Link>
            </div>
          }
        />
      </main>
    );
  }

  const sales = await loadDashboardSales({ supabase, authorId: user.id, books: allBooks, now: new Date() });
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

  const payoutStatus = !profile?.stripe_account_id
    ? "not-connected"
    : payoutsEnabled
      ? "enabled"
      : "pending";
  const payoutLabel =
    payoutStatus === "not-connected"
      ? "Payout setup not available"
      : payoutStatus === "pending"
        ? "Payout setup not available"
        : "Legacy payout account on file";

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
          title="Paid publishing and author payout setup have not launched yet."
          className="mt-6"
        >
          {/* PR-G: the "Payout details" link to /dashboard/payouts was
              removed from THIS alert only. That page cannot change this
              outcome -- paid publishing is gated by canPublishPaidTitle()
              and nothing on the payouts page affects it -- so the link was
              a dead end from the alert that tells an author they cannot
              publish a priced title. The payout-status block further down
              this page, and its own links, are unchanged: they report real
              author-payout state, which is a different question. */}
          <p>
            You can continue to publish free books while Librum completes
            its payment and payout systems.
          </p>
        </Alert>
      )}

      {attention.kind === "continue-draft" && (
        <Alert variant="info" title="Continue your draft" className="mt-6">
          <p>
            {attention.book.title}
            {draftIncompleteCount > 0 &&
              ` — ${draftIncompleteCount} thing${draftIncompleteCount === 1 ? "" : "s"} to consider before publishing.`}
          </p>
          <Link
            href={`/dashboard/books/${attention.book.id}/edit`}
            className="focus-ring rounded-sm font-medium underline"
          >
            Continue editing
          </Link>
        </Alert>
      )}

      <MoneySummary
        sales={sales}
        nextPayoutCycle={
          schedulerEnabled ? formatPayoutCycleDate(computeNextPayoutCycleDate()) : "Not scheduled yet"
        }
      />

      <section aria-labelledby="your-books-heading" className="mt-8 sm:mt-10">
        <h2 id="your-books-heading" className="font-serif text-2xl font-normal text-primary">
          Your books
        </h2>
        <div className="mt-4 rounded-[4px] border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
            <nav aria-label="Your books" className="flex flex-wrap gap-2">
              <BookTabLink label={`All (${allBooks.length})`} href={dashboardHref("all", q)} active={tab === "all"} />
              <BookTabLink
                label={`Published (${publishedCount})`}
                href={dashboardHref("published", q)}
                active={tab === "published"}
                disabled={publishedCount === 0}
              />
              <BookTabLink
                label={`Drafts (${draftCount})`}
                href={dashboardHref("drafts", q)}
                active={tab === "drafts"}
                disabled={draftCount === 0}
              />
            </nav>
            <form action="/dashboard" method="get" role="search" className="flex w-full items-center gap-2 sm:w-auto">
              <label htmlFor="dashboard-book-search" className="text-sm text-muted">
                Search
              </label>
              {tab !== "all" && <input type="hidden" name="tab" value={tab} />}
              <input
                id="dashboard-book-search"
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Title"
                className="focus-ring min-h-11 min-w-0 flex-1 rounded-[3px] border border-[#8c8472] bg-surface px-3 text-sm sm:w-52 sm:flex-none"
              />
            </form>
          </div>

          {listedBooks.length === 0 ? (
            <EmptyState className="m-4 border-0 sm:m-5" title="No books match your search." />
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
          View all books &rarr;
        </Link>
      </section>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <section className={BOX_CLASSES}>
          <h2 className="font-serif text-lg font-normal text-primary">Sales &amp; earnings</h2>
          <p className="mt-1 text-sm text-muted">See units sold and your net revenue.</p>
          <Link href="/dashboard/sales" className={`${TEXT_LINK_CLASSES} mt-3 inline-block`}>
            View sales and earnings &rarr;
          </Link>
        </section>

        <section className={BOX_CLASSES}>
          <h2 className="font-serif text-lg font-normal text-primary">Financial balance</h2>
          <p className="mt-1 text-sm text-muted">Your ledger balance, pending settlement, and payout history.</p>
          <Link href="/dashboard/balance" className={`${TEXT_LINK_CLASSES} mt-3 inline-block`}>
            View financial balance &rarr;
          </Link>
        </section>

        <section className={BOX_CLASSES}>
          <h2 className="font-serif text-lg font-normal text-primary">Payouts</h2>
          <p className="mt-1 text-sm">{payoutLabel}</p>
          <Link href="/dashboard/payouts" className={`${TEXT_LINK_CLASSES} mt-3 inline-block`}>
            View payouts &rarr;
          </Link>
        </section>
      </div>

      <section className="mt-10">
        <h2 className="font-serif text-2xl font-normal text-primary">Tools</h2>
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
        ? "1 sale is not included: its currency could not be determined."
        : `${totals.unresolvedCount} sales are not included: their currency could not be determined.`}
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
      <section aria-label="Money summary" className={`mt-6 sm:mt-8 ${BOX_CLASSES}`}>
        <p className="text-sm text-foreground">Could not load sales data. Please try again.</p>
      </section>
    );
  }

  const { salesThisMonth, salesLastMonth, netThisMonth, netAllTime } = sales.summary;
  const comparison = formatMonthComparison(salesThisMonth, salesLastMonth);

  return (
    <section aria-label="Money summary" className="mt-6 sm:mt-8">
      {/* Phone: the compact two-figure box from the phone mockup. */}
      <div className={`${BOX_CLASSES} grid grid-cols-2 gap-4 sm:hidden`}>
        <div>
          <p className={BOX_LABEL_CLASSES}>This month</p>
          <p className="font-serif text-2xl leading-tight text-primary">
            <CurrencyTotalsText totals={netThisMonth} emptyLabel="No sales yet" />
          </p>
        </div>
        <div>
          <p className={BOX_LABEL_CLASSES}>Sales</p>
          <p className="font-serif text-2xl leading-tight text-primary">{salesThisMonth}</p>
        </div>
        <Link href="/dashboard/sales" className={`${TEXT_LINK_CLASSES} col-span-2`}>
          View sales and earnings &rarr;
        </Link>
      </div>

      <div className="hidden gap-4 sm:grid sm:grid-cols-2 lg:grid-cols-4">
        <div className={`${BOX_CLASSES} flex flex-col gap-1.5`}>
          <p className={BOX_LABEL_CLASSES}>Sales this month</p>
          <p className={BOX_FIGURE_CLASSES}>{salesThisMonth}</p>
          <p className={`text-[0.8125rem] ${salesThisMonth > salesLastMonth ? "text-[#2f6b4f]" : "text-muted"}`}>
            {comparison}
          </p>
        </div>
        <div className={`${BOX_CLASSES} flex flex-col gap-1.5`}>
          <p className={BOX_LABEL_CLASSES}>Net revenue this month</p>
          <p className={BOX_FIGURE_CLASSES}>
            <CurrencyTotalsText totals={netThisMonth} emptyLabel="No sales yet" />
          </p>
          <UnresolvedNote totals={netThisMonth} />
        </div>
        <div className={`${BOX_CLASSES} flex flex-col gap-1.5`}>
          <p className={BOX_LABEL_CLASSES}>Next payout cycle</p>
          <p className="font-serif text-2xl leading-tight text-primary">{nextPayoutCycle}</p>
          <Link href="/dashboard/balance" className={TEXT_LINK_CLASSES}>
            View financial balance &rarr;
          </Link>
        </div>
        <div className={`${BOX_CLASSES} flex flex-col gap-1.5`}>
          <p className={BOX_LABEL_CLASSES}>Net revenue all time</p>
          <p className={BOX_FIGURE_CLASSES}>
            <CurrencyTotalsText totals={netAllTime} emptyLabel="No sales yet" />
          </p>
          <UnresolvedNote totals={netAllTime} />
          <Link href="/dashboard/sales" className={TEXT_LINK_CLASSES}>
            View sales and earnings &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

const DASHBOARD_TOOLS: { href: string; label: string; description: string }[] = [
  {
    href: "/dashboard/bundles",
    label: "Bundles",
    description: "Group multiple books into one offer.",
  },
  {
    href: "/dashboard/series",
    label: "Series",
    description: "Organize related books in reading order.",
  },
  {
    href: "/dashboard/discounts",
    label: "Discounts",
    description: "Create promotional codes for eligible sales.",
  },
  {
    href: "/dashboard/profile",
    label: "Profile",
    description: "Manage your public author information.",
  },
];
