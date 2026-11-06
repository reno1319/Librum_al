import { formatDateOnly, TIRANA_TIME_ZONE } from "@/lib/book-detail-dates";
import type { BookStatus } from "@/lib/types";

// BD16 P4 (plan PLAN-BD16-r1 D1, D7, D8): what readers see for a
// pre-order ("Parapublikim"). Pure helpers only; the pages render them.
// The database (P1, migration 20261106120000) decides what is a
// pre-order and refuses buying, downloading, samples and reviews for it;
// these helpers only choose the words.

// The statuses a public list shows (D1: pre-orders everywhere books are,
// except the home page and the "free to start reading" shelf).
export const LISTED_BOOK_STATUSES = ["published", "preorder"] as const satisfies readonly BookStatus[];

export function isPreorder(book: { status?: string | null } | null | undefined): boolean {
  return book?.status === "preorder";
}

// Today's calendar day in Tirana as "YYYY-MM-DD" -- the same day the
// database's tirana_today() returns.
export function tiranaToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIRANA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// The badge and the page line: "Del më 12 dhjetor 2026" (D7: a day, not
// a time). When the day has passed the book is still waiting -- for
// staff to approve its final file (it then comes out at once), for a
// late send-back's extra 3 days to run out, or for the morning job --
// so it reads "Del së shpejti" instead of a date in the past. On the
// release day itself (before the 08:00 job) the date is today's and is
// still shown.
export const PREORDER_SOON_LABEL = "Del së shpejti";

export function preorderReleaseLabel(releaseDate: string | null | undefined, today: string): string {
  if (!releaseDate || releaseDate < today) return PREORDER_SOON_LABEL;
  return `Del më ${formatDateOnly(releaseDate)}`;
}

// The line under the price on the book page (no payment: buying is off
// until the book comes out, plan §1 "No payment").
export const PREORDER_PRICE_NOTE =
  "Ky libër është në parapublikim. Nuk mund të blihet ose të shkarkohet para se të dalë.";

// "Më njofto" (plan §1, D8). Signed-in readers only; one email when the
// book comes out (or one if the pre-order is cancelled).
export const NOTIFY_ME_LABEL = "Më njofto kur të dalë";
export const NOTIFY_SIGN_IN_LABEL = "Hyni që të njoftoheni";
export const NOTIFY_ON_NOTICE = "Do t'ju njoftojmë me email kur të dalë libri.";
export const NOTIFY_REMOVE_LABEL = "Hiq njoftimin";
export const NOTIFY_HELP = "Do të merrni një email të vetëm kur të dalë libri.";

// The reader's "Njoftimet e mia" page (D8).
export const MY_NOTICES_PATH = "/account/njoftimet";
export const MY_NOTICES_TITLE = "Njoftimet e mia";

// The ?notify= values the book page understands (anything else: nothing).
export type NotifyStatus = "on" | "off" | "error";
export function readNotifyStatus(value: string | undefined): NotifyStatus | null {
  return value === "on" || value === "off" || value === "error" ? value : null;
}

export const NOTIFY_STATUS_MESSAGES: Record<NotifyStatus, string> = {
  on: NOTIFY_ON_NOTICE,
  off: "Njoftimi u hoq.",
  error: "Nuk u ruajt. Ky libër mund të mos jetë më në parapublikim.",
};

// A notice row the reader still waits on: not yet sent and the
// pre-order not ended. Rows of released or cancelled pre-orders are
// left out of "Njoftimet e mia".
export function isWaitingNotice(row: { notified_at: string | null; book_cancelled_at: string | null }): boolean {
  return row.notified_at === null && row.book_cancelled_at === null;
}
