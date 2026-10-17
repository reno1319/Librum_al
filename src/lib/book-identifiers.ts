// FIX1 (X9): the two optional book-detail checks the New Book wizard,
// the Edit page and createBook/updateBook all share, so the browser and
// the server can never disagree about what they accept. Pure: no
// imports, no environment, the clock passed in.

/** Fixed wording (Renato's W-B) for a filled ISBN that isn't one. */
export const INVALID_ISBN_MESSAGE = "Enter a valid ISBN-10 or ISBN-13, or leave it blank.";

/** Fixed wording (Renato's W-B) for an "Originally published" date after today. */
export const FUTURE_DATE_MESSAGE = "This date can't be in the future.";

/**
 * True for a real ISBN-10 or ISBN-13 (checksum verified; hyphens and
 * spaces allowed anywhere between characters). An ISBN-13 must also
 * carry the 978/979 book prefix, since any other valid EAN-13 is a
 * barcode, not an ISBN. Empty is NOT valid here -- callers treat an
 * empty field as "no ISBN" before asking.
 */
export function isValidIsbn(raw: string): boolean {
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();

  if (/^\d{9}[\dX]$/.test(compact)) {
    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      const value = compact[i] === "X" ? 10 : Number(compact[i]);
      sum += value * (10 - i);
    }
    return sum % 11 === 0;
  }

  if (/^97[89]\d{10}$/.test(compact)) {
    let sum = 0;
    for (let i = 0; i < 13; i += 1) {
      sum += Number(compact[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return sum % 10 === 0;
  }

  return false;
}

/**
 * True when a "YYYY-MM-DD" date is after today's UTC date -- the same
 * line createBook/updateBook's resolveOriginalPublicationDate draws
 * (midnight UTC of that date later than now), so a date the wizard
 * accepts is never one the server then refuses.
 */
export function isFutureDateString(raw: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  return raw > now.toISOString().slice(0, 10);
}
