export const PLATFORM_FEE_PERCENT = 20;

export function platformFeeCents(priceCents: number) {
  return Math.round((priceCents * PLATFORM_FEE_PERCENT) / 100);
}
