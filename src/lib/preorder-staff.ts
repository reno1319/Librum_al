// BD16 P3 (PLAN-BD16-r1 §3.4, D9, staff side): the pre-order rules the
// staff pages show, in English like the rest of /admin. Pure and
// client-safe. The database (migration 20261106120000, BD16 P1) decides
// every rule again: admin_approve_book_review refuses a late listing
// (LB506) and a third listing (LB501), releases a book whose final file
// is approved on or after its day, and run_preorder_day does the daily
// job. Nothing here can let staff do what the database refuses.
//
// Every date is a Tirana calendar day, "YYYY-MM-DD" (tirana_today()).
import { TIRANA_TIME_ZONE } from "@/lib/book-detail-dates";
import { PREORDER_MAX_PER_BOOK, addDays, preorderFileDueDate } from "@/lib/preorders";

/** What a waiting review asks staff to decide. */
export type ReviewKind =
  /** A draft asking to become a pre-order (review.release_date set). */
  | "listing"
  /** A live pre-order's change that brings its final manuscript. */
  | "final_file"
  /** A live pre-order's other changes (cover, description, 18+). */
  | "preorder_changes"
  /** A published book's changes (BD15 P5b). */
  | "live_changes"
  /** A draft asking to be published as usual. */
  | "publish";

export function reviewKind(params: {
  bookStatus: string;
  bookFilePath: string | null;
  reviewFilePath: string | null;
  reviewReleaseDate: string | null | undefined;
}): ReviewKind {
  if (params.bookStatus === "published") return "live_changes";
  if (params.bookStatus === "preorder") {
    // The final file comes as a waiting change while the book has none.
    return params.bookFilePath === null && params.reviewFilePath !== null ? "final_file" : "preorder_changes";
  }
  return (params.reviewReleaseDate ?? null) !== null ? "listing" : "publish";
}

/**
 * LB506's rule, for the page: a listing without its file can't be
 * approved after its file due date (release - 3), one with its file not
 * on or after the release day. Renato 11-06: no listing approval after
 * the date has passed. Send it back so the author picks a new date.
 */
export function isListingTooLate(params: { releaseDate: string; hasFile: boolean; today: string }): boolean {
  if (params.releaseDate <= params.today) return true;
  return !params.hasFile && preorderFileDueDate(params.releaseDate) < params.today;
}

/** A final file approved on or after the release day releases the book at once (BD15 Q3). */
export function finalFileReleasesNow(releaseDate: string, today: string): boolean {
  return releaseDate <= today;
}

/**
 * Q5 a: after staff send back a pre-order's final file, the author has
 * until the later of the file due date or 3 days after the send-back
 * (run_preorder_day's v_due, counted from today's send-back).
 */
export function resendDueAfterSendBack(releaseDate: string, today: string): string {
  const due = preorderFileDueDate(releaseDate);
  const afterSendBack = addDays(today, 3);
  return due > afterSendBack ? due : afterSendBack;
}

/** The hour in Tirana now (0-23). */
export function tiranaHour(now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIRANA_TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return Number.parseInt(hour, 10);
}

/**
 * Renato 11-06: a file that arrives before the 08:00 job counts as on
 * time. So the owner's "run now" refuses before 08:00 Tirana, as the
 * cron does: an earlier run would count a miss too soon.
 */
export const PREORDER_JOB_EARLIEST_HOUR = 8;

export function preorderJobMayRun(now: Date = new Date()): boolean {
  return tiranaHour(now) >= PREORDER_JOB_EARLIEST_HOUR;
}

export function formatStaffDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// --- The final manuscript, as staff see it -------------------------------

export type StaffFinalFileState = "approved" | "in_review" | "saved_not_sent" | "missing";

export function staffFinalFileLine(state: StaffFinalFileState, releaseDate: string, today: string): string {
  const due = formatStaffDay(preorderFileDueDate(releaseDate));
  switch (state) {
    case "approved":
      return "Final file approved. The book comes out by itself on its day.";
    case "in_review":
      return finalFileReleasesNow(releaseDate, today)
        ? "Final file waiting for review. The release day has passed: approve it or send it back."
        : "Final file waiting for review.";
    case "saved_not_sent":
      // Renato 11-06: after a lifted suspension the author must send the
      // final file again (the suspension cancelled its review).
      return `The author saved a final file but it isn't sent. After a suspension is lifted, the author must send the final file again. Due ${due}.`;
    case "missing":
      return `No final file yet. Due ${due}.`;
  }
}

export function preorderEyebrow(releaseDate: string | null): string {
  return releaseDate ? `Pre-order · comes out ${formatStaffDay(releaseDate)}` : "Pre-order";
}

export function preorderCountLine(count: number): string {
  return `Pre-order ${Math.min(count, PREORDER_MAX_PER_BOOK)} of ${PREORDER_MAX_PER_BOOK} for this book.`;
}

export function slipLine(slipUsed: boolean): string {
  return slipUsed
    ? "Its one date move is used. A missed file deadline now cancels the pre-order."
    : "Its one date move is not used. A first missed file deadline moves the date 30 days later.";
}

export function waitingReadersStaffLine(count: number | null): string {
  if (count === null) return "Couldn’t count the readers waiting for it.";
  return count === 1 ? "1 reader asked to be told when it comes out." : `${count} readers asked to be told when it comes out.`;
}

// --- Review box copy --------------------------------------------------------

export const LISTING_INTRO =
  "This is a pre-order listing. Approving shows it in the Bookstore as “coming out” on its date. Readers can't buy or download it until it comes out.";

