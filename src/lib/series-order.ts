import type { Book } from "@/lib/types";

// LIBRUM 2.0 PRODUCT-3: the single canonical ordering rule for "what
// order is this series in," shared by the public Series page
// (src/app/series/[id]/page.tsx) and Book Detail's Previous/Next
// continuity nav -- both surfaces call this so neither can silently
// drift onto a different order. Same "caller pre-filters" contract as
// groupPublishedBooksBySeries (src/lib/author-series.ts): this function
// only orders an already-published-only list, it never fetches or
// filters by status itself.
//
// Order: series_position ascending, nulls last. Two books that somehow
// share the same series_position (or are both null) tie-break on
// created_at ascending -- a real, already-fetched timestamp, never an
// arbitrary/random order. A further tie on created_at itself
// (theoretically possible, e.g. bulk-imported rows) falls back to `id`
// ascending purely so the result is fully deterministic across
// renders/requests, not because id carries any actual reading-order
// meaning. Gaps in stored positions (1, 3, 7) are preserved exactly as
// stored -- this never renumbers anything.
type OrderableSeriesBook = Pick<Book, "id" | "series_position" | "created_at">;

export function orderSeriesBooks<T extends OrderableSeriesBook>(books: T[]): T[] {
  return [...books].sort((a, b) => {
    if (a.series_position != null && b.series_position != null) {
      if (a.series_position !== b.series_position) {
        return a.series_position - b.series_position;
      }
    } else if (a.series_position != null) {
      return -1;
    } else if (b.series_position != null) {
      return 1;
    }

    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type SeriesNeighbors<T> = {
  previous: T | null;
  next: T | null;
};

// Pure lookup over an already-ordered list (the output of
// orderSeriesBooks) -- no wraparound: a first book has no previous, a
// last book has no next, and a single-book series has neither. A
// currentBookId that isn't in the list at all (e.g. an author
// previewing their own unpublished book, which the published-only
// series-entries query never returned in the first place) resolves to
// no neighbors on either side rather than guessing at a position.
export function resolveSeriesNeighbors<T extends { id: string }>(
  orderedBooks: T[],
  currentBookId: string,
): SeriesNeighbors<T> {
  const index = orderedBooks.findIndex((b) => b.id === currentBookId);
  if (index === -1) {
    return { previous: null, next: null };
  }
  return {
    previous: index > 0 ? orderedBooks[index - 1]! : null,
    next: index < orderedBooks.length - 1 ? orderedBooks[index + 1]! : null,
  };
}
