import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import {
  LIBRUM_CHOICE_PAGE_SIZE,
  escapeIlikePattern,
  librumChoicePageHref,
  parseLibrumChoicePage,
  parseLibrumChoiceSearch,
} from "@/lib/librum-choice-logic";
import { resolveStaffByline } from "@/lib/book-byline";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { formControlClasses } from "@/lib/form-styles";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import type { Metadata } from "next";
import { getHomeSlotsForStaff } from "@/lib/home-picks";
import { HOME_SLOTS, HOME_SLOT_LABELS, qualifiesForHomeFan, type HomeSlot, type HomeSlotRow } from "@/lib/home-picks-logic";
import { removeHomeSlotFromForm, setHomeSlotFromForm } from "./actions";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Featured picks",
};

// F5 (C1): staff (catalog.feature: owner and admin) search published,
// priced books here. LR1 patch 3 (Renato 2026-11-25, lr3-6 a, lr3-6b a):
// the "Librum's choice" pick is gone with the Libraria strip it fed (the
// Libraria banner replaced it), so the page keeps only the home page
// cover slots. Reads use the request client (published books are
// public); changes go through the gated actions.
//
// HOME-PICKS-1 (Renato 2026-10-25): renamed "Featured picks". The same
// page also fills the three home page cover slots (slot 1 is the middle,
// front cover), each with a Paid tick that shows a "Sponsored" tag on
// the home page. Any listed book with a cover can go in a slot (free
// books too: the list is already published and priced). The slots are
// read through getHomeSlotsForStaff (service role, after its own
// catalog.feature check), so a slot whose book is not live now still
// shows here, marked, with a link to the book's staff page; the slot
// books' titles come from public_books like every other read here.
//
// Renato 2026-11-26 (ff3 a): the book list leaves out the books already
// in a slot (search too) and shows 10 a page, newest first, with
// Previous / Next only when there are more than 10.
const LOAD_ERROR = "Something went wrong. Please try again.";

type ChoiceRow = Pick<PublicBook, "id" | "title" | "cover_path"> & {
  pen: PenNameRef | null;
};

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgREST's answer to a page past the last one.
const RANGE_NOT_SATISFIABLE = "PGRST103";

type PickableBooks = { ok: true; books: ChoiceRow[]; total: number; page: number } | { ok: false };

async function fetchPickableBooksPage(
  supabase: SupabaseClient,
  q: string,
  page: number,
  slottedIds: readonly string[],
): Promise<{ ok: true; books: ChoiceRow[]; total: number } | { ok: false; pastEnd: boolean }> {
  // PEN-NAMES-2 (MF2): public_books -- this page has no reason to read
  // the base table, and the base table's staff policy is reports.resolve.
  let query = supabase
    .from("public_books")
    .select("id, title, cover_path, original_author, pen:public_pen_names(id, name)", { count: "exact" })
    .eq("status", "published")
    .not("price_all", "is", null);
  // ff3 a: books already in a home slot are left out. The ids come from
  // the slot rows; only well-formed ids go into the filter.
  const skip = slottedIds.filter((id) => UUID.test(id));
  if (skip.length > 0) query = query.filter("id", "not.in", `(${skip.join(",")})`);
  // `%`, `_` and `\` in the search match themselves (never `.or()` with
  // interpolated text).
  if (q) query = query.ilike("title", `%${escapeIlikePattern(q)}%`);
  const from = (page - 1) * LIBRUM_CHOICE_PAGE_SIZE;
  // The id order keeps books with the same created_at on one page each.
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + LIBRUM_CHOICE_PAGE_SIZE - 1)
    .returns<ChoiceRow[]>();

  if (error) {
    if (error.code === RANGE_NOT_SATISFIABLE) return { ok: false, pastEnd: true };
    console.error("Featured picks: book list read failed:", error);
    return { ok: false, pastEnd: false };
  }
  // PEN-NAMES-1: each row's byline is its pen name (embedded above).
  return { ok: true, books: data ?? [], total: count ?? 0 };
}

