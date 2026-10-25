// HOME-PICKS-1: the pure rules of the home page cover fan, kept out of
// the page so they are unit-testable without a render harness.
//
// Renato (2026-10-25): three covers on phone and desktop, picked by
// staff into slots 1-3 (slot 1 is the middle, front cover). A slot that
// is empty, or whose book is no longer live (unpublished, taken down,
// out of the store for review, no cover, no price), shows the newest
// live book not already in the fan instead, so the fan is never broken.
// A paid slot carries a "Sponsored" tag; a fallback book never does.

export const HOME_SLOT_COUNT = 3;
export const HOME_SLOTS = [1, 2, 3] as const;
export type HomeSlot = (typeof HOME_SLOTS)[number];

// Admin labels: where each slot sits in the fan.
export const HOME_SLOT_LABELS: Record<HomeSlot, string> = {
  1: "Slot 1 (middle, in front)",
  2: "Slot 2 (left)",
  3: "Slot 3 (right)",
};

export type HomeSlotRow = { slot: number; book_id: string; sponsored: boolean };

export type FanCover<T> = { slot: HomeSlot; book: T; sponsored: boolean };

// A book may stand in the fan only if it would be on the home page at
// all: published, a cover, a price (free = 0 counts). The same filter
// as the newest list and set_home_featured_slot() in the database.
export function qualifiesForHomeFan(book: {
  status: string | null;
  price_all: number | null;
  cover_path: string | null;
}): boolean {
  return book.status === "published" && book.price_all != null && book.cover_path != null;
}

// slots: the public view's rows (only slots whose book is published).
// picked: the live books those rows name, by id, already filtered with
// qualifiesForHomeFan (a missing id = not live any more).
// newest: the newest live books, newest first.
// Returns one cover per slot in slot order (1, 2, 3), each book at most
// once, or [] when fewer than HOME_SLOT_COUNT books exist at all (the
// hero then shows its photograph, never a half-empty fan).
export function resolveHomeFan<T extends { id: string }>(
  slots: HomeSlotRow[],
  picked: ReadonlyMap<string, T>,
  newest: T[],
): FanCover<T>[] {
  const bySlot = new Map<number, FanCover<T>>();
  const used = new Set<string>();
  for (const slot of HOME_SLOTS) {
    const row = slots.find((s) => s.slot === slot);
    const book = row ? picked.get(row.book_id) : undefined;
    if (!row || !book || used.has(book.id)) continue;
    bySlot.set(slot, { slot, book, sponsored: row.sponsored === true });
    used.add(book.id);
  }

  const fallback = newest.filter((book) => !used.has(book.id));
  const fan: FanCover<T>[] = [];
  for (const slot of HOME_SLOTS) {
    const filled = bySlot.get(slot);
    if (filled) {
      fan.push(filled);
      continue;
    }
    const book = fallback.shift();
    if (!book) return [];
    used.add(book.id);
    fan.push({ slot, book, sponsored: false });
  }
  return fan;
}

// The order the fan draws its covers left to right: slot 2, slot 1 (the
// middle, in front), slot 3.
export function fanDrawOrder<T>(fan: FanCover<T>[]): FanCover<T>[] {
  const at = (slot: HomeSlot) => fan.find((c) => c.slot === slot);
  return [at(2), at(1), at(3)].filter((c): c is FanCover<T> => c !== undefined);
}

// "Published with Librum" (Renato 2026-10-25, 3a): three books, skipping
// the fan's books while enough other books exist, then filling any gap
// with fan books in slot order. Never a book twice.
export const FEATURED_BOOK_COUNT = 3;

export function pickShowcaseBooks<T extends { id: string }>(newest: T[], fanBooks: T[]): T[] {
  const inFan = new Set(fanBooks.map((b) => b.id));
  const others = newest.filter((b) => !inFan.has(b.id)).slice(0, FEATURED_BOOK_COUNT);
  const fill = fanBooks.slice(0, FEATURED_BOOK_COUNT - others.length);
  return [...others, ...fill];
}

// Admin form input: a slot number from a form field, or null.
export function parseHomeSlot(raw: unknown): HomeSlot | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  return (HOME_SLOTS as readonly number[]).includes(n) && raw === String(n) ? (n as HomeSlot) : null;
}
