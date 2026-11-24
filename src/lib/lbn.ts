// LBN (Renato 2026-11-24, lbnq1 a .. lbnq10 a): the Librum Book Number.
// "LE" (an ebook on Librum; "LP" is kept for print) + 7 random
// characters + 1 check character, e.g. LE7K4M9X2D. The database makes
// every code (supabase/migrations/20261124190000_lbn_book_number.sql,
// lbn_generate); this file only reads them. Pure: no imports.

/** The 31 characters an LBN uses after its prefix: no 0/O, no 1/I/L. */
export const LBN_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const PREFIX_WEIGHT: Record<string, number> = { LE: 1, LP: 2 };

/**
 * The check character for a prefix and the 7 random characters, the
 * same sum as the database's lbn_check_char(): (k + 1*v1 + ... + 7*v7)
 * mod 31, k = 1 for "LE" and 2 for "LP". null when either part is not
 * well formed.
 */
export function lbnCheckChar(prefix: string, body: string): string | null {
  const base = PREFIX_WEIGHT[prefix];
  if (base === undefined || body.length !== 7) return null;
  let sum = base;
  for (let i = 0; i < 7; i += 1) {
    const place = LBN_ALPHABET.indexOf(body[i]);
    if (place < 0) return null;
    sum += (i + 1) * place;
  }
  return LBN_ALPHABET[sum % 31];
}

/** True only for a well-formed LBN (capital letters) with the right check character. */
export function isValidLbn(value: string): boolean {
  if (!/^L[EP][23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(value)) return false;
  return lbnCheckChar(value.slice(0, 2), value.slice(2, 9)) === value[9];
}

/**
 * What a visitor typed in a /lbn/<code> link, as the stored code: small
 * letters are accepted (lbnq9 a). null when it is not a valid LBN.
 */
export function normalizeLbn(raw: string): string | null {
  const upper = raw.trim().toUpperCase();
  return isValidLbn(upper) ? upper : null;
}
