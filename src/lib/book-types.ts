// Upload notes C (Enkelejd 11-06, note 4; Renato 11-06: option a and the
// list as drafted): "Lloji i librit", the book's form, one pick, shown
// before the genres. These exact strings are what books.book_type holds,
// so this list and the books_book_type_check CHECK in
// supabase/schema.sql (migration 20261107120000_book_type.sql) must stay
// identical. All strings are Unicode NFC (ë is U+00EB).
export const BOOK_TYPES = [
  "Roman",
  "Novelë / tregim",
  "Përmbledhje me tregime",
  "Poezi",
  "Dramë",
  "Ese",
  "Biografi & kujtime",
  "Jo-artistik (studim, tjetër)",
] as const;

// The field's name, in the editor and on the book page.
export const BOOK_TYPE_LABEL = "Lloji i librit";

export type BookType = (typeof BOOK_TYPES)[number];

export function isBookType(value: unknown): value is BookType {
  return typeof value === "string" && (BOOK_TYPES as readonly string[]).includes(value);
}

/** A stored value the website shows, or null (none yet, or not on the list). */
export function bookTypeOf(book: { book_type?: string | null }): BookType | null {
  return isBookType(book.book_type) ? book.book_type : null;
}
