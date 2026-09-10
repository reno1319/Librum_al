// PHASE-1C: the single source of truth for the staging fixture dataset.
// Pure data + pure byte-builders only -- no Supabase import, no I/O, no
// `@/`-aliased import (see README.md's "Why no @/ imports here" section
// and the PHASE-1C design report's runtime-execution findings). This is
// what makes every ID here safe to import from both the plain-Node
// runtime scripts (seed.mts/reset.mts) and the vitest test suite.
//
// SAFETY: nothing in this file, on its own, ever touches a network or a
// database. Importing it has zero side effects.

import JSZip from "jszip";

// ============================================================
// Ownership marker (PHASE-1C correction pass 2, item 1)
// ============================================================
//
// Written to a fixture Auth user's app_metadata (service-role-only
// writable -- confirmed from the installed @supabase/auth-js
// AdminUserAttributes type, which has no separate "owner" concept of
// its own). A fixed email address alone is never sufficient proof an
// existing account belongs to this fixture system -- see
// auth-ownership.mts for how this is actually checked.
export const FIXTURE_OWNERSHIP_NAMESPACE = "librum-staging-fixture-v1";
export const FIXTURE_OWNERSHIP_SCHEMA_VERSION = 1;

export type FixtureOwnershipMarker = {
  namespace: string;
  schema_version: number;
};

export const FIXTURE_OWNERSHIP_MARKER: FixtureOwnershipMarker = {
  namespace: FIXTURE_OWNERSHIP_NAMESPACE,
  schema_version: FIXTURE_OWNERSHIP_SCHEMA_VERSION,
};

// ============================================================
// Fixed fixture identities
// ============================================================
//
// Fixed, unmistakably-synthetic UUIDs (never derived from anything
// real) for every baseline row this fixture set creates. auth.users
// IDs are NOT fixed here -- confirmed in the PHASE-1C design review
// that @supabase/auth-js's installed AdminUserAttributes has no `id`
// field, so those two IDs are always *resolved* at runtime via
// email+marker lookup (see auth-ownership.mts), never assumed.

export const FIXTURE_AUTHOR_EMAIL = "librum-staging-fixture-author@example.invalid";
export const FIXTURE_READER_EMAIL = "librum-staging-fixture-reader@example.invalid";

export const FIXTURE_AUTHOR_DISPLAY_NAME = "Fixture Author";
export const FIXTURE_READER_DISPLAY_NAME = "Fixture Reader";
export const FIXTURE_AUTHOR_ROLE = "author" as const;
export const FIXTURE_READER_ROLE = "reader" as const;

export const FIXTURE_SERIES_ID = "00000000-f1c9-4000-8000-000000000010";
export const FIXTURE_BUNDLE_ID = "00000000-f1c9-4000-8000-000000000011";
export const FIXTURE_CONTRIBUTOR_ID = "00000000-f1c9-4000-8000-000000000012";
export const FIXTURE_DISCOUNT_CODE_ID = "00000000-f1c9-4000-8000-000000000013";
export const FIXTURE_PURCHASE_ID = "00000000-f1c9-4000-8000-000000000014";

// Synthetic Stripe-shaped identifiers deliberately NOT using the real
// `cs_`/`pi_` prefixes, so they can never be confused with (or collide
// with) a genuine Stripe object -- see the seeded purchase below and
// dispositions.mts's `classifyPurchase`.
export const FIXTURE_STRIPE_CHECKOUT_SESSION_ID = "fixture_cs_00000000000000000000000000";
export const FIXTURE_STRIPE_PAYMENT_INTENT_ID = "fixture_pi_00000000000000000000000000";

// purchases.regime's schema default (supabase/schema.sql:1468-1469) --
// the seeded fixture purchase uses the same default any legacy-path
// purchase would, rather than inventing a distinct value.
export const FIXTURE_PURCHASE_REGIME = "legacy_stripe_connect_v1" as const;
export const FIXTURE_PURCHASE_AMOUNT_CENTS = 499;

export type FixtureBookRole = "draft-publish-target" | "unpublish-republish-target" | "owned-review-target" | "wishlist-discount-target" | "free-acquisition-target";

