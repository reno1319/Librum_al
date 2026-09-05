// LIBRUM 2.0 BLOG-1C: no slug-generation helper or package existed
// anywhere in this repo before BLOG-1 (confirmed by the BLOG-1A audit) --
// this is a small, deterministic, dependency-free function, not a
// reused library. Albanian e-with-diaeresis (e) and c-with-cedilla (c)
// are precomposed characters that Unicode NFD normalization does NOT
// decompose into a base letter + combining mark the way an accented e
// does (e.g. e-acute -> e + combining acute) -- they need an explicit
// mapping, or they'd otherwise fall through untouched into the final
// non-alphanumeric strip and become a stray hyphen. Applied BEFORE the
// generic NFD pass so they never reach it in the first place.
//
// Deliberately narrow: only produces a slug from a title. Uniqueness is
// enforced by the database's own UNIQUE constraint (migration 047), not
// checked here -- this function has no way to know what other slugs
// already exist, and duplicating that check client/server-side would
// only risk drifting from the real source of truth. See
// blog-form-logic.ts's mapBlogRpcError() for how a real collision
// surfaces to staff.
const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/\u00eb/g, "e") // ë = e-with-diaeresis (Albanian e)
    .replace(/\u00e7/g, "c") // ç = c-with-cedilla (Albanian c)
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// LIBRUM 2.0 BLOG-1C: the slug-auto-generation DECISION, extracted as a
// pure function so it's directly unit-testable without a component
// render harness -- this repo's vitest config only ever runs `.test.ts`
// files, environment "node", with no jsdom/testing-library anywhere, so
// interactive component logic is consistently pulled out into plain
// functions and tested there instead (decideStaffAccess,
// resolveAdminLandingVisibility, buildSiteHeaderNav, ...); this follows
// the same convention rather than introducing new test infrastructure.
//
// Auto-generates from the title only while the slug field has never
// been manually touched by the user and isn't locked (a published
// post's slug is read-only) -- once touched, later title edits must
// never overwrite whatever the user has already typed into the slug
// field themselves.
export function resolveAutoSlug(params: {
  currentSlug: string;
  title: string;
  slugTouched: boolean;
  slugReadOnly: boolean;
}): string {
  if (params.slugTouched || params.slugReadOnly) return params.currentSlug;
  return slugify(params.title);
}
