import { formatCatalogAmountAll, resolveCatalogPriceState } from "@/lib/catalog-price";

// CART (Renato 2026-11-25, item 32): the cart's pure rules and copy.
// The database enforces the same rules (migration
// 20261125130000_cart_items.sql); these give readers a clear message
// before a refused insert would.

export const CART_MAX_ITEMS = 50;
export const GIFT_NOTE_MAX = 300;

// c1 a: card payment is not open yet. Shown on the book page under the
// buttons, and at the last step after the reader presses Pay.
export const CARD_PAYMENT_SOON_LINE = "Pagesa me kartë hapet së shpejti.";
export const PAY_PRESSED_LINE = "Nuk u tarifua asgjë. Shporta juaj mbetet e ruajtur.";

export const ADD_TO_CART_LABEL = "Shto në shportë";
export const GIFT_LABEL = "Dhuroje";
export const IN_CART_LABEL = "Në shportë · Shiko shportën";

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type GiftInput = { email: string; note: string | null };
export type GiftInputResult = { ok: true; value: GiftInput } | { ok: false; error: "email" | "note" };

// The friend's email is stored lower case (the database checks it), so
// the same person can't get two copies of a book by a change of case.
export function readGiftInput(rawEmail: unknown, rawNote: unknown): GiftInputResult {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (email.length < 3 || email.length > 254 || !EMAIL_SHAPE.test(email)) {
    return { ok: false, error: "email" };
  }
  const noteText = typeof rawNote === "string" ? rawNote.trim() : "";
  if (noteText.length > GIFT_NOTE_MAX) {
    return { ok: false, error: "note" };
  }
  return { ok: true, value: { email, note: noteText === "" ? null : noteText } };
}

export type CartRow = {
  id: string;
  book_id: string;
  gift_email: string | null;
  gift_note: string | null;
  created_at: string;
};

export type CartBook = {
  id: string;
  title: string;
  price_all: number | null;
  status: string;
  cover_path: string | null;
};

// A row whose book is no longer live and paid (taken down, made free,
// turned into a pre-order) stays in the cart so the reader sees what
// happened, but it is not counted and can't be paid for.
export function cartLineBuyable(book: CartBook | null | undefined): boolean {
  return !!book && book.status === "published" && resolveCatalogPriceState(book.price_all) === "paid";
}

export function cartTotal(lines: { book: CartBook | null | undefined }[]): number {
  return lines.reduce((sum, line) => (cartLineBuyable(line.book) ? sum + (line.book!.price_all as number) : sum), 0);
}

export function lekLabel(amount: number): string {
  return formatCatalogAmountAll(amount);
}

export function cartCountLabel(count: number): string {
  return count === 1 ? "1 libër" : `${count} libra`;
}
