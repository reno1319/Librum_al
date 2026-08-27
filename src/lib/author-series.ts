import type { Book, Series } from "@/lib/types";

// LIBRUM 2.0 PRODUCT-2: the public author page needs a compact "Series"
// section without turning it into N series queries (one per series) or
// N book queries (one per series to fetch its covers) -- the author
// page already fetches every one of the author's published books in a
// single query for the main grid, and that result alone has everything
// needed to group by series_id, count members, and order them by
// series_position. The only extra round trip is a single `series`
// title lookup (`.in("id", seriesIds)`), done by the caller; this
// function is pure grouping/ordering over data both queries already
// returned.

export type AuthorSeriesGroup = {
  id: string;
  title: string;
  bookCount: number;
  // Capped, ordered subset used for the small cover strip -- never the
  // full member list, so a long series can't blow up the section.
  covers: Pick<Book, "id" | "title" | "cover_path">[];
};

const MAX_COVERS_PER_SERIES = 4;

// A book whose series_id points at a series row this author's own
// public series lookup didn't return (deleted series, or -- belt and
// suspenders -- any row this caller didn't pass in) is silently
// dropped rather than shown with a blank title: the FK is `on delete
// cascade` so this shouldn't happen in practice, but this function
// never assumes its inputs are already consistent with each other.
export function groupPublishedBooksBySeries(
  books: Pick<Book, "id" | "title" | "cover_path" | "series_id" | "series_position">[],
  series: Pick<Series, "id" | "title">[],
): AuthorSeriesGroup[] {
  const seriesById = new Map(series.map((s) => [s.id, s]));
  const membersBySeriesId = new Map<string, typeof books>();

  for (const book of books) {
    if (!book.series_id || !seriesById.has(book.series_id)) continue;
    const members = membersBySeriesId.get(book.series_id) ?? [];
    members.push(book);
    membersBySeriesId.set(book.series_id, members);
  }

  // Map iteration order follows first-appearance order in `books`,
  // which the caller already sorts newest-first -- so the series whose
  // most recently published entry is newest appears first, with no
  // separate sort/tiebreak logic needed here.
  const groups: AuthorSeriesGroup[] = [];
  for (const [seriesId, members] of membersBySeriesId) {
    const ordered = [...members].sort((a, b) => {
      if (a.series_position == null) return 1;
      if (b.series_position == null) return -1;
      return a.series_position - b.series_position;
    });
    groups.push({
      id: seriesId,
      title: seriesById.get(seriesId)!.title,
      bookCount: members.length,
      covers: ordered.slice(0, MAX_COVERS_PER_SERIES),
    });
  }
  return groups;
}
