// Pure logic extracted from buyBook (src/app/books/[id]/actions.ts) so it
// can be unit tested directly -- actions.ts has "use server" at the top,
// which (per Next.js's rules for that directive) can only export async
// functions, so this sync helper has to live outside it.

// LAUNCH-1 P1-4: converts create_book_checkout_intent's own
// database expires_at (a timestamptz, sub-second precision) into the
// Unix-seconds integer Stripe's checkout.sessions.create expects.
//
// Math.floor, never Math.round -- this is the entire mechanism behind
// the proved invariant stripe_expires_at <= database_intent_reuse_cutoff
// (the intent's own expires_at, which the reuse query in
// create_book_checkout_intent compares against with `expires_at > now()`).
// Flooring a timestamp can only move it earlier or leave it unchanged
// (equal only in the measure-zero case the input lands exactly on a
// whole second) -- it can never produce a value LATER than the true
// instant. Math.round would violate the invariant for any input whose
// fractional second is >= 0.5: Stripe's session would then stay payable
// up to ~999ms after the database had already stopped reusing that
// intent. Mirrors the same Math.floor(ms / 1000) pattern already
// established in buyBundle for bundle_checkout_snapshots.protection_expires_at
// -- deliberately NOT extracted into a shared helper with that existing,
// already-audited code, to keep this change scoped to the single-book
// path only.
export function toStripeExpiresAtSeconds(expiresAtIso: string): number {
  return Math.floor(Date.parse(expiresAtIso) / 1000);
}
