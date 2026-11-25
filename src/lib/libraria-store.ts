// LR1 (Renato 11-25, Libraria patch 1): the new Libraria page's pure
// rules -- which categories get a button, which books fill the
// non-fiction shelf, the card's stars and the card's button. Kept here,
// apart from the page, so they are tested without rendering it.
import { GENRES, type Genre } from "@/lib/genres";
import { isPreorder } from "@/lib/preorder-reader";
import { resolveCatalogPriceState } from "@/lib/catalog-price";

// The buttons under "Më të rinjtë në Librum" (LR1 patch 2): the
// categories staff chose in admin, in their order, up to
// MAX_CATEGORY_BUTTONS (lr2-3 a) -- each one shown even while it has no
// listed book (lr2-4 b). Until staff save a list (none, or the read
// failed), the first four categories that have a listed book, in A–Zh
// order (the order GENRES is kept in), as in patch 1 (lr2-5 b).
export const CATEGORY_BUTTON_COUNT = 4;
export const MAX_CATEGORY_BUTTONS = 6;

export function categoryButtons(genresWithBooks: Iterable<string>, staffChosen: readonly string[] = []): Genre[] {
  const known = new Set<string>(GENRES);
  const chosen: Genre[] = [];
  for (const g of staffChosen) {
    if (known.has(g) && !chosen.includes(g as Genre)) chosen.push(g as Genre);
  }
  if (chosen.length > 0) return chosen.slice(0, MAX_CATEGORY_BUTTONS);
  const present = new Set(genresWithBooks);
  return GENRES.filter((g) => present.has(g)).slice(0, CATEGORY_BUTTON_COUNT);
}

// The admin form's six slots, read into the ordered list staff save:
// empty slots are skipped (the order closes up), and a category chosen
// twice or not a category is refused.
export type CategoryButtonsParse = { ok: true; categories: Genre[] } | { ok: false; reason: "repeat" | "unknown" };

export function parseCategoryButtonSlots(slots: readonly unknown[]): CategoryButtonsParse {
  const known = new Set<string>(GENRES);
  const out: Genre[] = [];
  for (const raw of slots.slice(0, MAX_CATEGORY_BUTTONS)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    if (!known.has(value)) return { ok: false, reason: "unknown" };
    if (out.includes(value as Genre)) return { ok: false, reason: "repeat" };
    out.push(value as Genre);
  }
  return { ok: true, categories: out };
}

// Decision 3: "Libra jo-artistikë" holds books in any of these
// categories (the sketch's "Non fiction reads").
export const NON_FICTION_GENRES: readonly Genre[] = [
  "Biografi & kujtime",
  "Biznes & ekonomi",
  "Filozofi",
  "Histori",
  "Psikologji",
  "Publicistikë & ese",
  "Shkencë",
  "Zhvillim personal",
];

export type RatingSummary = { average: number; count: number };

// Approved public reviews (public_reviews holds only approved ones) for
// the books on the page, as an average and a count per book. A book
// with none has no entry (decision 5: no stars). Ratings outside 1..5
// are skipped.
export function summarizeRatings(rows: { book_id: string; rating: number }[]): Map<string, RatingSummary> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const { book_id, rating } of rows) {
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) continue;
    const s = sums.get(book_id) ?? { total: 0, count: 0 };
    s.total += rating;
    s.count += 1;
    sums.set(book_id, s);
  }
  const out = new Map<string, RatingSummary>();
  for (const [id, s] of sums) out.set(id, { average: s.total / s.count, count: s.count });
  return out;
}

export type StarFill = "full" | "half" | "empty";

// Five stars, the average rounded to the nearest half.
export function starFills(average: number): StarFill[] {
  const halves = Math.round(Math.min(5, Math.max(0, average)) * 2);
  return [1, 2, 3, 4, 5].map((i) => (halves >= i * 2 ? "full" : halves === i * 2 - 1 ? "half" : "empty"));
}

export type StoreCardAction = "add" | "login" | "in-cart" | "free" | "view";

// lr1-4 a and the cart's rule (c3 a: paid live books only): a pre-order
// shows "Shiko librin" (decision 9), a free book "Merre falas", a paid
// live book "Shto" -- through log in for a visitor, "Në shportë" once
// it is in the reader's cart. A row with no price never reaches a shelf.
// lr1-12 a (audit N1): a book the reader already owns, or the author's
// own book, shows "Shiko librin" -- the book page's own button for them
// (read / download, or the author's view) -- never "Shto" or "Merre falas".
export function storeCardAction(
  book: { status?: string | null; price_all: number | null },
  signedIn: boolean,
  inCart: boolean,
  ownedOrOwn = false,
): StoreCardAction {
  if (isPreorder(book)) return "view";
  if (signedIn && ownedOrOwn) return "view";
  const price = resolveCatalogPriceState(book.price_all);
  if (price === "free") return "free";
  if (price !== "paid") return "view";
  if (!signedIn) return "login";
  return inCart ? "in-cart" : "add";
}
