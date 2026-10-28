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
  "Lexuesit e shohin tashmë këtë çmim, ndaj shënoni kutinë nën çmim për të konfirmuar çmimin e ri.";

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

// ALBANIAN-9: "1.500 lekë", with a dot for thousands like every other
// price on the site (kept import-free, so the grouping is done here).
function priceWords(priceAll: number | null): string {
  if (priceAll === null) return "pa çmim";
  if (priceAll === 0) return "falas";
  const grouped = String(priceAll).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${grouped} ${priceAll === 1 ? "lek" : "lekë"}`;
}

export function priceChangeConfirmText(currentPriceAll: number | null, newPriceAll: number): string {
  const change = newPriceAll === 0 ? "bëjeni falas" : `ndryshojeni çmimin në ${priceWords(newPriceAll)}`;
  return `Po, ${change} (deri tani: ${priceWords(currentPriceAll)}). Lexuesit e shohin çmimin e ri menjëherë.`;
}
