// HEADER NAME (Renato 1a): the account's first name for the site
// header's "Hello, <name>" (PHONE PASS r2's rule, which the Dashboard
// greeting used before it moved to the header). First word of display_name;
// null when there is no real name: empty, holding an "@", or equal to
// the email's local part (handle_new_user's no-name fallback). Never a
// pen name -- an author can have several.
export function accountFirstName(
  displayName: string | null | undefined,
  email: string | null | undefined,
): string | null {
  const name = (displayName ?? "").trim();
  const emailLocalPart = (email ?? "").split("@")[0] ?? "";
  if (!name || name.includes("@") || (emailLocalPart && name === emailLocalPart)) return null;
  return name.split(/\s+/u)[0] || null;
}
