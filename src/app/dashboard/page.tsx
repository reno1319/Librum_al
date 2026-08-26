import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPublishChecklist } from "@/lib/publish-checklist";
import { resolveDashboardAttention } from "@/lib/dashboard-attention";
import { AuthorBookRow } from "@/components/author-book-row";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import type { Book } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard",
};

// LIBRUM 2.0 UI-6: DASHBOARD = AUTHOR OPERATIONS / WORKSPACE. This page
// is the hub -- one prioritized next action, two cheap/authoritative
// counts, the author's most recent books, and quiet link-outs to
// Sales, Payouts, and secondary tools. Deliberately no persistent
// dashboard subnav in this pass (see dashboard/layout.tsx, untouched)
// and deliberately no sales/earnings NUMBER here -- see the "Sales &
// earnings" section below for why.
//
// Still exactly 2 queries, same as before this pass (profiles,
// books) -- the profiles select grew by one column
// (stripe_account_id, alongside the existing stripe_payouts_enabled)
// to distinguish "never connected" from "connected but pending" for
// the payout status block, not a new query.
const RECENT_BOOKS_LIMIT = 5;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;
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
  const payoutsEnabled = !!profile?.stripe_payouts_enabled;

  const attention = resolveDashboardAttention({ books: allBooks, payoutsEnabled });

  const newBookAction = (
    <Link href="/dashboard/books/new" className={buttonClasses("primary", "md")}>
      New book
    </Link>
  );

  if (attention.kind === "zero-books") {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <PageHeader
          title="Your dashboard"
          description="Manage your books, sales, and earnings."
          actions={newBookAction}
        />

        {error && (
          <Alert variant="error" className="mt-4">
            {error}
          </Alert>
        )}
        {success && (
          <Alert variant="success" className="mt-4">
            {success}
          </Alert>
        )}

        <EmptyState
          className="mt-8"
          title="Your first book starts here."
          description="Upload your manuscript, set a price, and publish when you're ready."
          action={
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Link href="/dashboard/books/new" className={buttonClasses("primary", "md")}>
                New book
              </Link>
              <Link
                href="/how-it-works"
                className="focus-ring rounded-sm text-sm font-medium text-primary hover:underline"
              >
                How publishing works
              </Link>
            </div>
          }
        />
      </main>
    );
  }

  const publishedCount = allBooks.filter((book) => book.status === "published").length;
  const draftCount = allBooks.filter((book) => book.status === "draft").length;
  const recentBooks = allBooks.slice(0, RECENT_BOOKS_LIMIT);

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
      ? "Connect payouts"
      : payoutStatus === "pending"
        ? "Finish payout setup"
        : "Payouts active";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <PageHeader
        title="Your dashboard"
        description="Manage your books, sales, and earnings."
        actions={newBookAction}
      />

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      {attention.kind === "payout-setup" && (
        <Alert variant="warning" title="Finish payout setup to publish paid books." className="mt-6">
          <Link href="/dashboard/payouts" className="focus-ring rounded-sm font-medium underline">
            Manage payouts
          </Link>
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

      <div className="mt-8 flex gap-8">
        <div>
          <p className="text-sm text-muted">Published</p>
          <p className="mt-1 font-serif text-2xl font-semibold">{publishedCount}</p>
        </div>
        <div>
          <p className="text-sm text-muted">Drafts</p>
          <p className="mt-1 font-serif text-2xl font-semibold">{draftCount}</p>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="font-serif text-xl font-semibold">Your books</h2>
        <ul className="mt-4 divide-y divide-border">
          {recentBooks.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
              : null;
            return <AuthorBookRow key={book.id} book={book} coverUrl={coverUrl} />;
          })}
        </ul>
        <Link
          href="/dashboard/books"
          className="focus-ring mt-4 inline-block rounded-sm text-sm font-medium text-primary hover:underline"
        >
          View all books &rarr;
        </Link>
      </section>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <section className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Sales &amp; earnings</h2>
          <p className="mt-1 text-sm text-muted">See units sold and your net revenue.</p>
          <Link
            href="/dashboard/sales"
            className="focus-ring mt-3 inline-block rounded-sm text-sm font-medium text-primary hover:underline"
          >
            View sales and earnings &rarr;
          </Link>
        </section>

        <section className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Payouts</h2>
          <p className="mt-1 text-sm">{payoutLabel}</p>
          <Link
            href="/dashboard/payouts"
            className="focus-ring mt-3 inline-block rounded-sm text-sm font-medium text-primary hover:underline"
          >
            Manage payouts &rarr;
          </Link>
        </section>
      </div>

      <section className="mt-10 border-t border-border pt-8">
        <h2 className="font-serif text-lg font-semibold">Tools</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {DASHBOARD_TOOLS.map((tool) => (
            <li key={tool.href}>
              <Link
                href={tool.href}
                className="focus-ring block rounded-lg border border-border bg-surface px-4 py-3 hover:bg-surface-hover"
              >
                <span className="text-sm font-medium">{tool.label}</span>
                <p className="mt-0.5 text-xs text-muted">{tool.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
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
