// LR1 patch 4 (Renato 2026-11-25/26): "Çfarë po lexojmë" on Libraria.
// Pure rules shared by the admin form, its action and the pages. The
// database checks the same limits again (migration
// 20261126090000_libraria_reading_picks.sql).

// lr4-4 a: a new pick starts with this badge; staff may change or clear it.
export const DEFAULT_PICK_BADGE = "Zgjedhja e Librum";
export const MAX_PICK_BADGE = 24;
// My calls, shown in the pictures: the note fits the middle column, the
// quote the green panel.
export const MAX_PICK_NOTE = 400;
export const MAX_PICK_QUOTE = 240;
// The "Më shumë" page lists at most this many picks (newest first).
export const PICK_PAGE_LIMIT = 60;

export type QuoteFrom = "book" | "author";

export type PickRow = {
  id: string;
  book_id: string;
  badge: string | null;
  note: string;
  quote: string;
  quote_from: QuoteFrom;
  published_at: string;
};

export type PickStatus = "showing" | "past" | "book_not_live";

// What the admin list says about each pick (rows newest first). Only a
// pick whose book Libraria lists can show; the newest of those is on
// Libraria (lr4-1 a), the others are past picks, and one whose book is
// not listed hides until the book comes back (lr4-3 a).
export function pickStatuses(
  picks: readonly Pick<PickRow, "id" | "book_id">[],
  bookListed: (bookId: string) => boolean,
): Map<string, PickStatus> {
  const out = new Map<string, PickStatus>();
  let showing = false;
  for (const p of picks) {
    if (!bookListed(p.book_id)) out.set(p.id, "book_not_live");
    else if (!showing) {
      out.set(p.id, "showing");
      showing = true;
    } else out.set(p.id, "past");
  }
  return out;
}

export const PICK_STATUS_LABELS: Record<PickStatus, string> = {
  showing: "On Libraria now",
  past: "Past pick",
  book_not_live: "Book not live",
};

const MONTHS = [
  "Janar",
  "Shkurt",
  "Mars",
  "Prill",
  "Maj",
  "Qershor",
  "Korrik",
  "Gusht",
  "Shtator",
  "Tetor",
  "Nëntor",
  "Dhjetor",
];

// "Nëntor 2026": the month a pick was published, Tirana time (lr4-2 a).
export function pickMonthLabel(publishedAt: string): string {
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "numeric",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = Number(parts.find((p) => p.type === "month")?.value ?? "0");
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${year}` : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PickFormProblem =
  | "pick"
  | "book"
  | "badge_lines"
  | "badge_long"
  | "note_empty"
  | "note_lines"
  | "note_long"
  | "quote_empty"
  | "quote_lines"
  | "quote_long"
  | "quote_from";

export type ParsedPickForm =
  | {
      ok: true;
      pickId: string | null;
      bookId: string;
      badge: string | null;
      note: string;
      quote: string;
      quoteFrom: QuoteFrom;
    }
  | { ok: false; reason: PickFormProblem };

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

const length = (s: string) => [...s].length;

export function parsePickForm(formData: FormData): ParsedPickForm {
  const rawId = field(formData, "pickId").trim();
  const pickId = rawId === "" ? null : rawId;
  if (pickId !== null && !UUID.test(pickId)) return { ok: false, reason: "pick" };

  const bookId = field(formData, "bookId").trim();
  if (!UUID.test(bookId)) return { ok: false, reason: "book" };

  const badge = field(formData, "badge").trim();
  if (/[\r\n]/.test(badge)) return { ok: false, reason: "badge_lines" };
  if (length(badge) > MAX_PICK_BADGE) return { ok: false, reason: "badge_long" };

  const note = field(formData, "note").trim();
  if (note === "") return { ok: false, reason: "note_empty" };
  if (/[\r\n]/.test(note)) return { ok: false, reason: "note_lines" };
  if (length(note) > MAX_PICK_NOTE) return { ok: false, reason: "note_long" };

  const quote = field(formData, "quote").trim();
  if (quote === "") return { ok: false, reason: "quote_empty" };
  if (/[\r\n]/.test(quote)) return { ok: false, reason: "quote_lines" };
  if (length(quote) > MAX_PICK_QUOTE) return { ok: false, reason: "quote_long" };

  const quoteFrom = field(formData, "quoteFrom");
  if (quoteFrom !== "book" && quoteFrom !== "author") return { ok: false, reason: "quote_from" };

  return { ok: true, pickId, bookId, badge: badge === "" ? null : badge, note, quote, quoteFrom };
}
