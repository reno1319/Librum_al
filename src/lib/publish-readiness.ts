import { getPublishChecklist, type ChecklistItem } from "@/lib/publish-checklist";
import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-7: the Publishing Studio's readiness classification,
// extracted as a pure function -- same "extract a pure decision
// function, unit-test it directly" pattern already used by
// resolveHomepageCta(), parseBookstoreQuery(), resolveBookPurchaseState(),
// and resolveDashboardAttention(). This exists specifically to keep
// "required" and "recommended" from ever being blurred together in the
// UI: getPublishChecklist()'s items never block publishing -- its own
// docstring says its 5 items are "purely informational, never blocks
// publishing." (It once stood in contrast to publishBook()'s real hard
// gate, a paid book without Stripe payouts enabled; that gate is gone,
// see below.) Cover and price are deliberately excluded
// from the recommended list below: every book that can exist already
// has a cover (createBook requires one, and there's no remove-cover
// path), and a price of 0 (Free) is a fully legitimate, intentional
// price, not an incomplete one.
// ALL-CUTOVER / STRIPE-RETIREMENT: `payoutBlocked` is gone, along with
// the `payoutsEnabled` input that produced it. It mirrored
// performPublish()'s Stripe Connect gate, and that gate has been
// removed -- see the note in performPublish()
// (src/app/(public)/dashboard/books/actions.ts) for why. Removing the
// field rather than hardcoding it to false is deliberate: it makes the
// compiler walk every UI site that used to render a block warning,
// instead of leaving dead props and unreachable branches behind.
//
// `requiredMet` is kept. It is now always true, but it is the shape the
// UI reads, and a future genuine hard requirement belongs here rather
// than in a new parallel field.
export type PublishReadiness = {
  requiredMet: boolean;
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

type ReadinessBook = Pick<Book, "description" | "keywords" | "price_cents" | "cover_path">;

export function resolvePublishReadiness(params: {
  book: ReadinessBook;
}): PublishReadiness {
  const { book } = params;

  const recommended = getPublishChecklist(book).filter((item) =>
    RECOMMENDED_LABELS.has(item.label),
  );

  // Nothing blocks publishing any more. getPublishChecklist()'s items
  // are, and always were, "purely informational, never blocks
  // publishing" -- see that function's own docstring.
  return {
    requiredMet: true,
    recommended,
  };
}