export function listingDateLine(releaseDate: string, hasFile: boolean): string {
  const date = formatStaffDay(releaseDate);
  return hasFile
    ? `Comes out ${date}. The final file came with the listing, so the book comes out by itself on that day.`
    : `Comes out ${date}. No file yet: the author must send the final file by ${formatStaffDay(preorderFileDueDate(releaseDate))}.`;
}

export const LISTING_TOO_LATE_MESSAGE =
  "Too late to approve: this pre-order's date is too close. Send it back so the author picks a new date.";

export const NO_FILE_CHECKLIST_NOTE = "No book file yet, so there is no file to open.";

export function finalFileIntro(releaseDate: string, today: string): string {
  return finalFileReleasesNow(releaseDate, today)
    ? `This is the pre-order's final file. Its release day (${formatStaffDay(releaseDate)}) has passed, so approving releases the book at once.`
    : `This is the pre-order's final file. Approving keeps it a pre-order; it comes out by itself on ${formatStaffDay(releaseDate)} at about 08:00.`;
}

export const PREORDER_CHANGES_INTRO =
  "This book is a live pre-order. These are changes to it; readers keep seeing the current version until you approve them.";

export function finalFileSendBackNote(releaseDate: string, today: string): string {
  return `If you send the final file back, the author has until ${formatStaffDay(resendDueAfterSendBack(releaseDate, today))} to send it again, or it counts as a missed deadline.`;
}

export const PREORDER_UNPUBLISH_NOTE =
  "This book is a pre-order. Unpublishing cancels the pre-order: it leaves the Bookstore at once, and readers waiting for it get one email that it was cancelled.";

// --- The owner's "run now" result ----------------------------------------
// The result travels as ?preorderRun=<5 numbers>, digits only, and the
// line is built here from them, so a crafted link can only show numbers.
// (The key is written out at its two uses: the page-messages guard reads
// only literal query keys.)

export type PreorderRunCounts = {
  released: number;
  slipped: number;
  cancelled: number;
  overdue: number;
  failed: number;
};

export function encodeRunCounts(counts: PreorderRunCounts): string {
  return [counts.released, counts.slipped, counts.cancelled, counts.overdue, counts.failed].join(".");
}

export function parseRunCounts(raw: unknown): PreorderRunCounts | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^\d{1,5}(\.\d{1,5}){4}$/.test(value)) return null;
  const [released, slipped, cancelled, overdue, failed] = value.split(".").map((n) => Number.parseInt(n, 10));
  return { released, slipped, cancelled, overdue, failed };
}

export function runCountsLine(counts: PreorderRunCounts): string {
  const line = `Pre-order run done: ${counts.released} released, ${counts.slipped} moved 30 days later, ${counts.cancelled} cancelled, ${counts.overdue} overdue.`;
  return counts.failed > 0 ? `${line} ${counts.failed} couldn't be processed; run it again later.` : line;
}

export const PREORDER_RUN_TOO_EARLY_MESSAGE =
  "The pre-order run starts at 08:00 Tirana time, so a file sent before then still counts as on time. Try again after 08:00.";
export const PREORDER_RUN_FAILED_MESSAGE = "The pre-order run failed. Try again; running it twice changes nothing more.";
export const PREORDER_RUN_OWNER_ONLY_MESSAGE = "Only the owner can run the pre-order job.";

export const PREORDER_RUN_HEADING = "Daily pre-order run";
export const PREORDER_RUN_NOTE =
  "Runs by itself every morning at about 08:00 Tirana time. Use this if a day's run was missed, or to test on staging. Running it twice the same day changes nothing more.";
export const PREORDER_RUN_BUTTON = "Run the pre-order job now";

// --- Suspension (Renato 11-06: pause on suspend, back on lift; dates
// stay, card a) ------------------------------------------------------------

export const SUSPEND_PREORDER_NOTE =
  "Their pre-orders are paused, not cancelled: they leave the Bookstore and come back when the suspension is lifted, with the same dates. A final file waiting for review loses its review.";

export const LIFT_PREORDER_INTRO =
  "These pre-orders come back with their dates as they were. The author must send the final file again if it was waiting for review when the account was suspended. A pre-order that was taken down doesn't come back: lifting cancels it.";

/**
 * One paused pre-order in the Lift box. Renato 11-06 (a): the dates stay,
 * so a file due date that passed during the suspension counts at the
 * next daily run: the date moves 30 days, or (move used) the pre-order is
 * cancelled. A book with its final file approved just comes out on its day.
 */
export function liftPreorderLine(
  book: { title: string; releaseDate: string | null; slipUsed: boolean; hasApprovedFile: boolean },
  today: string,
): string {
  if (!book.releaseDate) return `“${book.title}”: can't come back as a pre-order; it stays a draft.`;
  const date = formatStaffDay(book.releaseDate);
  if (book.hasApprovedFile) {
    return finalFileReleasesNow(book.releaseDate, today)
      ? `“${book.title}”: final file approved; its day (${date}) has passed, so the next daily run releases it.`
      : `“${book.title}”: final file approved; comes out ${date}.`;
  }
  const due = preorderFileDueDate(book.releaseDate);
  // (A send-back of the final file can give 3 more days, Q5 a.)
  if (due >= today) return `“${book.title}”: comes out ${date}; final file due ${formatStaffDay(due)}.`;
  return book.slipUsed
    ? `“${book.title}”: its final file was due ${formatStaffDay(due)}, during the suspension, and its date move is used. The next daily run cancels it, and waiting readers get one email.`
    : `“${book.title}”: its final file was due ${formatStaffDay(due)}, during the suspension. The next daily run moves its date 30 days later.`;
}
