import type { createClient } from "@/lib/supabase/server";
import type { createAdminClient } from "@/lib/supabase/admin";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import {
  FREE_ACQUISITION_LABEL,
  formatTransactionAmount,
  provenanceFromStoredCurrency,
} from "@/lib/transaction-money";

// DOWNLOADS-1 (pipeline item 3, Renato 10-24): the download log and the
// 14-day cancel rule. The database decides both
// (migration 20261024090000_book_downloads.sql): record_book_download()
// writes a row each time a buyer is handed a file, and
// purchase_download_states() says, per purchase, whether the cancel
// window is still open. Nothing here re-derives the rule; this file only
// reads those answers and turns them into the lines people see.
//
// 1a: the download route records the row BEFORE it sends the file and
// sends nothing when the row can't be written. 3a: buyers see their own
// "Downloaded" line, staff see the full state, authors see nothing.
// 4a: while the window is open the buyer sees one warning line next to
// the Download button. 5: no cancel flow until POK is live -- the admin
// box only shows the state.

type SessionClient = Awaited<ReturnType<typeof createClient>>;
type ServiceClient = ReturnType<typeof createAdminClient>;

export const DOWNLOAD_CANCEL_WARNING = "Downloading ends your right to cancel this purchase.";

// --------------------------------------------------------------
// The buyer's own states (my_purchase_download_states)
// --------------------------------------------------------------

export type MyDownloadState = {
  firstDownloadedAt: string | null;
  cancelOpenUntil: string | null;
};

// Rows that are not exactly the shape the function returns are dropped.
export function parseMyDownloadStates(data: unknown): Map<string, MyDownloadState> {
  const states = new Map<string, MyDownloadState>();
  if (!Array.isArray(data)) return states;
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.book_id !== "string") continue;
    const first = row.first_downloaded_at;
    const until = row.cancel_open_until;
    if ((first !== null && typeof first !== "string") || (until !== null && typeof until !== "string")) continue;
    states.set(row.book_id, { firstDownloadedAt: first, cancelOpenUntil: until });
  }
  return states;
}

// A failed read shows no line at all (never a wrong "Downloaded" or a
// missing warning presented as fact); the download itself still works,
// and the route records it either way.
export async function readMyDownloadStates(supabase: SessionClient): Promise<Map<string, MyDownloadState>> {
  const { data, error } = await supabase.rpc("my_purchase_download_states");
  if (error) {
    console.error("book downloads: the buyer's download state read failed", { code: error.code ?? null });
    return new Map();
  }
  return parseMyDownloadStates(data);
}

// The one line under a buyer's Download button, or null.
export function buyerDownloadNote(state: MyDownloadState | undefined, now: Date = new Date()): string | null {
  if (!state) return null;
  if (state.cancelOpenUntil && Date.parse(state.cancelOpenUntil) > now.getTime()) {
    return DOWNLOAD_CANCEL_WARNING;
  }
  if (state.firstDownloadedAt) {
    return `Downloaded ${formatTimestampAsDate(state.firstDownloadedAt)}`;
  }
  return null;
}

// --------------------------------------------------------------
// One account's purchases, for staff (purchase_download_states)
// --------------------------------------------------------------

export type PurchaseDownloadState = {
  purchaseId: string;
  bookId: string;
  paymentId: string | null;
  amountMinor: number;
  currency: string | null;
  boughtAt: string;
  refundedAt: string | null;
  downloadCount: number;
  firstDownloadedAt: string | null;
  lastDownloadedAt: string | null;
  paymentFirstDownloadedAt: string | null;
  cancelOpenUntil: string | null;
};

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

export function parsePurchaseDownloadStates(data: unknown): PurchaseDownloadState[] | null {
  if (!Array.isArray(data)) return null;
  const rows: PurchaseDownloadState[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    const paymentId = nullableString(row.payment_id);
    const currency = nullableString(row.currency);
    const refundedAt = nullableString(row.refunded_at);
    const first = nullableString(row.first_downloaded_at);
    const last = nullableString(row.last_downloaded_at);
    const paymentFirst = nullableString(row.payment_first_downloaded_at);
    const until = nullableString(row.cancel_open_until);
    if (
      typeof row.purchase_id !== "string" ||
      typeof row.book_id !== "string" ||
      typeof row.amount_minor !== "number" ||
      typeof row.bought_at !== "string" ||
      typeof row.download_count !== "number" ||
      paymentId === undefined ||
      currency === undefined ||
      refundedAt === undefined ||
      first === undefined ||
      last === undefined ||
      paymentFirst === undefined ||
      until === undefined
    ) {
      return null;
    }
    rows.push({
      purchaseId: row.purchase_id,
      bookId: row.book_id,
      paymentId,
      amountMinor: row.amount_minor,
      currency,
      boughtAt: row.bought_at,
      refundedAt,
      downloadCount: row.download_count,
      firstDownloadedAt: first,
      lastDownloadedAt: last,
      paymentFirstDownloadedAt: paymentFirst,
      cancelOpenUntil: until,
    });
  }
  return rows.sort((a, b) => (a.boughtAt < b.boughtAt ? 1 : a.boughtAt > b.boughtAt ? -1 : 0));
}

// Only after requireStaff("people.view"): the function is service-role
// only and takes the account id.
export async function readPurchaseDownloadStates(
  admin: ServiceClient,
  userId: string,
): Promise<PurchaseDownloadState[] | null> {
  const { data, error } = await admin.rpc("purchase_download_states", { p_reader_id: userId });
  if (error) {
    console.error("book downloads: the purchase download state read failed", { code: error.code ?? null });
    return null;
  }
  const rows = parsePurchaseDownloadStates(data);
  if (!rows) console.error("book downloads: unexpected purchase download state rows");
  return rows;
}

// Download times are evidence, so staff see the time as well as the
// day, always in Albania's time zone.
export function formatDownloadTime(timestamp: string): string {
  return `${new Date(timestamp).toLocaleString("en-GB", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })} (Tirana time)`;
}

// The cancel line staff see for one purchase.
export function staffCancelLabel(row: PurchaseDownloadState, now: Date = new Date()): string {
  if (row.refundedAt) return "Refunded";
  if (!row.paymentId) return "Free or older order: no 14-day cancel";
  if (row.cancelOpenUntil && Date.parse(row.cancelOpenUntil) > now.getTime()) {
    return `Can cancel until ${formatDownloadTime(row.cancelOpenUntil)}`;
  }
  if (row.firstDownloadedAt) return "Can't cancel: downloaded";
  if (row.paymentFirstDownloadedAt) return "Can't cancel: another book in the same order was downloaded";
  return "Can't cancel: more than 14 days, or the payment isn't complete";
}

export function staffDownloadLabel(row: PurchaseDownloadState): string {
  if (!row.firstDownloadedAt || row.downloadCount === 0) return "Not downloaded";
  const first = `First downloaded ${formatDownloadTime(row.firstDownloadedAt)}`;
  if (row.downloadCount === 1 || !row.lastDownloadedAt) return first;
  return `${first}; ${row.downloadCount} downloads, last ${formatDownloadTime(row.lastDownloadedAt)}`;
}

// A purchase with no payment and a zero amount is a free download; any
// other row without a currency shows the shared "unavailable" label.
export function staffAmountLabel(row: PurchaseDownloadState): string {
  if (!row.paymentId && row.amountMinor === 0) return FREE_ACQUISITION_LABEL;
  return formatTransactionAmount(row.amountMinor, provenanceFromStoredCurrency(row.currency));
}