export type FixtureBookDefinition = {
  id: string;
  role: FixtureBookRole;
  title: string;
  status: "draft" | "published";
  priceCents: number;
  genre: string;
  seriesId: string | null;
  seriesPosition: number | null;
};

// LIBRUM-2.0 PHASE-1C correction pass 2, item 5: performPublish() blocks
// any price_cents > 0 draft->published transition unless the author's
// stripe_payouts_enabled is true (src/app/(public)/dashboard/books/
// actions.ts:1028-1038), and this fixture design must never set that
// flag (payout/bank-payout enablement stays disabled throughout). Book
// D and Book U are therefore both FREE -- their publish/unpublish/
// republish transitions must never hit that gate.
export const FIXTURE_BOOKS: readonly FixtureBookDefinition[] = [
  {
    id: "00000000-f1c9-4000-8000-000000000001",
    role: "draft-publish-target",
    title: "Fixture Book D (Draft Publishing Target)",
    status: "draft",
    priceCents: 0,
    genre: "Fiction",
    seriesId: null,
    seriesPosition: null,
  },
  {
    id: "00000000-f1c9-4000-8000-000000000002",
    role: "unpublish-republish-target",
    title: "Fixture Book U (Unpublish/Republish Target)",
    status: "published",
    priceCents: 0,
    genre: "Fiction",
    seriesId: null,
    seriesPosition: null,
  },
  {
    id: "00000000-f1c9-4000-8000-000000000003",
    role: "owned-review-target",
    title: "Fixture Book P1 (Owned, Unreviewed)",
    status: "published",
    priceCents: 499,
    genre: "Mystery & Thriller",
    seriesId: FIXTURE_SERIES_ID,
    seriesPosition: 1,
  },
  {
    id: "00000000-f1c9-4000-8000-000000000004",
    role: "wishlist-discount-target",
    title: "Fixture Book P2 (Wishlist + Discount Target)",
    status: "published",
    priceCents: 799,
    genre: "Mystery & Thriller",
    seriesId: FIXTURE_SERIES_ID,
    seriesPosition: 2,
  },
  {
    id: "00000000-f1c9-4000-8000-000000000005",
    role: "free-acquisition-target",
    title: "Fixture Book F (Free Acquisition Target)",
    status: "published",
    priceCents: 0,
    genre: "Non-Fiction",
    seriesId: null,
    seriesPosition: null,
  },
] as const;

export function fixtureBookById(id: string): FixtureBookDefinition {
  const book = FIXTURE_BOOKS.find((b) => b.id === id);
  if (!book) throw new Error(`fixtureBookById: no fixture book with id ${id}`);
  return book;
}

export function fixtureBookByRole(role: FixtureBookRole): FixtureBookDefinition {
  const book = FIXTURE_BOOKS.find((b) => b.role === role);
  if (!book) throw new Error(`fixtureBookByRole: no fixture book with role ${role}`);
  return book;
}

export const FIXTURE_BOOK_IDS: readonly string[] = FIXTURE_BOOKS.map((b) => b.id);

// P1 -- correction pass 2, item 5: P1 is already owned by the fixture
// reader, so a discount-at-checkout test there is not a clean "buy"
// case. Moved to P2, which the reader does NOT own -- see the design
// report for why sharing P2 with the wishlist-creation target is safe
// (independent, non-conflicting tables).
export const FIXTURE_DISCOUNT_TARGET_BOOK_ID = fixtureBookByRole("wishlist-discount-target").id;
export const FIXTURE_PURCHASE_TARGET_BOOK_ID = fixtureBookByRole("owned-review-target").id;

// PHASE-1C review round 3, item 4: bundle_books has its OWN `id uuid
// primary key default gen_random_uuid()` (schema.sql) -- unlike every
// other baseline row, it was never given a fixed id, which made exact-
// id postcondition verification after reseeding impossible to predict.
// Fixed here, matching the same discipline as every other baseline row.
export type FixtureBundleMembership = { id: string; bundleId: string; bookId: string };
export const FIXTURE_BUNDLE_MEMBERSHIPS: readonly FixtureBundleMembership[] = [
  {
    id: "00000000-f1c9-4000-8000-000000000015",
    bundleId: FIXTURE_BUNDLE_ID,
    bookId: fixtureBookByRole("owned-review-target").id,
  },
  {
    id: "00000000-f1c9-4000-8000-000000000016",
    bundleId: FIXTURE_BUNDLE_ID,
    bookId: fixtureBookByRole("wishlist-discount-target").id,
  },
] as const;
export const FIXTURE_BUNDLE_BOOK_IDS: readonly string[] = FIXTURE_BUNDLE_MEMBERSHIPS.map((m) => m.bookId);

