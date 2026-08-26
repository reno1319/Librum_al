// LIBRUM 2.0 UI-5: the book detail purchase area branches on six
// distinct states (a logged-out visitor -- split by whether the book is
// paid or free, since "Log in to buy" is wrong copy for a free book;
// the book's own author; an owner; an unowned free book; an unowned
// paid book) that were previously expressed as a deeply nested ternary
// directly in the page's JSX. Extracted as a pure function -- same
// "extract a pure decision function, unit-test it directly" pattern
// already used by src/lib/homepage.ts's resolveHomepageCta() and
// src/lib/bookstore.ts's parseBookstoreQuery() -- purely to classify
// which state applies; the actual CTA labels/hrefs/forms stay in the
// page, since those involve JSX (Links vs. server-action forms), not
// pure data.
export type BookPurchaseState =
  | "anonymous-paid"
  | "anonymous-free"
  | "author"
  | "owned"
  | "free-unowned"
  | "paid-unowned";

export function resolveBookPurchaseState(params: {
  user: { id: string } | null;
  isAuthor: boolean;
  owned: boolean;
  priceCents: number;
}): BookPurchaseState {
  const { user, isAuthor, owned, priceCents } = params;

  if (!user) return priceCents === 0 ? "anonymous-free" : "anonymous-paid";
  // An author viewing their own book takes precedence over owned/free --
  // an author's own book was never actually purchased or claimed free,
  // so "owned"/"free-unowned" would be a misleading label for them even
  // if user_owns_book() happened to also be true.
  if (isAuthor) return "author";
  if (owned) return "owned";
  return priceCents === 0 ? "free-unowned" : "paid-unowned";
}
