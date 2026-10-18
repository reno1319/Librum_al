import { resolvePublicAuthorName } from "@/lib/author-name";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: the byline shown for one book -- its own
// pen name when the author set one (books.pen_name), else the author's
// public name, today's rule (resolvePublicAuthorName). `pen_name` is
// optional because a `select *` before migration 20261018091237 returns
// rows without it; undefined is treated exactly like null.
//
// F4: used everywhere a BOOK's author name shows (book cards, shelves,
// the book page's "by" line, the read sample, Add a book's preview card)
// and for the EPUB dc:creator. Not used where the AUTHOR is named: the
// "About the author" box, author pages' own headings, Following, admin,
// dashboard lists and the follower email keep resolvePublicAuthorName.
export function resolveBookByline(
  book: { pen_name?: string | null } | null | undefined,
  authorProfile: Parameters<typeof resolvePublicAuthorName>[0],
): string | null {
  return book?.pen_name ?? resolvePublicAuthorName(authorProfile);
}

// F4 (P5): the client surface attachPenNames needs. The parameter only
// promises `from("books")`, because checking the page's whole typed
// Supabase client against the full query chain is "excessively deep"
// for TypeScript (TS2589); the chain is typed at its one use below.
type PenNameReader = { from(relation: "books"): unknown };
type PenNameQuery = {
  select(columns: "id, pen_name"): {
    in(column: "id", values: string[]): PromiseLike<{ data: unknown; error: { code?: string | null } | null }>;
  };
};

// F4 (P5): pages whose book query names its columns (rather than `*`)
// get pen names through this one extra read, called once per page over
// all of the page's books, instead of adding `pen_name` to their select
// lists -- a named column that does not exist yet would fail the page's
// main query before the migration. Before the migration (feature-off
// code) or on any other error the books come back unchanged, so their
// bylines fall back to the author's public name, exactly as today.
export async function attachPenNames<T extends { id: string }>(
  client: PenNameReader,
  books: T[],
): Promise<(T & { pen_name?: string | null })[]> {
  if (books.length === 0) return books;
  const ids = [...new Set(books.map((book) => book.id))];
  try {
    const { data, error } = await (client.from("books") as PenNameQuery).select("id, pen_name").in("id", ids);
    if (error) {
      if (isSchemaFeatureOffError(error)) {
        logSchemaFeatureOffOnce("book pen name", error);
      } else {
        console.error("attachPenNames: pen name read failed", { code: error.code ?? null });
      }
      return books;
    }
    const penNames = new Map<string, string | null>();
    for (const row of Array.isArray(data) ? data : []) {
      const { id, pen_name } = (row ?? {}) as { id?: unknown; pen_name?: unknown };
      if (typeof id === "string" && (typeof pen_name === "string" || pen_name === null)) {
        penNames.set(id, pen_name);
      }
    }
    return books.map((book) => (penNames.has(book.id) ? { ...book, pen_name: penNames.get(book.id) } : book));
  } catch (error) {
    console.error("attachPenNames: pen name read failed", error);
    return books;
  }
}
