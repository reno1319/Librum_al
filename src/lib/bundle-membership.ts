// BUNDLE-MEMBERSHIP-AUTH-1: response validation for the trusted bundle
// writers.
//
// Since migration 20260926061037_bundle_membership_write_authorization,
// no client role can write public.bundle_books. createBundle and
// updateBundle write only through the service-role functions
// public.create_bundle_with_membership and
// public.update_bundle_with_membership (migration 20260926061034). Each
// runs as ONE transaction and itself raises -- rolling everything back --
// unless the stored membership equals the requested set exactly and, for
// an update, the stored details equal the submitted ones. The DATABASE is
// what protects committed state.
//
// These checks are defense in depth on the RESPONSE. A successful call
// whose rows are not exactly what was requested cannot be explained by a
// rolled-back write -- the function would have raised -- so it is treated
// as UNCONFIRMED: the caller must not report success, and must not claim
// that nothing changed either.

export type BundleMembershipRow = {
  member_bundle_id: string;
  member_book_id: string;
};

export type BundleStateRow = BundleMembershipRow & {
  bundle_title: string;
  bundle_description: string;
  bundle_price_all: number | null;
  bundle_status: string;
};

// True only for an array of rows that is exactly the expected set of
// distinct book ids (at least two), every row bound to `bundleId`: a
// null or non-array result, zero rows, a missing, extra or duplicated
// book, a row for another bundle, or a malformed row all return false.
export function isExactBundleMembership(
  rows: unknown,
  bundleId: string,
  bookIds: readonly string[],
): boolean {
  if (!Array.isArray(rows)) return false;

  const expected = new Set(bookIds);
  // The expected set itself must be a real selection: at least two
  // distinct ids. A caller passing duplicates or fewer never "matches".
  if (expected.size !== bookIds.length || expected.size < 2) return false;
  if (rows.length !== expected.size) return false;

  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return false;
    const { member_bundle_id: rowBundleId, member_book_id: rowBookId } = row as Record<string, unknown>;
    if (rowBundleId !== bundleId) return false;
    if (typeof rowBookId !== "string" || !expected.has(rowBookId) || seen.has(rowBookId)) return false;
    seen.add(rowBookId);
  }
  return seen.size === expected.size;
}

// update_bundle_with_membership's proof of the complete resulting state:
// the exact membership, AND every row carrying exactly the submitted
// title, description and price_all, and a status string.
export function isExactBundleState(
  rows: unknown,
  bundleId: string,
  bookIds: readonly string[],
  details: { title: string; description: string; priceAll: number | null },
): boolean {
  if (!isExactBundleMembership(rows, bundleId, bookIds)) return false;
  return (rows as Record<string, unknown>[]).every(
    (row) =>
      row.bundle_title === details.title &&
      row.bundle_description === details.description &&
      row.bundle_price_all === details.priceAll &&
      typeof row.bundle_status === "string",
  );
}

// The compare-and-set refusal update_bundle_with_membership raises when
// the bundle's status or price_all changed after the action read it.
export const BUNDLE_CHANGED_SQLSTATE = "LB409";

export type BundleWriteOutcome = "changed" | "rolled_back" | "unconfirmed";

// Classifies a failed trusted write.
//
// - "changed": the compare-and-set refused; nothing was written.
// - "rolled_back": the database reported an error with a SQLSTATE. The
//   function's transaction raised, so nothing it wrote was committed.
// - "unconfirmed": anything else -- no error object with a SQLSTATE (a
//   lost or malformed response, a PostgREST-level error), a class 08
//   connection exception (the connection failed, so a COMMIT may have
//   completed without the answer arriving), or a successful call whose
//   rows fail the proof above. The write MAY have committed; the caller
//   must say it could not confirm the result.
export function classifyBundleWriteFailure(error: unknown): BundleWriteOutcome {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === BUNDLE_CHANGED_SQLSTATE) return "changed";
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !code.startsWith("08")) {
      return "rolled_back";
    }
  }
  return "unconfirmed";
}
