// LIVE-PRICE-CONFIRM-1 (pipeline item 7, Renato 10-24 "2. a", "3. a"):
// changing the price of a LIVE book or bundle needs a tick under the
// price, and the server refuses the save without it. Pure and
// import-free, so the Edit pages' tick (components/price-change-confirm)
// and the Server Actions share one rule and one sentence.
//
// The tick's value is the NEW price, as the parser read it, and the
// server accepts it only when it equals the price being saved: a tick
// left from an earlier value cannot confirm a different one. Drafts
// never need it, and neither does a save that keeps the price.

export const PRICE_CHANGE_CONFIRM_FIELD = "confirmPriceChange";

export const PRICE_CHANGE_CONFIRM_MESSAGE =
  "It's live, so tick the box under the price to confirm the new price.";

export function isLivePriceChange(input: {
  status: string | null | undefined;
  currentPriceAll: number | null | undefined;
  submittedPriceAll: number;
}): boolean {
  return input.status === "published" && input.currentPriceAll !== input.submittedPriceAll;
}

export function isPriceChangeConfirmed(formData: FormData, submittedPriceAll: number): boolean {
  return formData.get(PRICE_CHANGE_CONFIRM_FIELD) === String(submittedPriceAll);
}

function priceWords(priceAll: number | null): string {
  if (priceAll === null) return "no price";
  if (priceAll === 0) return "free";
  return `${priceAll} lek`;
}

export function priceChangeConfirmText(currentPriceAll: number | null, newPriceAll: number): string {
  return `Yes, change the price from ${priceWords(currentPriceAll)} to ${priceWords(newPriceAll)}. Readers see the new price right away.`;
}
