import type { SupabaseClient } from "@supabase/supabase-js";
import { splitKeywords } from "@/lib/book-details";

// BD15 P7 (migration 20261105180000; PLAN-BD15-r1 §2.6; Renato 5 Nov,
// Q1-Q4 a): public-domain editions. One public edition per work, picked
// by staff when they approve it; the work's previous edition goes back
// to its uploader's shelf as a draft, and its old page sends readers to
// the picked one. Without an editor mention the uploader's pen name is
// never public on the edition (public_books shows no pen name for it).
// Client-safe: copy and small pure rules; the one read takes a client.

/** Q4 a: the credited uploader's line on the book page. */
export const PD_PREPARED_BY = "Përgatiti për botim:";

/** Q1 a: shown to the author on a picked edition (editor and shelf). */
export const PD_PICKED_LINE = "Ky botim është zgjedhur nga Librum.";
export const PD_PICKED_EDITOR_NOTE =
  "Ky botim është zgjedhur nga Librum për këtë vepër. Mund të dërgoni për shqyrtim vetëm dorëshkrimin, ballinën, përshkrimin, etiketën 18+ dhe autorin origjinal. Fushat e tjera nuk ndryshojnë më.";
/** The editor's Veprime box on a picked edition (LB483, LB484). */
export const PD_PICKED_ACTIONS_NOTE =
  "Ky botim është zgjedhur nga Librum, prandaj nuk mund ta hiqni nga shitja ose ta fshini.";
/** LB497: a save tried to change a frozen detail. */
export const PD_FROZEN_MESSAGE =
  "Ky botim është zgjedhur nga Librum, prandaj kjo fushë nuk ndryshon. Nëse diçka duhet korrigjuar, ngarkoni një botim të ri dhe Librum mund ta zgjedhë atë.";

/** Q2 a: on the old edition after a swap. */
export const PD_REPLACED_LINE = "Librum zgjodhi një botim tjetër të kësaj vepre.";

/** Q3 a: the ready-made note staff send back with. */
export const PD_ALREADY_HAVE_NOTE = "Librum ka tashmë një botim të kësaj vepre.";

type EditionFacts = {
  status: string;
  published_at: string | null;
  pd_work_id?: string | null;
};

/**
 * A live book linked to a work is that work's picked edition: the
 * database never lets another linked book be published (LB485).
 */
export function isPickedPdEdition(book: EditionFacts): boolean {
  return Boolean(book.pd_work_id) && book.status === "published";
}

/**
 * A linked book that was published once and is a draft again (and not
 * taken down) was replaced by another edition: an author cannot
 * unpublish a picked edition (LB483), so only a swap does this.
 */
export function isReplacedPdEdition(book: EditionFacts, takenDown: boolean): boolean {
  return Boolean(book.pd_work_id) && book.status === "draft" && book.published_at !== null && !takenDown;
}

/** The author's shelf line for an edition, if any. */
export function pdShelfLine(book: EditionFacts, takenDown: boolean): string | null {
  if (isPickedPdEdition(book)) return PD_PICKED_LINE;
  if (isReplacedPdEdition(book, takenDown)) return PD_REPLACED_LINE;
  return null;
}

/** Whether the book page shows the uploader as "Përgatiti për botim". */
export function showsPreparedBy(book: { pd_work_id?: string | null; pd_editor_credit?: boolean | null }): boolean {
  return Boolean(book.pd_work_id) && book.pd_editor_credit === true;
}

/** The no-review details the live Details save writes (LB497 freezes them). */
export type PdFrozenDetails = {
  subtitle: string | null;
  language: string | null;
  series_id: string | null;
  series_position: number | null;
  edition_number: number | null;
  reading_age_min?: number | null;
  categories: string[] | null;
  keywords: string | null;
};

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Audit r1 N2: whether a save of a picked edition changes none of its
 * frozen details, compared the way the form normalizes them (an older
 * book's "a,b" keywords equal the form's "a, b"). The save then skips
 * the write instead of tripping LB497 on a change that is not one.
 */
export function pdFrozenDetailsUnchanged(stored: PdFrozenDetails, wanted: PdFrozenDetails): boolean {
  const keywords = (raw: string | null) => splitKeywords(raw ?? "").join(", ");
  const categories = (list: string[] | null) => (list ?? []).join("\u0000");
  return (
    sameText(stored.subtitle, wanted.subtitle) &&
    (stored.language || "sq") === (wanted.language || "sq") &&
    (stored.series_id ?? null) === (wanted.series_id ?? null) &&
    (stored.series_position ?? null) === (wanted.series_position ?? null) &&
    (stored.edition_number ?? null) === (wanted.edition_number ?? null) &&
    (!("reading_age_min" in wanted) || (stored.reading_age_min ?? null) === (wanted.reading_age_min ?? null)) &&
    categories(stored.categories) === categories(wanted.categories) &&
    keywords(stored.keywords) === keywords(wanted.keywords)
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Q2 a: the picked edition a replaced edition's page should send readers
 * to, or null (not a replaced edition, or the read failed: the page then
 * shows its usual "not found").
 */
export async function readPdEditionRedirect(supabase: SupabaseClient, bookId: string): Promise<string | null> {
  if (!UUID.test(bookId)) return null;
  try {
    const { data, error } = await supabase.rpc("pd_edition_redirect", { p_book_id: bookId });
    if (error || typeof data !== "string" || !UUID.test(data) || data === bookId) return null;
    return data;
  } catch {
    return null;
  }
}
