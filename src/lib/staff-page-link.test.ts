import { describe, expect, it } from "vitest";
import { resolveStaffPageLink } from "./staff-page-link";

const ALL = { canWritePosts: true, canViewBooks: true };

describe("resolveStaffPageLink (dashboard batch 2)", () => {
  it("a blog article: Ndrysho to the open-by-address route", () => {
    expect(resolveStaffPageLink("/blog/si-ta-shkruash", ALL)).toEqual({
      href: "/admin/blog/open/si-ta-shkruash",
      label: "Ndrysho",
    });
  });

  it("a book page: Faqja e stafit to the staff book page, never Ndrysho", () => {
    expect(resolveStaffPageLink("/libra/c0000000-0000-4000-8000-000000000001", ALL)).toEqual({
      href: "/admin/books/c0000000-0000-4000-8000-000000000001",
      label: "Faqja e stafit",
    });
  });

  it("each link needs its own permission", () => {
    expect(resolveStaffPageLink("/blog/x", { canWritePosts: false, canViewBooks: true })).toBeNull();
    expect(resolveStaffPageLink("/libra/x", { canWritePosts: true, canViewBooks: false })).toBeNull();
  });

  it("no link on non-article blog pages, sub-pages, or anywhere else", () => {
    for (const path of [
      "/",
      "/blog",
      "/blog/kerko",
      "/blog/kategoria",
      "/blog/kategoria/zeja-e-shkrimit",
      "/libra/x/report",
      "/librari",
      "/autore/x",
      "/admin/blog/x",
      "",
    ]) {
      expect(resolveStaffPageLink(path, ALL), path).toBeNull();
    }
  });

  it("re-encodes the segment and survives a malformed one", () => {
    expect(resolveStaffPageLink("/blog/a%20b", ALL)?.href).toBe("/admin/blog/open/a%20b");
    expect(resolveStaffPageLink("/blog/a%2Fb", ALL)?.href).toBe("/admin/blog/open/a%2Fb");
    expect(resolveStaffPageLink("/blog/%E0%A4%A", ALL)).toBeNull();
  });
});
