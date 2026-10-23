import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { formControlClasses } from "@/lib/form-styles";
import { buttonClasses } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import type { Metadata } from "next";
import { readActiveTakedownBookIds, readPendingReviewBookIds, readSuspendedAuthorIds } from "./admin-book-reads";
import {
  BOOKS_FILTERS,
  BOOKS_PAGE_SIZE,
  bookStateLabel,
  booksListHref,
  booksSearchPattern,
  buildBooksSearchOrFilter,
  parseBooksFilter,
  parseBooksPage,
  parseBooksSearch,
  type BookStateLabel,
} from "./book-admin-logic";

export const metadata: Metadata = {
  title: "Books",
};

// Reads the catalogue on every request (status changes at any time).
export const dynamic = "force-dynamic";

// ADMIN-2-TAKEDOWN (B): every book in the catalogue, drafts included, so
// staff can find one to open and, from its page, unpublish it.
// requireStaff("reports.view") is this page's own gate; the reads then
// use the service-role client (M2), so drafts and taken-down books show
// whether or not PEN-NAMES-2's staff books policy (contract step, 13a)
// is in place yet -- before it, a staff session sees published books
// only. Search by
// title or author (the book's pen name, or the account's public author
// name), filter Live / Draft / Taken down, 50 per page, newest first.
// ADMIN-3-REVIEW (G): and "In review" -- a draft with a pending review
// (read the same way); "Draft" excludes those and taken-down books.
const LIST_ID_LIMIT = 200;
const LOAD_ERROR = "Couldn't load the books. Please try again.";

type BookListRow = {
  id: string;
  title: string;
  status: string;
  author_id: string;
  published_at: string | null;
  created_at: string;
  pen: { name: string } | null;
};

const CHIP_CLASSES: Record<BookStateLabel, string> = {
  Live: "bg-[#e1f0e7] text-[#1e5c3e]",
  "In review": "bg-[#fbf0d4] text-[#806510]",
  Draft: "bg-reader-tint text-[#7a5a00]",
  "Taken down": "bg-[#f6e3df] text-[#8e2a1e]",
};

// PEOPLE-2 (N3): the author's account is suspended.
const SUSPENDED_CHIP_CLASSES = "bg-[#f6e3df] text-[#8e2a1e]";

type ListResult =
  | {
      ok: true;
      rows: BookListRow[];
      total: number;
      takenDownIds: Set<string>;
      inReviewIds: Set<string>;
      suspendedAuthorIds: Set<string>;
    }
  | { ok: false };

async function loadBooks(filter: ReturnType<typeof parseBooksFilter>, q: string, page: number): Promise<ListResult> {
  const admin = createAdminClient();
  const [takenDownIds, inReviewIds, suspendedRead] = await Promise.all([
    readActiveTakedownBookIds(),
    readPendingReviewBookIds(),
    readSuspendedAuthorIds(),
  ]);
  if (!takenDownIds || !inReviewIds) return { ok: false };
  const suspendedAuthorIds = suspendedRead ?? new Set<string>();

  if ((filter === "taken_down" && takenDownIds.size === 0) || (filter === "in_review" && inReviewIds.size === 0)) {
    return { ok: true, rows: [], total: 0, takenDownIds, inReviewIds, suspendedAuthorIds };
  }

  let orFilter: string | null = null;
  if (q) {
    const pattern = booksSearchPattern(q);
    const [pens, authors] = await Promise.all([
      admin.from("pen_names").select("id").ilike("name", pattern).limit(LIST_ID_LIMIT).returns<{ id: string }[]>(),
      admin
        .from("profiles")
        .select("id")
        .ilike("public_author_name", pattern)
        .limit(LIST_ID_LIMIT)
        .returns<{ id: string }[]>(),
    ]);
    if (pens.error || authors.error) {
      console.error("admin books: author search failed", { pens: pens.error, authors: authors.error });
      return { ok: false };
    }
    orFilter = buildBooksSearchOrFilter(
      q,
      (pens.data ?? []).map((p) => p.id),
      (authors.data ?? []).map((a) => a.id),
    );
  }

  let query = admin
    .from("books")
    .select("id, title, status, author_id, published_at, created_at, pen:pen_names(name)", { count: "exact" });
  if (filter === "live") query = query.eq("status", "published");
  if (filter === "draft") {
    query = query.eq("status", "draft");
    const excluded = [...takenDownIds, ...inReviewIds];
    if (excluded.length > 0) query = query.not("id", "in", `(${excluded.join(",")})`);
  }
  if (filter === "in_review") query = query.eq("status", "draft").in("id", Array.from(inReviewIds));
  if (filter === "taken_down") query = query.in("id", Array.from(takenDownIds));
  if (orFilter) query = query.or(orFilter);

  const from = (page - 1) * BOOKS_PAGE_SIZE;
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + BOOKS_PAGE_SIZE - 1)
    .returns<BookListRow[]>();
  if (error) {
    console.error("admin books: list read failed", { error });
    return { ok: false };
  }
  return { ok: true, rows: data ?? [], total: count ?? 0, takenDownIds, inReviewIds, suspendedAuthorIds };
}

