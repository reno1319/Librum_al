import { describe, expect, it } from "vitest";
import robots from "./robots";

// LIBRUM 2.0 LAUNCH-FIX-1A SEO-2: robots() is a plain, dependency-light
// function (no Next.js runtime machinery to fake) -- called directly,
// not through any Next internals.
describe("robots", () => {
  const result = robots();
  const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;

  it("allows public crawling by default", () => {
    expect(rule.allow).toBe("/");
  });

  it("disallows every private/authenticated surface", () => {
    const disallowed = rule.disallow;
    for (const path of [
      "/dashboard",
      "/account",
      "/admin",
      "/auth/",
      "/library",
      "/wishlist",
      "/following",
      "/login",
      "/signup",
      "/forgot-password",
      "/reset-password",
    ]) {
      expect(disallowed).toContain(path);
    }
  });

  it("does not disallow public discovery routes", () => {
    const disallowed = rule.disallow as string[];
    for (const path of ["/bookstore", "/books", "/authors", "/series", "/bundles"]) {
      expect(disallowed.some((d) => path.startsWith(d))).toBe(false);
    }
  });

  it("points at a sitemap URL", () => {
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
  });
});
