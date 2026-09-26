// BUNDLE-DELETE-SAFETY-1: request and response checks for deleteBundle.
//
// deleteBundle deletes through the author's own session client: the
// `bundles` DELETE grant and the "Authors can delete their own bundles"
// policy allow exactly the author's own row, and the bundle_books
// foreign key's ON DELETE CASCADE removes the membership as the table
// owner. It asks for the deleted row's `id` back and reports success
// only when that answer proves exactly the requested bundle went.

// A canonical lowercase UUID, the only form Postgres returns. Anything
// else is refused before the database is asked, so the returned id can
// be compared to the requested one with plain equality.
const BUNDLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isBundleId(value: unknown): value is string {
  return typeof value === "string" && BUNDLE_ID_PATTERN.test(value);
}

// True only for an array holding exactly one row whose `id` is exactly
// `bundleId`. Null, a non-array, zero rows, several rows, a row that is
// not an object, a missing id or any other id all return false: the
// deletion is then unconfirmed and must never be reported as done.
export function isConfirmedBundleDeletion(rows: unknown, bundleId: string): boolean {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return false;
  }
  const [row] = rows;
  return typeof row === "object" && row !== null && (row as { id?: unknown }).id === bundleId;
}
