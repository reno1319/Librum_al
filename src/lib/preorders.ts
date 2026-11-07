// BD16 P2 (PLAN-BD16-r1 §3.4, author side): the pre-order ("Parapublikim")
// rules the author's editor and bookshelf show and check, and their
// copy. The database (migration 20261106120000, BD16 P1) decides every
// rule again: request_book_review (LB500 14 days to 6 months, LB501 two
// pre-orders per book, LB502 no public-domain book), the listing
// approval, push_preorder_release_date (LB504) and the daily job.
//
// Every date here is a Tirana calendar day, "YYYY-MM-DD", as the
// database keeps it (tirana_today(), books.release_date). No import here
// is server-only: the Pricing form (a client component) uses the date
// rules and the copy; the reads take the caller's client.
import { TIRANA_TIME_ZONE, formatDateOnly } from "@/lib/book-detail-dates";
import type { createCatalogWriteClient } from "@/lib/catalog-write-client";

type CatalogWriter = ReturnType<typeof createCatalogWriteClient>;

/** The days and months Renato set (Q1 a, Q2 a, Q3b a; plan §1). */
export const PREORDER_MIN_DAYS_AHEAD = 14;
export const PREORDER_MAX_MONTHS_AHEAD = 6;
export const PREORDER_FILE_DUE_DAYS_BEFORE = 3;
export const PREORDER_PUSH_MAX_DAYS = 30;
export const PREORDER_MAX_PER_BOOK = 2;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day "YYYY-MM-DD", or null. */
export function parseDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DAY.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return `${y}-${m}-${d}`;
}

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fromDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** Today in Tirana (the database's tirana_today()). */
export function tiranaToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIRANA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(day: string, days: number): string {
  const date = fromDay(day);
  date.setUTCDate(date.getUTCDate() + days);
  return toDay(date);
}

/**
 * PostgreSQL's `date + interval 'N months'`: the same day N months on,
 * or that month's last day when it is shorter (31 Aug + 6 months =
 * 28/29 Feb).
 */
export function addMonths(day: string, months: number): string {
  const date = fromDay(day);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return toDay(new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay))));
}

/** The release days a new pre-order may ask for (LB500's window). */
export function preorderDateWindow(today: string): { min: string; max: string } {
  return { min: addDays(today, PREORDER_MIN_DAYS_AHEAD), max: addMonths(today, PREORDER_MAX_MONTHS_AHEAD) };
}

export function isInPreorderWindow(day: string, today: string): boolean {
  const { min, max } = preorderDateWindow(today);
  return day >= min && day <= max;
}

/** The last day the final manuscript is on time (release - 3). */
export function preorderFileDueDate(releaseDate: string): string {
  return addDays(releaseDate, -PREORDER_FILE_DUE_DAYS_BEFORE);
}

/** The days the one push may move the release to (LB504's window). */
export function preorderPushWindow(releaseDate: string): { min: string; max: string } {
  return { min: addDays(releaseDate, 1), max: addDays(releaseDate, PREORDER_PUSH_MAX_DAYS) };
}

export type PushState = "available" | "used" | "too_late";

/** Whether the author may still push the date (push_preorder_release_date). */
export function preorderPushState(book: { release_date: string; preorder_slip_used: boolean }, today: string): PushState {
  if (book.preorder_slip_used) return "used";
  if (today > preorderFileDueDate(book.release_date)) return "too_late";
  return "available";
}

export function isValidPushDate(releaseDate: string, wanted: string): boolean {
  const { min, max } = preorderPushWindow(releaseDate);
  return wanted >= min && wanted <= max;
}

// Why a draft can't be offered "Parapublikim" (null: it can).
export type PreorderBlock = "used_up" | "published_before" | "public_domain";

export function preorderBlock(book: {
  published_at: string | null;
  preorder_count: number;
  pd_work_id: string | null;
  rightsBasis: string | null;
}): PreorderBlock | null {
  // Renato 11-06 (★ a): only a book that was never live. Its buyers
  // already own it, so a "coming soon" page would mislead.
  if (book.published_at !== null) return "published_before";
  if (book.preorder_count >= PREORDER_MAX_PER_BOOK) return "used_up";
  // D3: a public-domain edition is free and ready; it is never a pre-order.
  if (book.pd_work_id !== null || book.rightsBasis === "public_domain") return "public_domain";
  return null;
}

// --- The Pricing tab's choice -------------------------------------------

export const RELEASE_MODE_FIELD = "releaseMode";
export const RELEASE_DATE_FIELD = "releaseDate";
export type ReleaseMode = "now" | "preorder";

export type ReleaseChoice =
  | { kind: "absent" }
  | { kind: "now" }
  | { kind: "preorder"; releaseDate: string }
  | { kind: "invalid"; reason: "mode" | "date" };

/** The submitted choice (absent: the form had no choice to make). */
export function parseReleaseChoice(formData: FormData): ReleaseChoice {
  if (!formData.has(RELEASE_MODE_FIELD)) return { kind: "absent" };
  const mode = formData.get(RELEASE_MODE_FIELD);
  if (mode === "now") return { kind: "now" };
  if (mode !== "preorder") return { kind: "invalid", reason: "mode" };
  const releaseDate = parseDay(formData.get(RELEASE_DATE_FIELD));
  return releaseDate === null ? { kind: "invalid", reason: "date" } : { kind: "preorder", releaseDate };
}

