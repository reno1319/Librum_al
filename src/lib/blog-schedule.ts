// Blog scheduling and pin helpers (Renato 2026-11-19, e3/e4).
//
// A scheduled article is a published row whose published_at is still
// in the future (migration 20261119130000_blog_pin_schedule.sql):
// readers' RLS policy and search only ever return rows whose time has
// passed, and every public query also asks for published_at <= now so
// a signed-in staff member browsing /blog never sees one early.
//
// Times are picked and shown in Tirana time (Europe/Tirane), whatever
// time zone the server or browser runs in.
import { TIRANA_TIME_ZONE } from "./book-detail-dates";

export type BlogPublishState = "draft" | "scheduled" | "published";

export function blogPublishState(
  post: { status: string; published_at: string | null },
  now: Date = new Date(),
): BlogPublishState {
  if (post.status !== "published") return "draft";
  if (post.published_at && new Date(post.published_at).getTime() > now.getTime()) return "scheduled";
  return "published";
}

// A draft can be scheduled only if it has never been live (the DB
// refuses otherwise; a once-live draft just gets "Publish").
export function canBeScheduled(post: { status: string; published_at: string | null }, now: Date = new Date()): boolean {
  const state = blogPublishState(post, now);
  return (state === "draft" && post.published_at === null) || state === "scheduled";
}

// The current time as an ISO string, for `.lte("published_at", ...)`.
export function blogNowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function tiranaParts(instant: Date): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIRANA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const out: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

// "2026-11-21" + "09:00" in Tirana -> the real instant, or null when the
// text is not a real date/time or that wall time does not exist (the
// spring-forward hour).
export function tiranaLocalToInstant(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const wallAsUtc = Date.UTC(y, mo - 1, da, h, mi);
  // Tirana is UTC+1 or UTC+2; try both offsets and keep the one whose
  // Tirana wall clock matches what was asked for.
  for (const offsetHours of [1, 2]) {
    const candidate = new Date(wallAsUtc - offsetHours * 3_600_000);
    const p = tiranaParts(candidate);
    if (p.year === y && p.month === mo && p.day === da && p.hour === h && p.minute === mi) return candidate;
  }
  return null;
}

// An instant -> the Tirana date and time for the form's inputs.
export function instantToTiranaInputs(iso: string): { date: string; time: string } {
  const p = tiranaParts(new Date(iso));
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

// "Nov 21, 2026, 09:00" in Tirana time (the admin pages are English).
export function formatTiranaDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIRANA_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