// PHASE-1C review round 3, item 6: baseline external-identity policy.
// avatar_path has a defined safe baseline (null -- neither fixture
// account has an avatar in the baseline state; seed converges it back
// to null every run, and reset/teardown remove any actual avatar
// storage object for BOTH fixture accounts, not just the author).
// stripe_account_id / stripe_payouts_enabled have NO defined safe reset
// policy -- a non-null/true value is real external Stripe Connect state
// this design has no reviewed procedure for touching, so seed and
// reset/teardown both hard-stop rather than silently overwrite or
// ignore it. See auth-ownership.mts's profile-convergence callers and
// reset.mts's preflight.
export const FIXTURE_AVATAR_PATH_BASELINE: null = null;

// PHASE-1C review round 3, item 2: the exact set of row ids reseeding
// recreates in each BASELINE_RESEEDED_TABLES table (dispositions.mts) --
// used by reset.mts's postcondition verification to assert a
// reset-to-baseline run leaves EXACTLY these rows in each such table,
// never merely "some rows" (the old, incorrect check) or "zero rows"
// (transient tables' check, which does not apply to these).
export function baselineTableRowIds(): Readonly<Record<string, readonly string[]>> {
  return {
    series: [FIXTURE_SERIES_ID],
    books: FIXTURE_BOOK_IDS,
    book_contributors: [FIXTURE_CONTRIBUTOR_ID],
    bundle_books: FIXTURE_BUNDLE_MEMBERSHIPS.map((m) => m.id),
    bundles: [FIXTURE_BUNDLE_ID],
    discount_codes: [FIXTURE_DISCOUNT_CODE_ID],
    purchases: [FIXTURE_PURCHASE_ID],
  };
}

// ============================================================
// Storage: deterministic paths, matching createBook()'s own convention
// exactly (src/app/(public)/dashboard/books/actions.ts:529-530):
//   covers/<author_id>/<book_id>-cover.<ext>
//   manuscripts/<author_id>/<book_id>.epub
// ============================================================

export function fixtureCoverPath(authorId: string, bookId: string): string {
  return `${authorId}/${bookId}-cover.png`;
}

export function fixtureManuscriptPath(authorId: string, bookId: string): string {
  return `${authorId}/${bookId}.epub`;
}

// A tiny, valid, deterministic 1x1 PNG -- same well-known bytes already
// used by this codebase's own test fixtures (src/lib/docx-test-
// fixtures.ts's tinyPngBytes()), duplicated here (not imported) so this
// module has zero `@/`-aliased dependencies -- see README.md.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function buildFixtureCoverBytes(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, "base64");
}

// A minimal, structurally valid EPUB -- deliberately the same known-good
// shape already relied on by this repo's own tests (src/app/(public)/
// dashboard/books/actions.test.ts: uncompressed `mimetype` entry,
// container.xml pointing at a content.opf, a single spine item), rebuilt
// here directly against `jszip` (a plain node_modules dependency, no
// alias needed) rather than importing a test-only helper module -- see
// the PHASE-1C design report's "Deterministic Storage convergence"
// section for why. Validity against the REAL validator
// (@/lib/epub-validation's validateEpubStructure) is proven in
// manifest.test.ts, which runs under vitest where the `@/` alias
// resolves correctly -- this module itself never imports it.
export async function buildFixtureEpubBytes(title: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">librum-fixture-${title.replace(/\s+/g, "-").toLowerCase()}</dc:identifier>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
  </spine>
</package>`,
  );

  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="librum-fixture"/>
  </head>
  <docTitle><text>${title}</text></docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
  );

  zip.file(
    "OEBPS/chapter1.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body><h1>${title}</h1><p>This is synthetic fixture content. Not a real book.</p></body>
</html>`,
  );

  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  return bytes;
}
