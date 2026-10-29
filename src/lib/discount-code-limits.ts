// DISCOUNT-LIMIT-1: pure helpers for the two discount-code limits an
// author sets when creating a code -- how many times it may be used
// (`discount_codes.max_uses`) and the last day it works (`expires_at`).
//
// max_uses: null means no limit. Otherwise a whole number in the
// column's CHECK range (`discount_codes_max_uses_range_check`, 1 through
// 100,000). create_book_checkout_intent enforces it; this module only
// parses the form field.
//
// expires_at: the form sends a calendar date (YYYY-MM-DD) from a date
// input. It used to be stored as-is, which Postgres reads as midnight
// UTC at the START of that day -- so the code stopped at 01:00 (02:00
// in summer) Albania time on the very day the author picked. A picked
// date now means "works through the end of that day in Albania": the
// stored instant is the next day's midnight in Europe/Tirane, and the
// checkout's `expires_at > now()` stays true until then.
//
// No imports, so no network, database, provider or environment access.

/** Largest max_uses (the column's CHECK upper bound). */
export const MAXIMUM_DISCOUNT_MAX_USES = 100_000;

export const DISCOUNT_TIME_ZONE = "Europe/Tirane";

export type MaxUsesParseResult = { ok: true; maxUses: number | null } | { ok: false };

/**
 * Parses the optional "Max uses" form field. Blank or missing is no
 * limit; otherwise digits only (no sign, decimal point, exponent or
 * grouping), 1..100000.
 */
export function parseMaxUses(raw: FormDataEntryValue | null | undefined): MaxUsesParseResult {
  if (raw === null || raw === undefined) return { ok: true, maxUses: null };
  if (typeof raw !== "string") return { ok: false };
  const text = raw.trim();
  if (text === "") return { ok: true, maxUses: null };
  if (!/^\d{1,6}$/.test(text)) return { ok: false };
  const value = Number(text);
  if (value < 1 || value > MAXIMUM_DISCOUNT_MAX_USES) return { ok: false };
  return { ok: true, maxUses: value };
}

// Minutes east of UTC in Europe/Tirane at `at` (60 in winter, 120 in
// summer).
function tiraneOffsetMinutes(at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: DISCOUNT_TIME_ZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name ?? "");
  if (!match) throw new Error(`unexpected time zone offset ${name}`);
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * The instant a code with this expiry date stops working: midnight at
 * the start of the NEXT day in Albania, as an ISO string. Null for
 * anything that is not a real YYYY-MM-DD calendar date.
 */
export function discountExpiryInstant(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const picked = new Date(Date.UTC(year, month - 1, day));
  if (
    picked.getUTCFullYear() !== year ||
    picked.getUTCMonth() !== month - 1 ||
    picked.getUTCDate() !== day
  ) {
    return null;
  }
  const nextMidnightUtc = Date.UTC(year, month - 1, day + 1);
  // Albania's clocks change at 01:00 UTC, never near local midnight, so
  // the offset two hours before UTC midnight is the offset at local
  // midnight too.
  const offset = tiraneOffsetMinutes(new Date(nextMidnightUtc - 2 * 60 * 60 * 1000));
  return new Date(nextMidnightUtc - offset * 60 * 1000).toISOString();
}

/**
 * The last day a code works, for display: the Albania calendar date of
 * the moment just before it expires. A code stored by the old rule
 * (midnight UTC) shows the same day it always did.
 */
export function discountExpiryDisplayDate(expiresAt: string): string {
  // ALBANIAN-11: Albanian date ("28 tetor 2026").
  return new Date(new Date(expiresAt).getTime() - 1).toLocaleDateString("sq", {
    timeZone: DISCOUNT_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
