import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { getLibrumChoiceBook } from "@/lib/librum-choice";
import { escapeIlikePattern, parseLibrumChoiceSearch } from "@/lib/librum-choice-logic";
import { resolveStaffByline } from "@/lib/book-byline";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { formControlClasses } from "@/lib/form-styles";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import type { Metadata } from "next";
import { pickLibrumChoiceFromForm, removeLibrumChoiceFromForm } from "./actions";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Featured picks",
};

// F5 (C1, Renato 10:17Z Q1 = a): staff (catalog.feature: owner and admin)
// pick the one book the Bookstore shows as "Librum's choice". Only books that CAN be picked
// are listed: published and priced (the Bookstore lists only priced
// books). Reads use the request client (published books are public);
// the pick and the removal go through the gated actions.
//
// HOME-PICKS-1 (Renato 2026-10-25): renamed "Featured picks".
// HOMEPAGE-2 (Renato 2026-11-19): the home page no longer shows staff
// picked covers (its fan is the newest books), so the home page slot
// controls are gone from this page.
const LIST_LIMIT = 20;
const LOAD_ERROR = "Something went wrong. Please try again.";

type ChoiceRow = Pick<PublicBook, "id" | "title" | "cover_path"> & {
  pen: PenNameRef | null;
};

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

async function fetchPickableBooks(
  supabase: SupabaseClient,
  q: string,
): Promise<{ ok: true; books: ChoiceRow[]; hasMore: boolean } | { ok: false }> {
  // PEN-NAMES-2 (MF2): public_books -- this page has no reason to read
  // the base table, and the base table's staff policy is reports.resolve.
  let query = supabase
    .from("public_books")
    .select("id, title, cover_path, original_author, pen:public_pen_names(id, name)")
    .eq("status", "published")
    .not("price_all", "is", null);
  // `%`, `_` and `\` in the search match themselves (never `.or()` with
  // interpolated text).
  if (q) query = query.ilike("title", `%${escapeIlikePattern(q)}%`);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT + 1)
    .returns<ChoiceRow[]>();

  if (error) {
    console.error("Librum's choice: book list read failed:", error);
    return { ok: false };
  }
  const rows = data ?? [];
  // PEN-NAMES-1: each row's byline is its pen name (embedded above).
  const books = rows.slice(0, LIST_LIMIT);
  return { ok: true, books, hasMore: rows.length > LIST_LIMIT };
}

function coverUrlFor(supabase: SupabaseClient, coverPath: string | null) {
  return coverPath ? supabase.storage.from("covers").getPublicUrl(coverPath).data.publicUrl : null;
}

function Thumbnail({ url, title, author }: { url: string | null; title: string; author: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" loading="lazy" decoding="async" className="aspect-[5/8] w-12 shrink-0 rounded-[3px] object-contain object-bottom" />
  ) : (
    <CoverPlaceholder title={title} authorName={author} className="aspect-[5/8] w-12 shrink-0 rounded-[3px]" />
  );
}

const ACTION_BUTTON = buttonClasses("outline", "md", "min-h-11 shrink-0 rounded-full px-4");

export default async function AdminLibrumChoicePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; success?: string; error?: string }>;
}) {
  await requireStaff("catalog.feature");

  const { q: rawQ, success: rawSuccess, error: rawError } = await searchParams;

  const success = pageSuccessMessage(rawSuccess);

  const error = pageErrorMessage(rawError);
  const q = parseLibrumChoiceSearch(rawQ);
  const supabase = await createClient();

  const [pick, list] = await Promise.all([getLibrumChoiceBook(), fetchPickableBooks(supabase, q)]);
  const pickAuthor = pick ? resolveStaffByline(pick) : null;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to admin
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Featured picks</h1>

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

      <section className="mt-6" aria-labelledby="librum-choice-current">
        {/* F5 r2 (Renato 11:17Z "1. a", audit A3): a visible label, in
            the same small style as the search box's label below.
            HOME-PICKS-1: it names the Bookstore. */}
        <h2 id="librum-choice-current" className="mb-1 text-sm font-medium">
          Librum&apos;s choice on the Bookstore: current pick
        </h2>
        {pick ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-sm">
            <div className="flex min-w-0 items-center gap-4">
              <Thumbnail url={coverUrlFor(supabase, pick.cover_path)} title={pick.title} author={pickAuthor} />
              <div className="min-w-0">
                <p className="font-medium break-words">{pick.title}</p>
                {pickAuthor && <p className="text-sm text-muted">{pickAuthor}</p>}
              </div>
            </div>
            <form action={removeLibrumChoiceFromForm}>
              <button type="submit" className={ACTION_BUTTON}>
                Remove
              </button>
            </form>
          </div>
        ) : (
          <p className="rounded-card border border-border bg-surface p-4 text-sm text-muted">
            Nothing picked. The Bookstore shows the newest book as New on Librum.
          </p>
        )}
      </section>

      <form action="/admin/librum-choice" method="get" role="search" className="mt-8">
        <label htmlFor="librum-choice-q" className="block text-sm font-medium">
          Search published books
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="librum-choice-q"
            type="search"
            name="q"
            defaultValue={q}
            maxLength={100}
            className={`${formControlClasses} min-h-11 min-w-0 flex-1`}
          />
          <button type="submit" className={buttonClasses("primary", "md", "min-h-11 shrink-0 rounded-full px-4")}>
            Search
          </button>
        </div>
      </form>

      {!list.ok ? (
        <Alert variant="error" className="mt-6">
          {LOAD_ERROR}
        </Alert>
      ) : list.books.length === 0 ? (
        <p className="mt-6 text-sm text-muted">No published book matches your search.</p>
      ) : (
        <>
          <ul className="mt-6 flex flex-col gap-3">
            {list.books.map((book) => {
              const author = resolveStaffByline(book);
              const isPicked = pick?.id === book.id;
              return (
                <li
                  key={book.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-sm"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <Thumbnail url={coverUrlFor(supabase, book.cover_path)} title={book.title} author={author} />
                    <div className="min-w-0">
                      <p className="font-medium break-words">{book.title}</p>
                      {author && <p className="text-sm text-muted">{author}</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {isPicked ? (
                      // F5 r2 (audit A2): the site's dark green, not Tailwind green-700.
                      <span className="text-sm font-semibold text-primary">Picked</span>
                    ) : (
                      <form action={pickLibrumChoiceFromForm}>
                        <input type="hidden" name="bookId" value={book.id} />
                        <button
                          type="submit"
                          className={ACTION_BUTTON}
                          aria-label={`Pick ${book.title} as Librum's choice`}
                        >
                          Pick
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {list.hasMore && <p className="mt-4 text-sm text-muted">Showing the first 20 books</p>}
        </>
      )}
    </main>
  );
}
