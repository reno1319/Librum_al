import { resolvePublicAuthorName } from "@/lib/author-name";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: the byline shown for one book -- its own
// pen name when the author set one (books.pen_name), else the author's
// public name, today's rule (resolvePublicAuthorName). `pen_name` is
// optional because a `select *` before migration 20261018091237 returns
// rows without it; undefined is treated exactly like null.
//
// Not wired into any page yet: F4 uses it everywhere a book's author name
// shows, and for the EPUB dc:creator.
export function resolveBookByline(
  book: { pen_name?: string | null } | null | undefined,
  authorProfile: Parameters<typeof resolvePublicAuthorName>[0],
): string | null {
  return book?.pen_name ?? resolvePublicAuthorName(authorProfile);
}
