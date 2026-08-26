import { getPublishChecklist, type ChecklistItem } from "@/lib/publish-checklist";
import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-7: the Publishing Studio's readiness classification,
// extracted as a pure function -- same "extract a pure decision
// function, unit-test it directly" pattern already used by
// resolveHomepageCta(), parseBookstoreQuery(), resolveBookPurchaseState(),
// and resolveDashboardAttention(). This exists specifically to keep
// "required" and "recommended" from ever being blurred together in the
// UI: publishBook()'s only real hard gate (a paid book without payouts
// enabled) is NOT part of getPublishChecklist() at all -- that
// function's own docstring says its 5 items are "purely informational,
// never blocks publishing." Cover and price are deliberately excluded
// from the recommended list below: every book that can exist already
// has a cover (createBook requires one, and there's no remove-cover
// path), and $0/Free is a fully legitimate, intentional price, not an
// incomplete one.
export type PublishReadiness = {
  requiredMet: boolean;
  payoutBlocked: boolean;
  recommended: ChecklistItem[];
};

const RECOMMENDED_LABELS = new Set([
  "Write a description (a couple of sentences or more)",
  "Add keywords so readers can find it by search",
  'Add a "Look inside" preview excerpt',
]);

type ReadinessBook = Pick<
  Book,
  "description" | "keywords" | "preview_text" | "price_cents" | "cover_path"
>;

export function resolvePublishReadiness(params: {
  book: ReadinessBook;
  payoutsEnabled: boolean;
}): PublishReadiness {
  const { book, payoutsEnabled } = params;

  // Mirrors publishBook()'s own real gate exactly (books/actions.ts):
  // a free book, or a paid book with payouts already enabled, has no
  // required blocker at all.
  const payoutBlocked = book.price_cents > 0 && !payoutsEnabled;

  const recommended = getPublishChecklist(book).filter((item) =>
    RECOMMENDED_LABELS.has(item.label),
  );

  return {
    requiredMet: !payoutBlocked,
    payoutBlocked,
    recommended,
  };
}
