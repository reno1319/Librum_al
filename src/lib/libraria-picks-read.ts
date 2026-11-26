import type { createClient } from "@/lib/supabase/server";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import type { QuoteFrom } from "@/lib/libraria-picks";
import { summarizeRatings, type RatingSummary } from "@/lib/libraria-store";

// LR1 patch 4: the "Çfarë po lexojmë" picks readers may see, newest
// first. The view keeps only picks whose book Libraria lists now (lr4-3
// a), so the first one is the pick on Libraria (lr4-1 a). Each pick
// takes its book's title, byline, cover, price and link from the book.
// Fail-soft: a failed read gives no picks (no section, an empty page).
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type PickBook = PublicBook & { pen: PenNameRef | null };

export type ReadingPick = {
  id: string;
  book: PickBook;
  badge: string | null;
  note: string;
  quote: string;
  quoteFrom: QuoteFrom;
  publishedAt: string;
};

type PickViewRow = {
  id: string;
  book_id: string;
  badge: string | null;
  note: string;
  quote: string;
  quote_from: QuoteFrom;
  published_at: string;
};

export async function fetchReadingPicks(supabase: SupabaseClient, limit: number): Promise<ReadingPick[]> {
  const { data, error } = await supabase
    .from("public_libraria_reading_picks")
    .select("id, book_id, badge, note, quote, quote_from, published_at")
    .order("published_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit)
    .returns<PickViewRow[]>();
  if (error) {
    console.error("Libraria: failed to load the reading picks:", error);
    return [];
  }
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const { data: books, error: booksError } = await supabase
    .from("public_books")
    .select("*, pen:public_pen_names(id, name)")
    .in("id", [...new Set(rows.map((r) => r.book_id))])
    .returns<PickBook[]>();
  if (booksError) {
    console.error("Libraria: failed to load the reading pick books:", booksError);
    return [];
  }
  const byId = new Map((books ?? []).map((b) => [b.id, b]));
  return rows.flatMap((r) => {
    const book = byId.get(r.book_id);
    if (!book) return [];
    return [
      {
        id: r.id,
        book,
        badge: r.badge,
        note: r.note,
        quote: r.quote,
        quoteFrom: r.quote_from,
        publishedAt: r.published_at,
      },
    ];
  });
}

// Shared by Libraria and the "Më shumë" page (moved here from the
// Libraria page in LR1 patch 4, unchanged).

// Approved reviews of the books on the page (public_reviews lists only
// approved ones and no reader). Fail-soft: no stars.
export async function fetchRatings(supabase: SupabaseClient, bookIds: string[]): Promise<Map<string, RatingSummary>> {
  if (bookIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("public_reviews")
    .select("book_id, rating")
    .in("book_id", bookIds)
    .returns<{ book_id: string; rating: number }[]>();
  if (error) {
    console.error("Libraria: failed to load the ratings:", error);
    return new Map();
  }
  return summarizeRatings(data ?? []);
}

// The signed-in reader's own cart rows (row rules return only theirs),
// so a book already in it reads "Në shportë". Gift rows don't count.
export async function fetchCartBookIds(supabase: SupabaseClient, userId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("cart_items")
    .select("book_id")
    .eq("reader_id", userId)
    .is("gift_email", null)
    .returns<{ book_id: string }[]>();
  if (error) {
    console.error("Libraria: failed to load the cart:", error);
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.book_id));
}

// lr1-12 a (audit N1): the books this reader already owns (through
// user_owns_book(), the same rule as the book page and the cart, so a
// refunded or lost-disputed purchase does not count) and their own books
// as an author. Their cards show "Shiko librin". One ownership call per
// purchase row, as on the Bibliotekë page.
export async function fetchOwnedOrOwnBookIds(supabase: SupabaseClient, userId: string): Promise<Set<string>> {
  const [purchases, own] = await Promise.all([
    supabase.from("purchases").select("book_id").eq("reader_id", userId).returns<{ book_id: string }[]>(),
    supabase.from("books").select("id").eq("author_id", userId).returns<{ id: string }[]>(),
  ]);
  if (purchases.error) console.error("Libraria: failed to load the reader's purchases:", purchases.error);
  if (own.error) console.error("Libraria: failed to load the author's own books:", own.error);
  const ids = new Set((own.data ?? []).map((r) => r.id));
  const owned = await Promise.all(
    (purchases.data ?? []).map(
      async (r) => [r.book_id, !!(await supabase.rpc("user_owns_book", { target_book_id: r.book_id })).data] as const,
    ),
  );
  for (const [id, yes] of owned) if (yes) ids.add(id);
  return ids;
}
