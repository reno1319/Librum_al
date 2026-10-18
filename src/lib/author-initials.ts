// LIBRUM 2.0 PRODUCT-2 PRE-COMMIT CORRECTION: the no-avatar fallback
// previously read as a missing image (a plain neutral circle) rather
// than an intentional placeholder. Initials derived from the same
// public display_name every other author surface already uses -- no
// new schema field, no external avatar service.
//
// LEFTOVERS (L3): only words that contain a letter count, and each gives
// its first LETTER, so punctuation, digits and emoji never become an
// initial ("Ana (local)" -> "AL", "3Dana" -> "D", "😀" -> ""). NFC
// first, so a decomposed "É" gives "É", not a bare "E".
const LETTER = /\p{L}/u;

export function getAuthorInitials(name: string): string {
  const words = name
    .normalize("NFC")
    .trim()
    .split(/\s+/)
    .filter((word) => LETTER.test(word));

  if (words.length === 0) return "";
  const firstLetter = (word: string) => word.match(LETTER)![0];
  if (words.length === 1) return firstLetter(words[0]!).toUpperCase();

  const first = firstLetter(words[0]!);
  const last = firstLetter(words[words.length - 1]!);
  return `${first}${last}`.toUpperCase();
}
