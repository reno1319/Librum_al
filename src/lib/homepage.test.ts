import { describe, expect, it } from "vitest";
import { resolveHomepageCta, computeAuthorSharePercent } from "./homepage";

describe("resolveHomepageCta", () => {
  it("logged out: hero and final both point at signup with author role intent", () => {
    const result = resolveHomepageCta({ user: null, role: null });

    expect(result.hero).toEqual({ label: "Publish your book", href: "/signup?role=author" });
    expect(result.final).toEqual({ label: "Publish your book", href: "/signup?role=author" });
  });

  it("author: hero goes to Dashboard, final goes to the create-book flow", () => {
    const result = resolveHomepageCta({ user: { id: "author-1" }, role: "author" });

    expect(result.hero).toEqual({ label: "Go to Dashboard", href: "/dashboard" });
    expect(result.final).toEqual({ label: "Start a new book", href: "/dashboard/books/new" });
  });

  it("reader: no publishing CTA anywhere on the page -- no reader -> author role conversion exists", () => {
    const result = resolveHomepageCta({ user: { id: "reader-1" }, role: "reader" });

    expect(result.hero).toBeNull();
    expect(result.final).toBeNull();
  });

  // LIBRUM 2.0 UI-3 pre-commit correction: the invariant is narrower
  // than "logged-out vs. author vs. reader" -- only role === "author"
  // exactly receives author CTAs. An authenticated user whose profile
  // role hasn't resolved yet (or never will) must fall to the same
  // no-CTA outcome as a known reader, not silently inherit the
  // logged-out signup CTA or any author affordance.
  it("authenticated user, role null (unresolved/missing profile role): no publishing CTA -- same as a known reader, never the logged-out signup CTA", () => {
    const result = resolveHomepageCta({ user: { id: "user-1" }, role: null });

    expect(result.hero).toBeNull();
    expect(result.final).toBeNull();
  });

  it("authenticated user, unexpected/unrecognized role string: no publishing CTA -- only an exact 'author' role receives author CTAs, role handling is not broadened to match loosely", () => {
    const result = resolveHomepageCta({ user: { id: "user-1" }, role: "admin" });

    expect(result.hero).toBeNull();
    expect(result.final).toBeNull();
  });
});

describe("computeAuthorSharePercent", () => {
  it("derives from PLATFORM_FEE_PERCENT, not a hardcoded literal", () => {
    expect(computeAuthorSharePercent()).toBe(80);
  });
});
