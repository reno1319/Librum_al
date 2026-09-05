// LIBRUM 2.0 AUTHOR-1A: the single, shared public-author-name resolution
// rule -- profiles.public_author_name (a pen name, reader-facing) when
// set, else profiles.display_name (the account/private identity,
// unchanged by this feature) as a fallback for an author who hasn't
// visited Profile since public_author_name was introduced. This mirrors
// search_books()'s own author-name match clause -- the same fallback
// rule expressed once here in application code and once in SQL, not
// duplicated per call site.
//
// LIBRUM 2.0 AUTHOR-1C: `display_name` is now OPTIONAL on the accepted
// shape, not merely because some caller forgot to select it -- it's the
// database's own boundary made visible in the type. Public reader-facing
// queries (Bookstore, Book Detail, the public Author page, series,
// bundles, library, wishlist, following, the sample API) now read
// through the public_author_profiles VIEW (see migration 045), which
// physically does not have a display_name column -- there is no way for
// those call sites to accidentally read it even by mistake, and this
// resolver's own fallback to `profile.display_name` simply never
// triggers for them (it's `undefined`, not a leaked value). Only
// self/admin/staff contexts -- which query the base profiles table
// directly, for a row they're actually authorized to read in full (see
// profiles' own RLS policies) -- ever pass an object that actually HAS
// display_name, and for them the fallback still works exactly as
// before. Do not widen this back to reading display_name from a public
// query merely because this signature accepts it -- see AUTHOR-1C's own
// audit for why that boundary now lives in the database, not just here.
export function resolvePublicAuthorName(
  profile:
    | {
        display_name?: string | null;
        public_author_name: string | null;
      }
    | null
    | undefined,
): string | null {
  return profile?.public_author_name ?? profile?.display_name ?? null;
}
