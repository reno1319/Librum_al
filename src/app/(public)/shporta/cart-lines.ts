// CART: reads the signed-in reader's cart with each line's book, for the
// cart page and the last step. Books come from public_books (no account
// columns); a book that is no longer listed comes back as null.

import type { createClient } from "@/lib/supabase/server";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import type { CartRow } from "@/lib/cart";

export type CartLineBook = PublicBook & { pen: PenNameRef | null };
export type CartLine = CartRow & { book: CartLineBook | null };

export async function readCartLines(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<{ ok: true; lines: CartLine[] } | { ok: false }> {
  const { data: rows, error } = await supabase
    .from("cart_items")
    .select("id, book_id, gift_email, gift_note, created_at")
    .eq("reader_id", userId)
    .order("created_at", { ascending: true })
    .returns<CartRow[]>();
  if (error) return { ok: false };
  const ids = [...new Set((rows ?? []).map((r) => r.book_id))];
  let books: CartLineBook[] = [];
  if (ids.length > 0) {
    const { data, error: booksError } = await supabase
      .from("public_books")
      .select("*, pen:public_pen_names(id, name)")
      .in("id", ids)
      .returns<CartLineBook[]>();
    if (booksError) return { ok: false };
    books = data ?? [];
  }
  const byId = new Map(books.map((b) => [b.id, b]));
  return { ok: true, lines: (rows ?? []).map((r) => ({ ...r, book: byId.get(r.book_id) ?? null })) };
}
