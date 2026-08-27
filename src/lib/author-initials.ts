// LIBRUM 2.0 PRODUCT-2 PRE-COMMIT CORRECTION: the no-avatar fallback
// previously read as a missing image (a plain neutral circle) rather
// than an intentional placeholder. Initials derived from the same
// public display_name every other author surface already uses -- no
// new schema field, no external avatar service.
export function getAuthorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();

  const first = words[0]!.charAt(0);
  const last = words[words.length - 1]!.charAt(0);
  return `${first}${last}`.toUpperCase();
}
