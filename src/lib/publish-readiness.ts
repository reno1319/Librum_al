import { resolveCatalogPriceState } from "@/lib/catalog-price";
import { getPublishChecklist, type ChecklistItem } from "@/lib/publish-checklist";
import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-7: the Publishing Studio's readiness classification,
// extracted as a pure function -- same "extract a pure decision
// function, unit-test it directly" pattern already used by
// resolveHomepageCta(), parseBookstoreQuery(), resolveBookPurchaseState(),
// and resolveDashboardAttention(). This exists specifically to keep
// "required" and "recommended" from ever being blurred together in the
// UI: publishBook()'s only real hard gate (a paid book while paid
// publishing is unavailable) is NOT part of getPublishChecklist() at
// all -- that function's own docstring says its 5 items are "purely
// informational, never blocks publishing." Cover and price are
// deliberately excluded from the recommended list below: every book
// that can exist already has a cover (createBook requires one, and
// there's no remove-cover path), and a free price is a fully
// legitimate, intentional price, not an incomplete one.
//
// PR-G: `paidPublishingBlocked` is provider-neutral on purpose. It was
// `payoutBlocked` and was fed by profiles.stripe_payouts_enabled; that
// Stripe Connect prerequisite is gone from performPublish(), and the
// input is now canPublishPaidTitle(). The state itself survives the
// rename because the question it answers survives: an author with a
// priced draft still needs to be told, before they press Publish,
// whether this draft can go live.
//
// `requiredMet` was removed here, not renamed: it had no production
// consumer and was exactly `!payoutBlocked`.
//
// ALL-WIRING-2: `missingAllPrice` is a SECOND, distinct hard blocker,
// not a rewording of the first. `price_all is null` and "a paid title
// while paid publishing is closed" fail publishing for unrelated
// reasons and have opposite remedies: the author can fix the first
// themselves in one edit, and can do nothing at all about the second.
// Collapsing them into one flag would tell an author with an unpriced
// draft that Librum is the obstacle, which is false.
export type PublishReadiness = {
  missingAllPrice: boolean;
  paidPublishingBlocked: boolean;
  recommended: ChecklistItem[];
};

// LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: the former "Look inside"
// preview-excerpt label is gone from this set, not merely renamed --
// see getPublishChecklist()'s own comment for why that item was removed
// entirely rather than relabeled.
const RECOMMENDED_LABELS = new Set([
  "Write a description (a couple of sentences or more)",
  "Add keywords so readers can find it by search",
]);

type ReadinessBook = Pick<Book, "description" | "keywords" | "price_all" | "cover_path">;

export function resolvePublishReadiness(params: {
  book: ReadinessBook;
  paidPublishingAvailable: boolean;
}): PublishReadiness {
  const { book, paidPublishingAvailable } = params;

  // Mirrors performPublish()'s own real gate exactly (books/actions.ts),
  // including its ORDER: the missing-price refusal is decided first and
  // independently, and only a title that is actually PAID is ever
  // measured against paid-publishing availability. A book with no ALL
  // price is not "a paid book", so it never reports paidPublishingBlocked
  // -- reporting both at once would offer two explanations for one
  // refusal. The caller supplies paidPublishingAvailable -- this module
  // stays pure and is never allowed to read the environment.
  const priceState = resolveCatalogPriceState(book.price_all);
  const missingAllPrice = priceState === "unavailable";
  const paidPublishingBlocked = priceState === "paid" && !paidPublishingAvailable;

  const recommended = getPublishChecklist(book).filter((item) =>
    RECOMMENDED_LABELS.has(item.label),
  );

  return {
    missingAllPrice,
    paidPublishingBlocked,
    recommended,
  };
}