export default async function AdminBooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; status?: string | string[]; page?: string | string[] }>;
}) {
  await requireStaff("reports.view");

  const params = await searchParams;
  const filter = parseBooksFilter(params.status);
  const q = parseBooksSearch(params.q);
  const page = parseBooksPage(params.page);

  const result = await loadBooks(filter, q, page);
  const lastPage = result.ok ? Math.max(1, Math.ceil(result.total / BOOKS_PAGE_SIZE)) : 1;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <div>
        <p className="text-xs font-semibold tracking-[0.14em] text-[#806510] uppercase md:text-[0.8125rem]">Catalog</p>
        <h1 className="mt-1 font-serif text-[2rem] font-bold text-primary md:text-[2.5rem]">Books</h1>
        <p className="mt-1 text-sm text-muted">
          Every book, drafts included. Open a book to review it, see its reports and rights history, or unpublish it.
        </p>
      </div>

      <form action="/admin/books" method="get" role="search" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        {filter !== "all" && <input type="hidden" name="status" value={filter} />}
        <label htmlFor="admin-books-q" className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
          Search by title or author
          <input
            id="admin-books-q"
            type="search"
            name="q"
            defaultValue={q}
            maxLength={100}
            className={`${formControlClasses} min-h-11 w-full`}
          />
        </label>
        <button type="submit" className={buttonClasses("primary", "md", "min-h-11 shrink-0 rounded-[3px] px-5")}>
          Search
        </button>
      </form>

      <nav aria-label="Filter books" className="flex flex-wrap gap-2">
        {BOOKS_FILTERS.map((option) => {
          const active = option.value === filter;
          return (
            <Link
              key={option.value}
              href={booksListHref(option.value, q)}
              aria-current={active ? "true" : undefined}
              className={`focus-ring inline-flex min-h-11 items-center rounded-control border px-4 text-sm ${
                active
                  ? "border-primary bg-primary font-semibold text-primary-foreground"
                  : "border-border bg-surface text-foreground hover:bg-surface-hover"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </nav>

      {!result.ok ? (
        <Alert variant="error">{LOAD_ERROR}</Alert>
      ) : result.rows.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-sm text-muted">No books match.</p>
      ) : (
        <section aria-label="Books" className="rounded-card border border-border bg-surface">
          <p className="border-b border-border px-4 py-3 text-sm text-muted">
            {result.total} {result.total === 1 ? "book" : "books"}
            {lastPage > 1 && ` · page ${page} of ${lastPage}`}
          </p>
          <ul className="flex flex-col">
            {result.rows.map((book) => {
              const state = bookStateLabel(
                book.status,
                result.takenDownIds.has(book.id),
                result.inReviewIds.has(book.id),
              );
              return (
                <li key={book.id} className="border-t border-border first:border-t-0">
                  <Link
                    href={`/admin/books/${book.id}`}
                    className="focus-ring flex min-h-11 flex-col gap-1 px-4 py-3 hover:bg-surface-hover sm:flex-row sm:items-center sm:gap-4"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold break-words text-primary">{book.title}</span>
                      <span className="block text-sm text-muted">{book.pen?.name ?? "Unknown author"}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-3 text-sm">
                      <span className={`rounded-[3px] px-2 py-1 text-xs font-bold tracking-wide uppercase ${CHIP_CLASSES[state]}`}>
                        {state}
                      </span>
                      {result.suspendedAuthorIds.has(book.author_id) && (
                        <span className={`rounded-[3px] px-2 py-1 text-xs font-bold tracking-wide uppercase ${SUSPENDED_CHIP_CLASSES}`}>
                          Suspended
                        </span>
                      )}
                      <span className="text-muted sm:w-36 sm:text-right">
                        {book.published_at ? `Published ${formatTimestampAsDate(book.published_at)}` : "Never published"}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {result.ok && lastPage > 1 && (
        <nav aria-label="Pages" className="flex flex-wrap justify-between gap-3">
          {page > 1 ? (
            <Link href={booksListHref(filter, q, page - 1)} className={buttonClasses("outline", "md", "min-h-11 rounded-[3px]")}>
              Newer
            </Link>
          ) : (
            <span />
          )}
          {page < lastPage && (
            <Link href={booksListHref(filter, q, page + 1)} className={buttonClasses("outline", "md", "min-h-11 rounded-[3px]")}>
              Older
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
