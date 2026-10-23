// PHONE PASS (D2, Renato 2a): the Dashboard's greeting line, as on the
// A2 mockup ("Mirë se erdhe, [Author name]"; English until the Albanian
// pass). It greets by the account name, first word only -- never a pen
// name, since an author can have several. No name: just "Hello".
//
// r2 (audit N4): an account that signed up without a name gets the part
// of its email before the "@" as display_name (handle_new_user's
// fallback). That is not a name, so it -- or anything else holding an
// "@" -- greets with just "Hello" too, never an email fragment.
export function buildDashboardGreeting(
  displayName: string | null | undefined,
  email: string | null | undefined,
): string {
  const name = (displayName ?? "").trim();
  const emailLocalPart = (email ?? "").split("@")[0] ?? "";
  if (!name || name.includes("@") || (emailLocalPart && name === emailLocalPart)) return "Hello";
  const firstWord = name.split(/\s+/u)[0] ?? "";
  return firstWord ? `Hello, ${firstWord}` : "Hello";
}
