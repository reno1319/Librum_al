// Amazon book page P4 (Renato 2026-11-28: bp6 a, bp7 a, bp8 a, rk1 b,
// rk2 a, rk3 a): the "Renditja" line in the book's details and the two
// badges under the title ("Nr. 1 në <kategoria>" and "Zgjedhja e
// Librum").
//
// The numbers come from public.book_sales_ranks(book) (migration
// 20261128130000_book_sales_ranks.sql): paid sales of the last 30 days,
// shown only once the book has 10 of them and the scope has 3 books with
// sales. It returns ranks only, never a sales count, and only the
// server's admin client may call it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBookstoreHref } from "@/lib/bookstore";
import { DEFAULT_PICK_BADGE } from "@/lib/libraria-picks";

// What all of Libraria is called in the rank line.
export const RANK_ALL_LABEL = "Librari";
export const RANK_DETAIL_LABEL = "Renditja";
// bp8 a + rk3 a: the badge of a book staff picked in Admin › Libraria
// (current or past pick), always this text.
export const PICK_BADGE_TEXT = DEFAULT_PICK_BADGE;

export type SalesRank = {
  // null = all of Libraria.
  category: string | null;
  rank: number;
};

export type RankPart = SalesRank & { label: string; href: string };

type RankRow = { category: string | null; sales_rank: number; sort_order: number };

// The book's ranks: Libraria first, then its categories in the book's
// own order. Any error, throw or odd row means no rank (the page never
// fails for it).
export async function readBookSalesRanks(admin: SupabaseClient, bookId: string): Promise<SalesRank[]> {
  let data: unknown;
  try {
    const result = await admin.rpc("book_sales_ranks", { p_book_id: bookId });
    if (result.error) return [];
    data = result.data;
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return (data as RankRow[])
    .filter((r) => !!r && Number.isInteger(r.sales_rank) && r.sales_rank >= 1 && (r.category === null || typeof r.category === "string"))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => ({ category: r.category, rank: r.sales_rank }));
}

// Libraria links to Libraria, a category to that category in Libraria.
export function rankParts(ranks: readonly SalesRank[]): RankPart[] {
  return ranks.map((r) => ({
    ...r,
    label: r.category ?? RANK_ALL_LABEL,
    href: r.category ? buildBookstoreHref({}, { genre: r.category }) : "/librari",
  }));
}

// "Nr. 14" -- the number part of each piece of the line.
export function rankNumberText(rank: number): string {
  return `Nr. ${rank}`;
}

// The "Nr. 1 në ..." badge: the first of the book's categories where it
// is first; if it is first in none of them (or they show no rank) but
// first in all of Libraria, "Nr. 1 në Librari". Otherwise no badge.
export function topRankBadge(ranks: readonly SalesRank[]): RankPart | null {
  const parts = rankParts(ranks).filter((p) => p.rank === 1);
  return parts.find((p) => p.category !== null) ?? parts[0] ?? null;
}

// bp8 a + rk3 a: does any pick (current or past) point at this book?
// public_libraria_reading_picks lists only picks whose book Libraria
// lists now, and everyone may read it. Errors mean no badge.
export async function readIsLibrumPick(supabase: SupabaseClient, bookId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("public_libraria_reading_picks")
      .select("id")
      .eq("book_id", bookId)
      .limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}
