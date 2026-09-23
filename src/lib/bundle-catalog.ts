// ALL-WIRING-5: the bundle-specific decisions that sit on top of the
// shared whole-ALL catalog primitives in ./catalog-price. Pure: no
// import other than that module, no database, provider or environment
// access, so every rule here is unit-testable without a page.
//
// A bundle's price is `bundles.price_all`, with exactly the same
// three-way meaning a book's has (null = no authored ALL price, 0 =
// explicitly free, 99..100000 = paid). `bundles.price_cents` is legacy
// USD minor units and is read by nothing in this module -- not as a
// price, not as a fallback, not as a free/paid signal.

import { formatCatalogAmountAll, resolveCatalogPriceState } from "@/lib/catalog-price";

/**
 * What a bundle page may claim about buying the books separately.
 *
 * `show: false` is the answer whenever the claim cannot be made
 * honestly, and carries no numbers at all, so a caller cannot render a
 * partial or guessed total from it.
 */
export type BundleSavingsAll =
  | { show: true; originalTotalAll: number; savingsAll: number }
  | { show: false };

/**
 * A member as it arrives from the bundle page's `bundle_books ->
 * books(...)` embed: the joined book, or null when that book cannot be
 * resolved for this viewer (deleted, or hidden from them by RLS).
 */
export type BundleSavingsMember = { price_all?: unknown } | null;

/**
 * The "bought separately" comparison for a bundle, in WHOLE lek.
 *
 * Shown only when every input is an explicit, valid catalog price:
 *   - the bundle's own price_all is free or paid (never unavailable);
 *   - there is at least one member, and EVERY member resolves and has an
 *     explicit valid price_all. One unresolvable or unpriced member
 *     means the total is unknown -- it is never counted as zero, and the
 *     comparison is withheld rather than understated;
 *   - the saving is strictly positive. Zero or a negative "saving" is
 *     not a saving, and is never displayed as one.
 *
 * A member priced exactly 0 contributes 0 because it is EXPLICITLY free,
 * which is a different fact from "no price".
 *
 * Integer arithmetic only. Every addend is a validated whole-lek catalog
 * price (at most 100000), so the sum is a safe integer for any bundle
 * this schema can hold, and nothing is scaled, divided or rounded.
 */
export function resolveBundleSavingsAll(
  bundlePriceAll: unknown,
  members: ReadonlyArray<BundleSavingsMember>,
): BundleSavingsAll {
  if (resolveCatalogPriceState(bundlePriceAll) === "unavailable") return { show: false };
  if (members.length === 0) return { show: false };

  let originalTotalAll = 0;
  for (const member of members) {
    if (!member) return { show: false };
    const memberPriceAll = member.price_all;
    if (resolveCatalogPriceState(memberPriceAll) === "unavailable") return { show: false };
    originalTotalAll += memberPriceAll as number;
  }

  const savingsAll = originalTotalAll - (bundlePriceAll as number);
  if (!Number.isSafeInteger(originalTotalAll) || !(savingsAll > 0)) return { show: false };

  return { show: true, originalTotalAll, savingsAll };
}

/** The "bought separately" comparison line, or null when it is withheld. */
export function formatBundleSavingsAll(
  savings: BundleSavingsAll,
): { originalTotal: string; savings: string } | null {
  if (!savings.show) return null;
  return {
    originalTotal: formatCatalogAmountAll(savings.originalTotalAll),
    savings: formatCatalogAmountAll(savings.savingsAll),
  };
}

/** Shown in place of a checkout control for a bundle with no ALL price. */
export const BUNDLE_UNAVAILABLE_NOTICE = "Not available right now";

/**
 * Shown in place of a checkout control for an explicitly priced bundle,
 * free or paid. Deliberately neutral: bundle checkout is closed under
 * every configuration, and a free bundle is not "paid bundle checkout".
 */
export const BUNDLE_CHECKOUT_COMING_SOON_NOTICE = "Bundle checkout coming soon";

/**
 * The non-interactive notice a reader sees where a checkout control
 * would be. There is no branch here that yields a control: bundle
 * checkout stays closed whatever the bundle's price and whatever any
 * paid-mode variable says.
 */
export function bundleCheckoutNotice(bundlePriceAll: unknown): string {
  return resolveCatalogPriceState(bundlePriceAll) === "unavailable"
    ? BUNDLE_UNAVAILABLE_NOTICE
    : BUNDLE_CHECKOUT_COMING_SOON_NOTICE;
}
