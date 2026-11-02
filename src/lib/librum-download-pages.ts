import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_MORE_BOOKS, purchaseCode, type LibrumFrontPage, type LibrumLastPage } from "@/lib/epub-librum-pages";
import { formatTimestampAsDate, TIRANA_TIME_ZONE } from "@/lib/book-detail-dates";
import { BOOK_PEN_NAME_EMBED, resolveBookPenName, resolveOriginalAuthor } from "@/lib/book-byline";
import type { PenNameRef } from "@/lib/pen-names";
import type { RightsBasis } from "@/lib/types";

// BD3 + BD4 + BD4b: the details for the two Librum pages of one
// download, read with the caller's own session client AFTER the route
// has decided the caller may download this book: the public views
// (public_books, public_pen_names, PEN-NAMES-2), the book's contributors
// (readable wherever the book is) and the caller's own purchase row.
// No service-role read, and nothing read here leaves the file it is
// written into.
//
// Returns null when a detail the pages cannot do without (the book row
// or its pen name) is missing; the route then serves the file without
// the pages and logs it (fail-open, like the email mark).

type BookRow = {
  id: string;
  title: string;
  subtitle: string | null;
  isbn: string | null;
  publisher: string | null;
  edition: string | null;
  original_publication_date: string | null;
  original_author: string | null;
  published_at: string | null;
  pen_name_id: string;
};

export type LibrumPagesBuyer = { readerId: string; email: string } | null;

function yearInTirana(instant: Date): number {
  return Number(new Intl.DateTimeFormat("en", { year: "numeric", timeZone: TIRANA_TIME_ZONE }).format(instant));
}

// Audit r2 (N1): "free" is a property of how THIS reader got the book,
// not of the book's price today (a paid book can become free later) and
// not of the amount (a bundle share or a full discount can be 0).
// getFreeBook (libra/[id]/actions.ts) is the only writer of free claims:
// a "free_" checkout-session placeholder and no payment intent. Every
// paid path sets a payment intent.
export function isFreeClaim(purchase: Record<string, unknown>): boolean {
  return (
    typeof purchase.stripe_checkout_session_id === "string" &&
    purchase.stripe_checkout_session_id.startsWith("free_") &&
    (purchase.stripe_payment_intent_id === null || purchase.stripe_payment_intent_id === undefined)
  );
}

function isPlainRow(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export async function readLibrumPages(
  supabase: SupabaseClient,
  // BD3 patch 3: rights is the book's latest declared basis, which the
  // route reads itself (buyers cannot read the declarations table);
  // null (none, or the read failed) keeps the ordinary © page.
  input: { bookId: string; buyer: LibrumPagesBuyer; siteOrigin: string; rights?: RightsBasis | null; now?: Date },
): Promise<{ front: LibrumFrontPage; last: LibrumLastPage; buyerLineMissing: boolean } | null> {
  const now = input.now ?? new Date();

  // public_books shows the caller a published book, their own book in
  // any state, and a book they own (the route already checked one).
  const { data: bookData, error: bookError } = await supabase
    .from("public_books")
    .select(`id, title, subtitle, isbn, publisher, edition, original_publication_date, original_author, published_at, pen_name_id, ${BOOK_PEN_NAME_EMBED}`)
    .eq("id", input.bookId)
    .maybeSingle();
  if (bookError || !isPlainRow(bookData) || bookData.id !== input.bookId || typeof bookData.title !== "string" || typeof bookData.pen_name_id !== "string") {
    return null;
  }
  const book = bookData as BookRow & { pen?: unknown };

  const [translatorsResult, moreResult, purchaseResult] = await Promise.all([
    supabase.from("book_contributors").select("name, created_at").eq("book_id", book.id).eq("role", "Translator").order("created_at", { ascending: true }),
    // 5a: the same rule as the book page's "More by" shelf (3a): only
    // this pen name, published, priced, never this book; newest first.
    supabase
      .from("public_books")
      .select("id, title")
      .eq("pen_name_id", book.pen_name_id)
      .eq("status", "published")
      .not("price_all", "is", null)
      .neq("id", book.id)
      .order("created_at", { ascending: false })
      .limit(MAX_MORE_BOOKS),
    input.buyer
      ? supabase
          .from("purchases")
          .select("id, created_at, stripe_checkout_session_id, stripe_payment_intent_id")
          .eq("book_id", book.id)
          .eq("reader_id", input.buyer.readerId)
          .is("refunded_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  // A hidden pen name (a suspended account) means no pages at all.
  const penName = resolveBookPenName(isPlainRow(book.pen) ? (book as { pen: PenNameRef }) : null);
  if (!penName || !penName.trim()) return null;

  // A failed side read only drops its own line, never the whole page.
  const translators = !translatorsResult.error && Array.isArray(translatorsResult.data)
    ? translatorsResult.data.map((r) => (isPlainRow(r) ? textOrNull(r.name) : null)).filter((n): n is string => !!n)
    : [];
  const more = !moreResult.error && Array.isArray(moreResult.data)
    ? moreResult.data
        .filter((r): r is { id: string; title: string } => isPlainRow(r) && typeof r.id === "string" && typeof r.title === "string" && r.id !== book.id)
        .slice(0, MAX_MORE_BOOKS)
    : [];

  // Audit r1: a missing purchase row drops only the buyer line (the
  // route logs it); the copyright page and the last page still go in.
  // "Free" follows how this reader got the book (isFreeClaim). The date is the
  // purchase row's created_at; a re-purchase after a refund reuses the
  // row (on conflict ... do update) and keeps the first date.
  let buyer: LibrumFrontPage["buyer"] = null;
  let buyerLineMissing = false;
  if (input.buyer) {
    const p = purchaseResult.error ? null : purchaseResult.data;
    if (isPlainRow(p) && typeof p.id === "string" && typeof p.created_at === "string") {
      buyer = {
        email: input.buyer.email,
        date: formatTimestampAsDate(p.created_at),
        code: purchaseCode(p.id),
        free: isFreeClaim(p),
      };
    } else {
      buyerLineMissing = true;
    }
  }

  // 4a: "Botuar në Librum" is the year the book first went live; a book
  // never published yet (the author's own download) uses this year.
  const librumYear = book.published_at ? yearInTirana(new Date(book.published_at)) : yearInTirana(now);
  const originalYear = book.original_publication_date ? Number(book.original_publication_date.slice(0, 4)) : NaN;
  const hasOriginalYear = Number.isInteger(originalYear) && originalYear > 0;
  const copyrightYear = hasOriginalYear ? originalYear : librumYear;

  return {
    buyerLineMissing,
    front: {
      title: book.title,
      subtitle: textOrNull(book.subtitle),
      penName,
      // BD3 patch 4: the "Autori origjinal", when the author gave one.
      // (Equal to the pen name = none, audit r1 N1.)
      originalAuthor: resolveOriginalAuthor({
        original_author: textOrNull(book.original_author),
        pen: { id: book.pen_name_id, name: penName },
      }),
      copyrightYear,
      originalYear: hasOriginalYear ? originalYear : null,
      translators,
      rights: input.rights ?? "own_rights",
      librumYear,
      isbn: textOrNull(book.isbn),
      publisher: textOrNull(book.publisher),
      edition: textOrNull(book.edition),
      buyer,
    },
    last: {
      penName,
      books: more.map((b) => ({ title: b.title, url: `${input.siteOrigin}/libra/${b.id}` })),
      reviewUrl: `${input.siteOrigin}/libra/${book.id}`,
    },
  };
}
