// Amazon book page P5 (Renato 2026-11-28: bp9 b, bp10 b, fb1 a, fb2 b,
// fb3 b, fb4 a): "Blihen shpesh bashkë" and the "Blerë bashkë me këtë"
// chip of the "Lexuesit blenë edhe" shelf.
//
// The pairs come from public.books_bought_together(book) (migration
// 20261128150000_books_bought_together.sql): the other books that at
// least 3 different readers bought as well, paid copies of any age,
// never the authors' own copies. It returns book ids in order only,
// never a count or a reader, and only the server's admin client may
// call it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatCatalogPriceAll, resolveCatalogPriceState, CATALOG_PRICE_FREE_LABEL } from "@/lib/catalog-price";

// fb2 b: this heading always, also over the same-genre book (bp9 b).
export const BOUGHT_TOGETHER_HEADING = "Blihen shpesh bashkë";
// fb3 b: the shelf's heading on every book page.
export const ALSO_BOUGHT_HEADING = "Lexuesit blenë edhe";
// fb3 b: the shelf's first chip, only when real pairs exist.
export const ALSO_BOUGHT_CHIP = "Blerë bashkë me këtë";
export const THIS_BOOK_LABEL = "Ky libër";
export const ADD_BOTH_LABEL = "Shto të dyja në shportë";

type Row = { book_id: string; sort_order: number };

// The other books, best pair first. Any error, throw or odd row means
// none (the page never fails for it, and falls back to the same-genre
// book).
export async function readBooksBoughtTogether(admin: SupabaseClient, bookId: string): Promise<string[]> {
  let data: unknown;
  try {
    const result = await admin.rpc("books_bought_together", { p_book_id: bookId });
    if (result.error) return [];
    data = result.data;
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const ids = (data as Row[])
    .filter((r) => !!r && typeof r.book_id === "string" && r.book_id !== bookId && Number.isInteger(r.sort_order))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => r.book_id);
  return [...new Set(ids)];
}

// The page re-reads the ids through public_books (with the page's own
// listing and age rules), which returns them in any order: put them
// back in pair order. An id the page's read left out stays out.
export function inIdOrder<T extends { id: string }>(books: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(books.map((b) => [b.id, b]));
  return ids.flatMap((id) => {
    const book = byId.get(id);
    return book ? [book] : [];
  });
}

// bp9 b: the best real pair, else the first same-genre book, else none.
export function pickTogetherBook<T extends { id: string }>(real: readonly T[], sameGenre: readonly T[], bookId: string): T | null {
  return real.find((b) => b.id !== bookId) ?? sameGenre.find((b) => b.id !== bookId) ?? null;
}

// "Gjithsej": the two prices added up. Null when either has no valid
// price (the block then shows no total).
export function togetherTotalLabel(a: number | null | undefined, b: number | null | undefined): string | null {
  const sa = resolveCatalogPriceState(a);
  const sb = resolveCatalogPriceState(b);
  if (sa === "unavailable" || sb === "unavailable") return null;
  const total = (a as number) + (b as number);
  return total === 0 ? CATALOG_PRICE_FREE_LABEL : formatCatalogPriceAll(total);
}

// bp10 b: "Shto të dyja në shportë" only once card payment is open, for
// a reader who could buy this book now (signed in or not), and only when
// both books are live and paid (the cart takes nothing else).
export function showAddBoth(input: {
  paidCheckoutAvailable: boolean;
  purchaseState: string;
  books: readonly { status?: string | null; price_all?: number | null }[];
}): boolean {
  if (!input.paidCheckoutAvailable) return false;
  if (input.purchaseState !== "paid-unowned" && input.purchaseState !== "anonymous-paid") return false;
  return input.books.length === 2 && input.books.every((b) => b.status === "published" && resolveCatalogPriceState(b.price_all) === "paid");
}
