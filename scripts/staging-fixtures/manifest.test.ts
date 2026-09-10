import { describe, expect, it } from "vitest";
import { GENRES } from "@/lib/genres";
import { validateEpubStructure } from "@/lib/epub-validation";
import * as manifestModule from "./manifest.mts";
import {
  FIXTURE_BOOKS,
  FIXTURE_BOOK_IDS,
  FIXTURE_SERIES_ID,
  FIXTURE_BUNDLE_BOOK_IDS,
  FIXTURE_DISCOUNT_TARGET_BOOK_ID,
  FIXTURE_PURCHASE_TARGET_BOOK_ID,
  FIXTURE_OWNERSHIP_MARKER,
  buildFixtureCoverBytes,
  buildFixtureEpubBytes,
  fixtureBookByRole,
} from "./manifest.mts";

// PHASE-1C: this is the ONE place the fixture manuscript bytes are
// checked against the app's real EPUB validator -- see manifest.mts's
// own comment for why the runtime scripts never import
// validateEpubStructure directly (it's `@/`-aliased, which plain Node
// can't resolve without a bundler; vitest's alias resolution handles it
// fine here).
describe("fixture manuscript bytes pass the real EPUB validator", () => {
  it("validates as a structurally valid EPUB for every fixture book", async () => {
    for (const book of FIXTURE_BOOKS) {
      const bytes = await buildFixtureEpubBytes(book.title);
      const result = await validateEpubStructure(bytes);
      expect(result.valid, `book ${book.id} (${book.title}): ${JSON.stringify(result)}`).toBe(true);
    }
  });
});

describe("fixture cover bytes", () => {
  it("produces a non-empty PNG buffer", () => {
    const bytes = buildFixtureCoverBytes();
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic bytes.
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});

describe("manifest referential integrity", () => {
  it("has no duplicate book IDs", () => {
    expect(new Set(FIXTURE_BOOK_IDS).size).toBe(FIXTURE_BOOK_IDS.length);
  });

  it("every book's genre is a real, closed-list genre", () => {
    for (const book of FIXTURE_BOOKS) {
      expect(GENRES).toContain(book.genre);
    }
  });

  it("every book referencing a series references the fixture series", () => {
    for (const book of FIXTURE_BOOKS) {
      if (book.seriesId !== null) {
        expect(book.seriesId).toBe(FIXTURE_SERIES_ID);
        expect(book.seriesPosition).toBeGreaterThan(0);
      }
    }
  });

  it("bundle books are a subset of known fixture book IDs", () => {
    for (const id of FIXTURE_BUNDLE_BOOK_IDS) {
      expect(FIXTURE_BOOK_IDS).toContain(id);
    }
  });

  // PHASE-1C correction pass 2, item 5: draft-publish and unpublish/
  // republish targets must be free, since performPublish() blocks a
  // priced draft->published transition unless stripe_payouts_enabled is
  // true, and this design must never set that flag.
  it("the draft-publish and unpublish/republish targets are free", () => {
    expect(fixtureBookByRole("draft-publish-target").priceCents).toBe(0);
    expect(fixtureBookByRole("unpublish-republish-target").priceCents).toBe(0);
  });

  it("the draft-publish target actually starts as a draft", () => {
    expect(fixtureBookByRole("draft-publish-target").status).toBe("draft");
  });

  it("the unpublish/republish target starts published", () => {
    expect(fixtureBookByRole("unpublish-republish-target").status).toBe("published");
  });

  it("the free-acquisition target is free and distinct from the purchase target", () => {
    const free = fixtureBookByRole("free-acquisition-target");
    expect(free.priceCents).toBe(0);
    expect(free.id).not.toBe(FIXTURE_PURCHASE_TARGET_BOOK_ID);
  });

  // PHASE-1C correction pass 2, item 5: the discount code must NOT live
  // on the book the fixture reader already owns.
  it("the discount target is not the already-owned purchase target", () => {
    expect(FIXTURE_DISCOUNT_TARGET_BOOK_ID).not.toBe(FIXTURE_PURCHASE_TARGET_BOOK_ID);
  });

  // Corresponds directly to PHASE-1C correction pass 2 (item 5's
  // predecessor requirement, reaffirmed): the original design
  // pre-created wishlist_items/author_follows/reviews rows, which was
  // flagged as blocking their own "first X creation" QA journeys. This
  // manifest module intentionally exports no such row -- asserted here
  // as a structural fact (no export exists with those names), not
  // merely by omission from documentation.
  it("exports no wishlist, follow, or review row -- those must stay clean for QA", () => {
    for (const key of Object.keys(manifestModule)) {
      expect(key.toLowerCase()).not.toContain("wishlist");
      expect(key.toLowerCase()).not.toContain("follow");
      expect(key.toLowerCase()).not.toMatch(/\breview\b/);
    }
  });

  it("the ownership marker is a fixed, versioned object", () => {
    expect(FIXTURE_OWNERSHIP_MARKER.namespace).toBe("librum-staging-fixture-v1");
    expect(FIXTURE_OWNERSHIP_MARKER.schema_version).toBe(1);
  });
});