// --- The final manuscript of a live pre-order ---------------------------

export type FinalFileState =
  /** Approved: the book comes out by itself on its day. */
  | "approved"
  /** Sent, waiting for Librum. */
  | "in_review"
  /** Saved in the editor but not sent (also after a lifted suspension). */
  | "saved_not_sent"
  /** Not uploaded yet. */
  | "missing";

export function preorderFinalFileState(params: {
  bookFilePath: string | null;
  pendingFilePath: string | null;
  inReview: boolean;
}): FinalFileState {
  if (params.bookFilePath !== null) return "approved";
  if (params.pendingFilePath === null) return "missing";
  return params.inReview ? "in_review" : "saved_not_sent";
}

// --- Reads ----------------------------------------------------------------

/**
 * How many readers wait for each of the author's pre-orders ("Më
 * njofto"). Only a count: the author never sees who (plan §3.3). Read
 * with the trusted writer (the rows are each reader's own) and only for
 * books the caller proved are the author's. Null when unreadable
 * (display only).
 */
export async function countWaitingReaders(
  service: CatalogWriter,
  bookIds: readonly string[],
): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>();
  if (bookIds.length === 0) return counts;
  try {
    const { data, error } = await service
      .from("preorder_notify_requests")
      .select("book_id")
      .in("book_id", [...bookIds])
      .is("notified_at", null)
      .is("book_cancelled_at", null)
      .returns<{ book_id: string }[]>();
    if (error || !data) {
      console.error("countWaitingReaders: read failed", { code: error?.code ?? null });
      return null;
    }
    for (const row of data) {
      if (bookIds.includes(row.book_id)) counts.set(row.book_id, (counts.get(row.book_id) ?? 0) + 1);
    }
    return counts;
  } catch {
    console.error("countWaitingReaders: read failed");
    return null;
  }
}

// --- Copy (Albanian) ---------------------------------------------------------

export const formatReleaseDay = formatDateOnly;

export function preorderStatusLabel(releaseDate: string): string {
  return `Parapublikim · del më ${formatReleaseDay(releaseDate)}`;
}

export function waitingReadersLine(count: number): string {
  return count === 1 ? "1 lexues pret njoftimin" : `${count} lexues presin njoftimin`;
}

export const RELEASE_HEADING = "Kur del libri";
export const RELEASE_NOW_LABEL = "Publikojeni sapo ta miratojë Librum";
export const RELEASE_NOW_SUBLINE = "Si zakonisht.";
export const RELEASE_PREORDER_LABEL = "Parapublikim";
export const RELEASE_PREORDER_SUBLINE =
  "Lexuesit e shohin librin para se të dalë dhe mund të kërkojnë një njoftim. Dorëshkrimi final mund të vijë më vonë.";
export const RELEASE_DATE_LABEL = "Data e daljes";
export const RELEASE_DATE_TODO_LABEL = "Data e daljes së parapublikimit";
export const PREORDER_SEND_NOTE = "Librum e shqyrton parapublikimin para se të shfaqet në Librari.";

export function releaseDateHint(window: { min: string; max: string }): string {
  return `Nga ${formatReleaseDay(window.min)} deri më ${formatReleaseDay(window.max)}. Dorëshkrimi final duhet dërguar për shqyrtim deri ${PREORDER_FILE_DUE_DAYS_BEFORE} ditë para kësaj date. Nëse vonohet, data shtyhet një herë me 30 ditë; herën e dytë parapublikimi anulohet.`;
}

export const PREORDER_USED_UP_NOTE = "Ky libër ka pasur 2 parapublikime. Tani mund të publikohet vetëm si zakonisht.";
export const PREORDER_PUBLISHED_BEFORE_NOTE = "Ky libër ka qenë i publikuar, ndaj nuk mund të bëhet parapublikim.";
export const PREORDER_PUBLIC_DOMAIN_NOTE = "Një libër i domenit publik nuk mund të bëhet parapublikim.";
export const PREORDER_BLOCK_NOTES: Record<PreorderBlock, string> = {
  used_up: PREORDER_USED_UP_NOTE,
  published_before: PREORDER_PUBLISHED_BEFORE_NOTE,
  public_domain: PREORDER_PUBLIC_DOMAIN_NOTE,
};

export const PREORDER_DATE_INVALID_MESSAGE = "Zgjidhni një datë daljeje nga 14 ditë deri në 6 muaj nga sot.";
export const PREORDER_NOT_AVAILABLE_MESSAGE = "Ky libër nuk mund të bëhet parapublikim.";
export const PREORDER_SENT_MESSAGE =
  "Parapublikimi u dërgua për shqyrtim. Kur Librum ta miratojë, libri shfaqet në Librari me datën e daljes.";

export const PREORDER_PANEL_HEADING = "Parapublikimi";

