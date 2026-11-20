// K8 rate prompt (Renato 11-20): when an owner reaches the last page of a
// book in the online reader, a bar asks "Libri mbaroi. Të pëlqeu?" with
// five stars (k8q1 b). A star opens the book page's existing review form
// with those stars already chosen (k8q2 a). The bar is shown only to an
// owner, free or bought (k8q4 a), who has no review of the book in any
// status, and "Jo tani" hides it for that book in this browser only
// (k8q3 a). Nothing here is saved on the server.

export const RATE_PROMPT_TEXT = "Libri mbaroi. Të pëlqeu?";
export const RATE_PROMPT_LATER = "Jo tani";

// The chosen stars reach the book page as ?yje=N (read by the page as
// searchParams.yje).

export const RATE_DISMISS_PREFIX = "librum-rate-later:";

export function rateDismissKey(bookId: string): string {
  return `${RATE_DISMISS_PREFIX}${bookId}`;
}

/** The book page's review form, with the chosen stars (1..5). */
export function reviewFormHref(bookId: string, stars: number): string {
  return `/libra/${bookId}?yje=${stars}#vleresimet`;
}

/** Stars from the query: a whole number 1..5, anything else is null. */
export function parseRateStars(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^[1-5]$/.test(raw)) return null;
  return Number(raw);
}

/** The form's starting stars: an own review's stars win over the link. */
export function initialReviewStars(ownRating: number | null | undefined, fromLink: number | null): number | "" {
  return ownRating ?? fromLink ?? "";
}

// "Jo tani", remembered in this browser. Blocked storage (private mode)
// reads as not dismissed and the click just hides the bar until the
// reader is closed.
export function readRateDismissed(bookId: string): boolean {
  try {
    return window.localStorage.getItem(rateDismissKey(bookId)) === "1";
  } catch {
    return false;
  }
}

export function writeRateDismissed(bookId: string): void {
  try {
    window.localStorage.setItem(rateDismissKey(bookId), "1");
  } catch {
    // Storage blocked: nothing to remember.
  }
}

/**
 * The Library's rule: the bar may show for a book only when the reader's
 * own reviews and own books were read, none of those reviews is for that
 * book, and the reader is not its author (audit r1 L1; an author can't
 * review their own book). A failed read shows no bar anywhere (never nag
 * someone who may have reviewed already).
 */
export function showRatePrompt(
  bookId: string,
  ownReviews: { data: { book_id: string }[] | null; error: unknown },
  ownBooks: { data: { id: string }[] | null; error: unknown },
): boolean {
  if (ownReviews.error || !ownReviews.data || ownBooks.error || !ownBooks.data) return false;
  if (ownBooks.data.some((b) => b.id === bookId)) return false;
  return !ownReviews.data.some((r) => r.book_id === bookId);
}

/**
 * The reader's rule for the bar (k8q1 b): an owned book with the prompt
 * on, not put off with "Jo tani", on the last page of text (the last
 * spread on a computer), and nothing else open at the bottom.
 */
export function rateBarVisible(s: {
  enabled: boolean;
  later: boolean;
  mode: "sample" | "full" | "owned";
  onContent: boolean;
  view: number;
  lastView: number | null;
  busy: boolean;
}): boolean {
  return s.enabled && !s.later && s.mode === "owned" && s.onContent && s.lastView !== null && s.view === s.lastView && !s.busy;
}
