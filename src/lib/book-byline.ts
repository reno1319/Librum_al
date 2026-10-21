import type { PenNameRef } from "@/lib/pen-names";

// PEN-NAMES-1 (migration 20261019184512): the byline shown for one book
// is its pen name -- every book has one (the author's default pen name
// when no other was chosen) -- read through the public_pen_names view,
// embedded in the book query as `pen:public_pen_names(id, name)`. The
// account behind it is never read here.
//
// Used everywhere a BOOK's author name shows (book cards, shelves, the
// book page, the read sample, the hero shelf, Librum's choice) and for
// the EPUB dc:creator. null only when the embed is missing.
export const BOOK_PEN_NAME_EMBED = "pen:public_pen_names(id, name)";

export function resolveBookByline(
  book: { pen?: PenNameRef | null } | null | undefined,
): string | null {
  return book?.pen?.name ?? null;
}
