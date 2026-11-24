// G4 (Renato 11-24): failed pre-order reader emails, as Owner and Admin
// see them on the admin Today page (g4q2 a, g4q6 a). Pure and
// client-safe: the rows come from staff_list_preorder_email_failures()
// (migration 20261124180000), read defensively, and the lines are built
// here in English like the rest of /admin.

export type PreorderEmailFailure = "address_refused" | "unclear" | "batch_refused";
export type PreorderEmailKind = "released" | "cancelled";

export type PreorderEmailFailureRow = {
  bookId: string;
  userId: string;
  bookTitle: string;
  readerName: string | null;
  emailKind: PreorderEmailKind;
  failure: PreorderEmailFailure;
  failedAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURES: readonly string[] = ["address_refused", "unclear", "batch_refused"];

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The function's rows; a malformed row is dropped, never trusted. */
export function parsePreorderEmailFailureRows(data: unknown): PreorderEmailFailureRow[] {
  if (!Array.isArray(data)) return [];
  const rows: PreorderEmailFailureRow[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (!isUuid(r.book_id) || !isUuid(r.user_id) || typeof r.book_title !== "string") continue;
    if (r.reader_name !== null && typeof r.reader_name !== "string") continue;
    if (r.email_kind !== "released" && r.email_kind !== "cancelled") continue;
    if (typeof r.send_failure !== "string" || !FAILURES.includes(r.send_failure)) continue;
    if (typeof r.send_failed_at !== "string" || Number.isNaN(Date.parse(r.send_failed_at))) continue;
    rows.push({
      bookId: r.book_id,
      userId: r.user_id,
      bookTitle: r.book_title,
      readerName: r.reader_name,
      emailKind: r.email_kind,
      failure: r.send_failure as PreorderEmailFailure,
      failedAt: r.send_failed_at,
    });
  }
  return rows;
}

export const FAILED_EMAILS_HEADING = "Failed pre-order emails";
export const FAILED_EMAILS_INTRO =
  "These readers may not know that their pre-ordered book came out or was cancelled. Send the email again, or write to the reader yourself and mark it handled.";
export const FAILED_EMAILS_LOAD_ERROR = "Couldn’t load the failed pre-order emails. Reload the page to try again.";
export const SEND_AGAIN_BUTTON = "Send again";
export const MARK_HANDLED_BUTTON = "Mark handled";

// Shown on /admin through ?error= (listed in src/lib/page-messages.ts).
export const FAILED_EMAIL_GONE_MESSAGE = "That failed pre-order email was already handled.";
export const FAILED_EMAIL_ERROR_MESSAGE = "Couldn’t update that failed pre-order email. Reload the page and try again.";

/** “Title”: the “book is out” email to */
export function failureLineStart(row: PreorderEmailFailureRow): string {
  const which = row.emailKind === "released" ? "“book is out”" : "“pre-order cancelled”";
  return `“${row.bookTitle}”: the ${which} email to`;
}

export function failureReaderName(row: PreorderEmailFailureRow): string {
  return row.readerName && row.readerName.trim() !== "" ? row.readerName : "a reader";
}

export function failureReason(failure: PreorderEmailFailure): string {
  switch (failure) {
    case "address_refused":
      return "Resend refused this address. It won’t be tried again.";
    case "unclear":
      return "Unclear answer from Resend: it may have arrived. It won’t be tried again.";
    case "batch_refused":
      return "Resend refused the whole batch. Librum tries again tomorrow morning.";
  }
}
