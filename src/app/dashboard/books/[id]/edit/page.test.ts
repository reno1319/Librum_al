import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 PRODUCT-5 EDIT-CRASH CORRECTION: a real production defect
// -- this page (a Server Component, no "use client") was passing an
// inline arrow function (onManuscriptChange={() => {}}) to
// ManuscriptField, a "use client" component. Next.js/React cannot
// serialize a raw function across that Server->Client boundary; this
// crashed the ENTIRE Edit route with a 500 ("Event handlers cannot be
// passed to Client Component props"), reproduced empirically against
// a real dev server before writing this fix, and independent of which
// book was being edited (it's a static code defect, not data-
// dependent). The fix: ManuscriptField's onManuscriptChange (like
// CoverField's own onCoverChange, already correct since COVER-1) is
// now optional and invoked internally via `?.()`, so this page simply
// omits the prop entirely -- it has no use for it.
//
// This exact crash mode (a non-serializable value crossing the RSC
// Server->Client boundary) isn't reproducible in Vitest's plain node
// environment -- it's a real Next.js RSC-payload serialization error,
// not something jsdom or a unit test can trigger, and this codebase
// deliberately avoids React Testing Library in favor of live
// verification for exactly this class of thing (see this repo's other
// component test files' own comments). A source-level regression
// guard is the practical, narrow alternative: assert this page's own
// source never again passes an inline function to either "use client"
// Files-section field. (TypeScript's own optional-prop + `?.()` call
// site is a second, independent guard: reintroducing a non-optional
// call there without the `?.` would fail `tsc --noEmit` on its own.)
describe("Edit page: never passes an inline function prop across the Server->Client boundary", () => {
  const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

  it("does not pass onManuscriptChange to ManuscriptField -- it has no use for it here, and this page cannot pass a raw function across the RSC boundary", () => {
    const manuscriptFieldBlock = source.match(/<ManuscriptField[\s\S]*?\/>/);
    expect(manuscriptFieldBlock).not.toBeNull();
    expect(manuscriptFieldBlock![0]).not.toContain("onManuscriptChange");
  });

  it("does not pass onCoverChange to CoverField either, for the same reason", () => {
    const coverFieldBlock = source.match(/<CoverField[\s\S]*?\/>/);
    expect(coverFieldBlock).not.toBeNull();
    expect(coverFieldBlock![0]).not.toContain("onCoverChange");
  });
});
