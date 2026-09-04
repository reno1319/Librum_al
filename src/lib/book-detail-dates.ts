// LIBRUM 2.0 PUBLISHING-UX-1 PART D: shared reader-facing date
// formatting for Book Detail's two new date rows -- "Originally
// published" (a date-only SQL `date` column) and "Published on Librum"
// (a real timestamptz, published_at). Both use the exact same
// year/month/day options this codebase's existing reader-facing date
// display already established (see src/app/(public)/account/purchases/
// page.tsx's "Purchased <date>" line), so this isn't a new formatting
// convention, just the smallest shared place to put it now that two
// call sites need it identically.
const READER_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

// A real instant (e.g. published_at) -- formatted as a plain date, no
// time-of-day, matching this page's existing date-display convention.
export function formatTimestampAsDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString(undefined, READER_DATE_OPTIONS);
}

// A date-only SQL `date` column (e.g. original_publication_date,
// "YYYY-MM-DD") -- deliberately NOT `new Date(dateOnly)` directly.
// That parses a bare "YYYY-MM-DD" string as UTC midnight, and
// .toLocaleDateString() then converts it to the server's local
// timezone -- in any negative UTC offset, that rolls the displayed day
// back by one (a real, classic date-only-field bug). Appending a
// timezone-less "T00:00:00" makes the Date constructor parse it as
// LOCAL midnight instead, so the parse and the format below both use
// the SAME timezone reference and can never disagree, regardless of
// what timezone this code happens to run in.
export function formatDateOnly(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00`).toLocaleDateString(undefined, READER_DATE_OPTIONS);
}