export function preorderReleaseLine(releaseDate: string): string {
  return `Libri del më ${formatReleaseDay(releaseDate)}, rreth orës 08:00.`;
}

export function finalFileLine(state: FinalFileState, releaseDate: string): string {
  const due = formatReleaseDay(preorderFileDueDate(releaseDate));
  switch (state) {
    case "approved":
      return "Dorëshkrimi final është miratuar. Libri del vetë në datën e tij.";
    case "in_review":
      return "Dorëshkrimi final është në shqyrtim. Nëse Librum e miraton pas datës së daljes, libri del sapo të miratohet.";
    case "saved_not_sent":
      // BD16 P1 re-audit: after a lifted suspension the earlier send is
      // cancelled but the file stays saved -- this line says so.
      return `Dorëshkrimi final është ruajtur, por nuk është dërguar për shqyrtim (edhe nëse e kishit dërguar më parë, një pezullim i llogarisë e anulon dërgimin). Dërgojeni te Çmimi deri më ${due}.`;
    case "missing":
      return `Dorëshkrimi final nuk është ngarkuar ende. Ngarkojeni te Përmbajtja dhe dërgojeni për shqyrtim te Çmimi deri më ${due}.`;
  }
}

export const FINAL_FILE_MISS_RULE =
  "Nëse dorëshkrimi final nuk dërgohet në kohë, data shtyhet vetë me 30 ditë një herë; herën e dytë parapublikimi anulohet.";

export const PUSH_HEADING = "Shtyni datën e daljes";
export const PUSH_NOTE =
  "Mund ta shtyni vetëm një herë, deri në 30 ditë. Kjo është shtyrja e vetme: nëse pas saj dorëshkrimi vonohet, parapublikimi anulohet.";
export const PUSH_BUTTON = "Shtyni datën";
export const PUSH_USED_NOTE = "Data e daljes është shtyrë një herë dhe nuk mund të shtyhet më.";
export const PUSH_TOO_LATE_NOTE = "Afati i dorëshkrimit final ka kaluar, ndaj data nuk mund të shtyhet më.";
export const PUSH_DONE_MESSAGE = "Data e daljes u shty.";
export const PUSH_INVALID_MESSAGE = "Zgjidhni një datë të re nga 1 deri në 30 ditë pas datës së tanishme.";
export const PUSH_REFUSED_MESSAGE = "Data nuk mund të shtyhet më për këtë parapublikim.";

export const CANCEL_PREORDER_BUTTON = "Anuloni parapublikimin";
export const CANCEL_PREORDER_CONFIRM_FIELD = "confirmCancelPreorder";
export const CANCEL_PREORDER_CONFIRM_TEXT = "Po, dua ta anuloj parapublikimin.";
export const CANCEL_PREORDER_CONFIRM_MISSING_MESSAGE = "Shënoni kutinë për të konfirmuar anulimin.";
export const PREORDER_CANCELLED_MESSAGE = "Parapublikimi u anulua. Libri është sërish draft.";
export const PREORDER_NOT_PREORDER_MESSAGE = "Ky libër nuk është më parapublikim. Rifreskoni faqen.";
export const PREORDER_DELETE_NOTE = "Për ta fshirë, anuloni fillimisht parapublikimin.";
export const PREORDER_UNPUBLISH_REFUSED_MESSAGE = "Ky libër është parapublikim. Përdorni «Anuloni parapublikimin».";

export function cancelPreorderNote(params: { waiting: number | null; preorderCount: number }): string {
  const readers =
    params.waiting === null
      ? "Lexuesit që kërkuan njoftim marrin një email se u anulua."
      : params.waiting === 0
        ? "Asnjë lexues nuk ka kërkuar njoftim ende."
        : `${params.waiting === 1 ? "1 lexuesi" : `${params.waiting} lexuesit`} që kërkuan njoftim marrin një email se u anulua.`;
  const again =
    params.preorderCount >= PREORDER_MAX_PER_BOOK
      ? "Ky ishte parapublikimi i dytë: pas anulimit libri mund të publikohet vetëm si zakonisht."
      : "Mund ta parapublikoni edhe një herë më vonë.";
  return `Libri hiqet nga Libraria dhe bëhet sërish draft. ${readers} ${again}`;
}

export const PREORDER_EDIT_NOTE =
  "Ky libër është parapublikim në Librari. Ndryshimet në dorëshkrim, ballinë, përshkrim, etiketën 18+ ose autorin origjinal presin miratimin e Librum, ndërsa lexuesit shohin versionin e tanishëm. Ndryshimet e tjera, si çmimi ose kategoritë, dalin menjëherë.";
export const PREORDER_MANAGE_LINK = "Anuloni parapublikimin";

export const PREORDER_IN_REVIEW_NOTE =
  "Parapublikimi mbetet në Librari siç është. Lexuesit shohin ndryshimet vetëm pasi Librum t'i miratojë.";
export const PREORDER_REVIEW_CANCELLED_MESSAGE =
  "Shqyrtimi u anulua. Parapublikimi mbetet në Librari; ndryshimet tuaja presin përsëri te redaktori.";