// A ?page past the last one (an old link, or the list got shorter) shows
// page 1 instead of an error.
async function fetchPickableBooks(
  supabase: SupabaseClient,
  q: string,
  page: number,
  slottedIds: readonly string[],
): Promise<PickableBooks> {
  const first = await fetchPickableBooksPage(supabase, q, page, slottedIds);
  if (first.ok && (first.books.length > 0 || page === 1)) return { ...first, page };
  if (!first.ok && !first.pastEnd) return { ok: false };
  if (page === 1) return { ok: false };
  const again = await fetchPickableBooksPage(supabase, q, 1, slottedIds);
  return again.ok ? { ...again, page: 1 } : { ok: false };
}

type SlotBook = ChoiceRow & Pick<PublicBook, "price_all">;

// HOME-PICKS-1: the slot books that are published now, by id. A book
// missing here is not live (draft, taken down, in review or suspended).
async function fetchSlotBooks(supabase: SupabaseClient, ids: string[]): Promise<Map<string, SlotBook>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from("public_books")
    .select("id, title, cover_path, price_all, original_author, pen:public_pen_names(id, name)")
    .in("id", ids)
    .eq("status", "published")
    .returns<SlotBook[]>();
  if (error) {
    console.error("Featured picks: slot books read failed:", error);
    return new Map();
  }
  return new Map((data ?? []).map((b) => [b.id, b]));
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
  searchParams: Promise<{ q?: string | string[]; page?: string | string[]; success?: string; error?: string }>;
}) {
  await requireStaff("catalog.feature");

  const { q: rawQ, page: rawPage, success: rawSuccess, error: rawError } = await searchParams;

  const success = pageSuccessMessage(rawSuccess);

  const error = pageErrorMessage(rawError);
  const q = parseLibrumChoiceSearch(rawQ);
  const requestedPage = parseLibrumChoicePage(rawPage);
  const supabase = await createClient();

  // The slots come first: the list leaves their books out (ff3 a).
  const home = await getHomeSlotsForStaff();
  const homeSlots = home.ok ? home.slots : [];
  const slottedIds = homeSlots.map((s) => s.book_id);
  const [list, slotBooks] = await Promise.all([
    fetchPickableBooks(supabase, q, requestedPage, slottedIds),
    fetchSlotBooks(supabase, slottedIds),
  ]);
  const page = list.ok ? list.page : 1;
  const lastPage = list.ok ? Math.max(1, Math.ceil(list.total / LIBRUM_CHOICE_PAGE_SIZE)) : 1;

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

      <section className="mt-6" aria-labelledby="home-slots">
        <h2 id="home-slots" className="font-serif text-xl font-semibold">
          Home page covers
        </h2>
        <p className="mt-1 text-sm text-muted">
          Three covers on the home page. An empty slot, or a book that is not live, shows the newest book
          instead. Tick Paid for a paid spot: the home page then marks that cover Sponsored.
        </p>
        {!home.ok ? (
          <Alert variant="error" className="mt-3">
            {LOAD_ERROR}
          </Alert>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {HOME_SLOTS.map((slot) => (
              <HomeSlotCard
                key={slot}
                slot={slot}
                row={homeSlots.find((s) => s.slot === slot) ?? null}
                books={slotBooks}
                coverUrl={(path) => coverUrlFor(supabase, path)}
              />
            ))}
          </ul>
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
        <p className="mt-6 text-sm text-muted">
          {q ? "No published book matches your search." : "All published books are already on the home page."}
        </p>
      ) : (
        <>
          <ul className="mt-6 flex flex-col gap-3">
            {list.books.map((book) => {
              const author = resolveStaffByline(book);
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
                      {!book.cover_path && (
                        <p className="text-xs text-muted">Can&apos;t go on the home page: no cover</p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {/* The list is already published and priced: a cover is all a slot still needs. */}
                    {book.cover_path && (
                      <HomeSlotPickForm bookId={book.id} title={book.title} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {lastPage > 1 && (
            <nav aria-label="Book list pages" className="mt-6 flex items-center justify-between gap-3">
              {page > 1 ? (
                <Link href={librumChoicePageHref(q, page - 1)} className={ACTION_BUTTON}>
                  &lsaquo; Previous
                </Link>
              ) : (
                <span />
              )}
              <p className="text-sm text-muted">
                Page {page} of {lastPage}
              </p>
              {page < lastPage ? (
                <Link href={librumChoicePageHref(q, page + 1)} className={ACTION_BUTTON}>
                  Next &rsaquo;
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </main>
  );
}

// HOME-PICKS-1: one home slot -- its book with the Paid tick (Save) and
// Remove, or "Empty". A book that is not live now stays in its slot (it
// comes back when republished) and is marked, because the home page
// shows the newest book there meanwhile.
function HomeSlotCard({
  slot,
  row,
  books,
  coverUrl,
}: {
  slot: HomeSlot;
  row: HomeSlotRow | null;
  books: ReadonlyMap<string, SlotBook>;
  coverUrl: (path: string | null) => string | null;
}) {
  const label = HOME_SLOT_LABELS[slot];
  const book = row ? (books.get(row.book_id) ?? null) : null;
  const live = book ? qualifiesForHomeFan({ status: "published", price_all: book.price_all, cover_path: book.cover_path }) : false;
  const author = book ? resolveStaffByline(book) : null;
  return (
    <li className="rounded-card border border-border bg-surface p-4 shadow-sm">
      <p className="text-sm font-medium">{label}</p>
      {row ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-4">
            {book && <Thumbnail url={coverUrl(book.cover_path)} title={book.title} author={author} />}
            <div className="min-w-0">
              {book ? (
                <>
                  <p className="font-medium break-words">{book.title}</p>
                  {author && <p className="text-sm text-muted">{author}</p>}
                </>
              ) : (
                <p className="font-medium">A book that is not published now</p>
              )}
              {row.sponsored && <p className="text-sm text-muted">Paid: shows Sponsored</p>}
              {!live && (
                <p className="text-sm text-muted">
                  Not live now: the home page shows the newest book here.{" "}
                  <Link
                    href={`/admin/books/${row.book_id}`}
                    className="underline underline-offset-2 hover:decoration-2"
                  >
                    Open in Books
                  </Link>
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {/* The database refuses a book that is not live, so the
                tick can only be changed while it is. */}
            {live && (
              <form action={setHomeSlotFromForm} className="flex items-center gap-3">
                <input type="hidden" name="slot" value={slot} />
                <input type="hidden" name="bookId" value={row.book_id} />
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" name="sponsored" defaultChecked={row.sponsored} className="size-4" />
                  Paid
                </label>
                <button type="submit" className={ACTION_BUTTON} aria-label={`Save ${label}`}>
                  Save
                </button>
              </form>
            )}
            <form action={removeHomeSlotFromForm}>
              <input type="hidden" name="slot" value={slot} />
              <button type="submit" className={ACTION_BUTTON} aria-label={`Remove ${label}`}>
                Remove
              </button>
            </form>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted">Empty: the home page shows the newest book here.</p>
      )}
    </li>
  );
}

// HOME-PICKS-1: "Put on home page" on a book row: which slot, and Paid
// yes/no for this book (Renato 4a: every pick records it afresh).
function HomeSlotPickForm({ bookId, title }: { bookId: string; title: string }) {
  const selectId = `home-slot-${bookId}`;
  return (
    <form action={setHomeSlotFromForm} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="bookId" value={bookId} />
      <label htmlFor={selectId} className="sr-only">
        Home page slot for {title}
      </label>
      <select id={selectId} name="slot" defaultValue="1" className={`${formControlClasses} min-h-11 w-auto`}>
        {HOME_SLOTS.map((slot) => (
          <option key={slot} value={slot}>
            {HOME_SLOT_LABELS[slot]}
          </option>
        ))}
      </select>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="sponsored" className="size-4" />
        Paid
      </label>
      <button type="submit" className={ACTION_BUTTON} aria-label={`Put ${title} on the home page`}>
        Put on home page
      </button>
    </form>
  );
}
