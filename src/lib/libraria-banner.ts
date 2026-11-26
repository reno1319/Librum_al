// LR1 patch 3 (Renato 2026-11-25): the banner slides at the top of
// Libraria. Pure rules shared by the admin form, its action and the page.
// The database checks the same limits again (migration
// 20261125200000_libraria_banner_slides.sql).

// lr3-7 a: at most 6 slides show on any one day.
export const MAX_SHOWING_SLIDES = 6;
// One line on the slide (my call, shown in the pictures).
export const MAX_SLIDE_DESCRIPTION = 120;
// lr3-2b a: optional, so it fits on a phone.
export const MAX_SLIDE_TAG = 24;
// lr3-3 a: slides change by themselves every 6 seconds.
export const SLIDE_ROTATE_MS = 6000;
// Pictures: JPG or PNG under 5 MB, stored as a shrunk JPEG.
export const MAX_SLIDE_PICTURE_BYTES = 5 * 1024 * 1024;
export const SLIDE_PICTURE_SIZE = { width: 2400 } as const;
export const SLIDE_PHONE_PICTURE_SIZE = { width: 1200 } as const;

// Banner two-pictures fix (Renato 2026-11-26): the browser sends each
// picture straight to Storage, never through the save, because Vercel
// refuses a request over about 4.5 MB (a wide and a phone picture
// together are often more). Like the blog cover, the file waits in the
// private "manuscripts" bucket under the staff member's own
// "<uid>/tmp/libraria/<uuid>.<jpg|png>"; the save gets only that name,
// checks the bytes itself, stores the shrunk JPEG in "libraria" and
// removes the waiting file.
export const SLIDE_STAGING_BUCKET = "manuscripts";
const UUID_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STAGED_SLIDE_FILE = new RegExp(`^${UUID_BODY}\\.(?:jpg|png)$`);
const UUID_ONLY = new RegExp(`^${UUID_BODY}$`);

export function stagedSlidePicturePath(userId: string, fileId: string, extension: "jpg" | "png"): string {
  return `${userId}/tmp/libraria/${fileId}.${extension}`;
}

// Only that exact shape under the caller's own id.
export function isOwnStagedSlidePicturePath(path: unknown, userId: unknown): path is string {
  if (typeof path !== "string" || typeof userId !== "string" || !UUID_ONLY.test(userId)) return false;
  const prefix = `${userId}/tmp/libraria/`;
  return path.startsWith(prefix) && STAGED_SLIDE_FILE.test(path.slice(prefix.length));
}

export type SlideRow = {
  id: string;
  position: number;
  book_id: string;
  description: string;
  tag: string | null;
  image_path: string;
  phone_image_path: string | null;
  starts_on: string | null;
  ends_on: string | null;
};

export type SlideStatus = "showing" | "waiting" | "ended" | "book_not_live";

// Today's date in Tirana as YYYY-MM-DD (the database's own rule).
export function tiranaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// What the admin list says about a slide. A slide whose book is not on
// Libraria now hides by itself and comes back with the book (lr3-5 a).
export function slideStatus(
  slide: Pick<SlideRow, "starts_on" | "ends_on">,
  bookListed: boolean,
  today: string,
): SlideStatus {
  if (slide.ends_on && slide.ends_on < today) return "ended";
  if (!bookListed) return "book_not_live";
  if (slide.starts_on && slide.starts_on > today) return "waiting";
  return "showing";
}

export const SLIDE_STATUS_LABELS: Record<SlideStatus, string> = {
  showing: "Showing",
  waiting: "Waiting for its first day",
  ended: "Ended",
  book_not_live: "Book not live",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type ParsedSlideForm =
  | {
      ok: true;
      slideId: string | null;
      bookId: string;
      description: string;
      tag: string | null;
      startsOn: string | null;
      endsOn: string | null;
      removePhonePicture: boolean;
    }
  | { ok: false; reason: SlideFormProblem };

export type SlideFormProblem =
  | "slide"
  | "book"
  | "description_empty"
  | "description_lines"
  | "description_long"
  | "tag_lines"
  | "tag_long"
  | "days"
  | "days_order";

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

function validDay(v: string): boolean {
  if (!DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// The text parts of the slide form; the pictures are checked by the
// action, which turns each problem into its staff-facing message.
export function parseSlideForm(formData: FormData): ParsedSlideForm {
  const rawId = field(formData, "slideId").trim();
  const slideId = rawId === "" ? null : rawId;
  if (slideId !== null && !UUID.test(slideId)) return { ok: false, reason: "slide" };

  const bookId = field(formData, "bookId").trim();
  if (!UUID.test(bookId)) return { ok: false, reason: "book" };

  const description = field(formData, "description").trim();
  if (description === "") return { ok: false, reason: "description_empty" };
  if (/[\r\n]/.test(description)) return { ok: false, reason: "description_lines" };
  if ([...description].length > MAX_SLIDE_DESCRIPTION) {
    return { ok: false, reason: "description_long" };
  }

  const rawTag = field(formData, "tag").trim();
  if (/[\r\n]/.test(rawTag)) return { ok: false, reason: "tag_lines" };
  if ([...rawTag].length > MAX_SLIDE_TAG) return { ok: false, reason: "tag_long" };

  const startsOn = field(formData, "startsOn").trim() || null;
  const endsOn = field(formData, "endsOn").trim() || null;
  if ((startsOn && !validDay(startsOn)) || (endsOn && !validDay(endsOn))) {
    return { ok: false, reason: "days" };
  }
  if (startsOn && endsOn && endsOn < startsOn) return { ok: false, reason: "days_order" };

  return {
    ok: true,
    slideId,
    bookId,
    description,
    tag: rawTag === "" ? null : rawTag,
    startsOn,
    endsOn,
    removePhonePicture: formData.get("removePhonePicture") === "on",
  };
}

// The picture paths the database accepts: slides/<uuid>.jpg.
export function isSlidePicturePath(path: string): boolean {
  return /^slides\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/.test(path);
}

// The days, as the admin list shows them.
export function slideDaysLabel(slide: Pick<SlideRow, "starts_on" | "ends_on">): string {
  if (!slide.starts_on && !slide.ends_on) return "Every day";
  if (slide.starts_on && slide.ends_on) return `${slide.starts_on} to ${slide.ends_on}`;
  if (slide.starts_on) return `From ${slide.starts_on}`;
  return `Until ${slide.ends_on}`;
}
