// G4 batch 3 (Renato g4q11 a, b3e1 a, b3e2 a): "Approve selected" on
// Reader reviews and "Mark selected done" on Feedback. One tap acts at
// once on every ticked item; each item is saved on its own, so when
// some fail the rest still go through, and the page says how many
// worked and why the others did not (they stay in the list). The
// outcome travels back as digits only (?bulk=4.1.0.0.0), never as
// free text, and the page builds the sentences itself.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most items one bulk action handles. */
export const BULK_MAX = 200;

export const BULK_PICK_FIELD = "pick";

export type ReviewPick = { reviewId: string; seen: string; bookId: string };

function isSeen(value: string): boolean {
  return value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

/** "<review id>|<updated_at seen>|<book id>" per ticked review. Null = a bad form. */
export function parseReviewPicks(values: readonly unknown[]): ReviewPick[] | null {
  if (values.length === 0 || values.length > BULK_MAX) return null;
  const byId = new Map<string, ReviewPick>();
  for (const value of values) {
    if (typeof value !== "string") return null;
    const parts = value.split("|");
    if (parts.length !== 3) return null;
    const [reviewId, seen, bookId] = parts;
    if (!UUID.test(reviewId) || !UUID.test(bookId) || !isSeen(seen)) return null;
    if (!byId.has(reviewId)) byId.set(reviewId, { reviewId, seen, bookId });
  }
  return [...byId.values()];
}

/** One feedback id per ticked message. Null = a bad form. */
export function parseFeedbackPicks(values: readonly unknown[]): string[] | null {
  if (values.length === 0 || values.length > BULK_MAX) return null;
  const ids = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !UUID.test(value)) return null;
    ids.add(value);
  }
  return [...ids];
}

export type ReviewBulkCounts = { approved: number; changed: number; own: number; gone: number; failed: number };
export type FeedbackBulkCounts = { done: number; gone: number; failed: number };

export function emptyReviewBulkCounts(): ReviewBulkCounts {
  return { approved: 0, changed: 0, own: 0, gone: 0, failed: 0 };
}

/** Adds one staff_approve_reader_review answer (or a call error) to the tally. */
export function tallyReviewResult(counts: ReviewBulkCounts, result: unknown, callFailed: boolean): void {
  if (callFailed) counts.failed += 1;
  else if (result === "approved") counts.approved += 1;
  else if (result === "changed") counts.changed += 1;
  else if (result === "own_review") counts.own += 1;
  else if (result === "not_found") counts.gone += 1;
  else counts.failed += 1;
}

export function encodeReviewBulk(c: ReviewBulkCounts): string {
  return [c.approved, c.changed, c.own, c.gone, c.failed].join(".");
}

export function encodeFeedbackBulk(c: FeedbackBulkCounts): string {
  return [c.done, c.gone, c.failed].join(".");
}

function digits(raw: unknown, parts: number): number[] | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  if (!new RegExp(`^\\d{1,3}(\\.\\d{1,3}){${parts - 1}}$`).test(value)) return null;
  const numbers = value.split(".").map((n) => Number.parseInt(n, 10));
  if (numbers.reduce((a, b) => a + b, 0) > BULK_MAX) return null;
  return numbers;
}

export function parseReviewBulk(raw: unknown): ReviewBulkCounts | null {
  const n = digits(raw, 5);
  return n ? { approved: n[0], changed: n[1], own: n[2], gone: n[3], failed: n[4] } : null;
}

export function parseFeedbackBulk(raw: unknown): FeedbackBulkCounts | null {
  const n = digits(raw, 3);
  return n ? { done: n[0], gone: n[1], failed: n[2] } : null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The green line and the red line after "Approve selected". */
export function reviewBulkLines(c: ReviewBulkCounts): { success: string | null; error: string | null } {
  const success = c.approved > 0 ? `${c.approved} ${plural(c.approved, "review", "reviews")} approved.` : null;
  const errors: string[] = [];
  if (c.changed > 0)
    errors.push(
      `${c.changed} not approved: the reader changed ${plural(c.changed, "it", "them")} after you opened the page, or ${plural(c.changed, "it was", "they were")} already decided. Read ${plural(c.changed, "it", "them")} again; ${plural(c.changed, "it stays", "they stay")} in the list.`,
    );
  if (c.own > 0) errors.push(`${c.own} not approved: your own review. Another staff member has to approve it.`);
  if (c.gone > 0) errors.push(`${c.gone} not approved: the review no longer exists.`);
  if (c.failed > 0)
    errors.push(
      `${c.failed} not approved: something went wrong. ${plural(c.failed, "It stays", "They stay")} in the list; try again.`,
    );
  return { success, error: errors.length > 0 ? errors.join(" ") : null };
}

/** The green line and the red line after "Mark selected done". */
export function feedbackBulkLines(c: FeedbackBulkCounts): { success: string | null; error: string | null } {
  const success = c.done > 0 ? `${c.done} ${plural(c.done, "message", "messages")} marked done.` : null;
  const errors: string[] = [];
  if (c.gone > 0) errors.push(`${c.gone} not marked done: the message no longer exists.`);
  if (c.failed > 0)
    errors.push(
      `${c.failed} not marked done: something went wrong. ${plural(c.failed, "It stays", "They stay")} in Open; try again.`,
    );
  return { success, error: errors.length > 0 ? errors.join(" ") : null };
}
