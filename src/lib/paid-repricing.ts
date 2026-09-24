import { resolveCatalogPriceState } from "@/lib/catalog-price";

// PAID-REPRICING-1: the ONE rule deciding whether an author's price
// update on an existing book or bundle needs paid-publishing permission.
// updateBook (dashboard/books/actions.ts) and updateBundle
// (dashboard/bundles/actions.ts) both call it, so the two catalog rows
// cannot drift into two interpretations of "is this a paid publication".
//
// Why it exists: performPublish/performBundlePublish gate the
// draft -> published transition of a paid title on canPublishPaidTitle().
// An edit of an ALREADY-published row never passed through either of
// them, so a published free (or unpriced) title could become paid, and a
// published paid title could change its paid price, while paid
// publishing was closed. Both are paid publications in everything but
// name: a reader is shown a new amount they could be asked to pay.
//
// Pure by design: no environment read, no Supabase call. The caller owns
// the capability check (canPublishPaidTitle, server-only) and the
// server-read row. Only `price_all` is ever consulted -- `price_cents` is
// legacy USD minor units and decides nothing here.
//
// The table the rule implements, while paid publishing is closed:
//
//   current row           submitted       result
//   published, null      paid            permission required (deny)
//   published, free      paid            permission required (deny)
//   published, paid      other paid      permission required (deny)
//   published, paid      same paid       allowed; the write is guarded
//   published, any       free            allowed
//   draft, any           paid            allowed; the write is guarded
//                                         (publication stays gated)
//
// "draft" is the ONLY status that lets a paid price be saved without
// permission. Any other status value is treated as published, so an
// unexpected status fails closed rather than open.

export type PriceUpdateAuthorization =
  // The submitted price is free. Lowering a price to free never needs
  // paid-publishing permission, whatever the row's state.
  | { kind: "free_price" }
  // A paid price on a draft. Allowed, but only while the row is STILL a
  // draft when the write lands -- see catalogRowGuard.
  | { kind: "paid_price_on_draft" }
  // A published row keeps exactly the paid price it already has, so
  // metadata can be edited. Allowed, but only while the row is still in
  // that exact published/price state when the write lands.
  | { kind: "unchanged_paid_price" }
  // A published row would become paid, or change its paid price.
  | { kind: "paid_publishing_permission_required" };

export function resolvePriceUpdateAuthorization(params: {
  currentStatus: string;
  currentPriceAll: unknown;
  submittedPriceAll: number;
}): PriceUpdateAuthorization {
  const { currentStatus, currentPriceAll, submittedPriceAll } = params;
  const submitted = resolveCatalogPriceState(submittedPriceAll);

  // The caller has already parsed the price; an invalid value never
  // reaches here. If one ever does, it is treated as needing permission
  // rather than as free.
  if (submitted === "free") return { kind: "free_price" };
  if (submitted !== "paid") return { kind: "paid_publishing_permission_required" };

  if (currentStatus === "draft") return { kind: "paid_price_on_draft" };

  if (
    resolveCatalogPriceState(currentPriceAll) === "paid" &&
    currentPriceAll === submittedPriceAll
  ) {
    return { kind: "unchanged_paid_price" };
  }

  return { kind: "paid_publishing_permission_required" };
}

// The row state a guarded write must still find when it lands. `status`
// and `priceAll` are each optional: a key that is absent is not a
// condition. `priceAll: null` is a real condition ("the row is still
// unpriced"), not an absent one -- see applyCatalogRowGuard.
export type CatalogRowGuard = {
  status?: string;
  priceAll?: number | null;
};

// Which row state the price-update write must be conditioned on, given
// the authorization above. `null` means no condition beyond ownership.
//
// - free_price: none. Setting a price to free is permitted from every
//   state, so no concurrent change can make it unauthorized.
// - paid_price_on_draft: the row must still be a draft. If a concurrent
//   publish landed first, this stale write matches no row, so it can no
//   longer turn a just-published free title paid.
// - unchanged_paid_price: the row must still be in the exact status and
//   price that was read. If a concurrent edit made it free first, this
//   stale write cannot put the old paid price back on a published row.
// - paid_publishing_permission_required: only reached once the caller
//   has confirmed permission, at which point the transition is allowed
//   outright; no condition.
export function catalogRowGuard(
  authorization: PriceUpdateAuthorization,
  current: { status: string; priceAll: number | null },
): CatalogRowGuard | null {
  switch (authorization.kind) {
    case "free_price":
      return null;
    case "paid_price_on_draft":
      return { status: "draft" };
    case "unchanged_paid_price":
      return { status: current.status, priceAll: current.priceAll };
    case "paid_publishing_permission_required":
      return null;
  }
}

// The minimal query-builder surface a guard needs. supabase-js filter
// builders satisfy it; so does a test double.
type GuardableQuery<Q> = {
  eq(column: string, value: string | number): Q;
  is(column: string, value: null): Q;
};

// Adds a guard's conditions to an UPDATE query. SQL `price_all = NULL`
// is never true, so an unpriced condition must be `price_all IS NULL`
// (PostgREST `is.null`), never `.eq("price_all", null)`.
export function applyCatalogRowGuard<Q extends GuardableQuery<Q>>(
  query: Q,
  guard: CatalogRowGuard | null,
): Q {
  if (!guard) return query;
  let guarded = query;
  if (guard.status !== undefined) guarded = guarded.eq("status", guard.status);
  if (guard.priceAll !== undefined) {
    guarded =
      guard.priceAll === null ? guarded.is("price_all", null) : guarded.eq("price_all", guard.priceAll);
  }
  return guarded;
}

// A guarded write proves itself only by the rows it returns. The caller
// must request them (`.select("id")`); a successful response with zero
// rows means the guard or ownership filter matched nothing, which is a
// failure to report, never a success to assume.
export function isExactlyOneRowWritten(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length === 1;
}

// Author-facing refusal for a denied price update. Names no environment
// variable, deployment or provider, the same rule publishBook's
// "Paid publishing isn't available right now" follows, and tells the
// author which edits remain open to them.
export const PAID_REPRICING_UNAVAILABLE_MESSAGE =
  "Paid publishing isn't available right now, so a published title can't get a new paid price. " +
  "You can keep its current price or make it free.";

// Author-facing message for a guarded write that matched no row: the row
// changed between the read and the write (for example it was published
// in the meantime), so nothing was saved.
export const CATALOG_ROW_CHANGED_MESSAGE =
  "This title changed while you were editing it, so nothing was saved. Reload the page and try again.";
