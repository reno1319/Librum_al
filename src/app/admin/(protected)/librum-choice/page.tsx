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
import { getHomeSlotsForStaff } from "@/lib/home-picks";
import { HOME_SLOTS, HOME_SLOT_LABELS, qualifiesForHomeFan, type HomeSlot, type HomeSlotRow } from "@/lib/home-picks-logic";
import {
  pickLibrumChoiceFromForm,
  removeHomeSlotFromForm,
  removeLibrumChoiceFromForm,
  setHomeSlotFromForm,
} from "./actions";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Featured picks",
};

// F5 (C1, Renato 10:17Z Q1 = a): staff (catalog.feature: owner and admin)
// pick the one book the Bookstore shows as "Librum's choice" and the
// homepage puts first on its hero shelf. Only books that CAN be picked
// are listed: published and priced (the Bookstore lists only priced
// books). Reads use the request client (published books are public);
// the pick and the removal go through the gated actions.
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
    <img src={url} alt="" loading="lazy" decoding="async" className="aspect-[2/3] w-12 shrink-0 rounded-[3px] object-cover" />
  ) : (
    <CoverPlaceholder title={title} authorName={author} className="aspect-[2/3] w-12 shrink-0 rounded-[3px]" />
  );
}

const ACTION_BUTTON = buttonClasses("outline", "md", "min-h-11 shrink-0 rounded-[3px] px-4");

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

  const [pick, list, home] = await Promise.all([
    getLibrumChoiceBook(),
    fetchPickableBooks(supabase, q),
    getHomeSlotsForStaff(),
  ]);
  const pickAuthor = pick ? resolveStaffByline(pick) : null;
  const homeSlots = home.ok ? home.slots : [];
  const slotOfBook = new Map(homeSlots.map((s) => [s.book_id, s.slot]));
  const slotBooks = await fetchSlotBooks(
    supabase,
    homeSlots.map((s) => s.book_id),
  );

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

      <section className="mt-10" aria-labelledby="librum-choice-current">
        {/* F5 r2 (Renato 11:17Z "1. a", audit A3): a visible label, in
            the same small style as the search box's label below.
            HOME-PICKS-1: it names the Bookstore, now that the page has
            two kinds of pick. */}
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
          <button type="submit" className={buttonClasses("primary", "md", "min-h-11 shrink-0 rounded-[3px] px-4")}>
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
              const homeSlot = slotOfBook.get(book.id) ?? null;
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
                      {homeSlot && <p className="text-xs text-muted">On the home page: slot {homeSlot}</p>}
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
                    {/* The list is already published and priced: a cover is all a slot still needs. */}
                    {!homeSlot && book.cover_path && (
                      <HomeSlotPickForm bookId={book.id} title={book.title} />
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
