import { describe, expect, it } from "vitest";
import sitemap from "./sitemap";

// LIBRUM 2.0 LAUNCH-FIX-1A SEO-2: sitemap() is a plain function --
// called directly, not through any Next.js runtime machinery.
describe("sitemap", () => {
  const entries = sitemap();
  const paths = entries.map((entry) => new URL(entry.url).pathname);

  it("includes every static public/marketing route", () => {
    for (const path of [
      "/",
      "/about",
      "/how-it-works",
      "/pricing",
      "/bookstore",
      "/help",
      "/contact",
      "/terms",
      "/privacy",
    ]) {
      expect(paths).toContain(path);
    }
  });

  it("never includes the retired /products or /program placeholders", () => {
    expect(paths).not.toContain("/products");
    expect(paths).not.toContain("/program");
  });

  it("never includes any authenticated/private route", () => {
    for (const path of paths) {
      expect(path.startsWith("/dashboard")).toBe(false);
      expect(path.startsWith("/account")).toBe(false);
      expect(path.startsWith("/admin")).toBe(false);
      expect(path.startsWith("/library")).toBe(false);
      expect(path.startsWith("/wishlist")).toBe(false);
      expect(path.startsWith("/following")).toBe(false);
    }
  });

  it("never includes an auth-flow route", () => {
    for (const path of paths) {
      expect(path.startsWith("/login")).toBe(false);
      expect(path.startsWith("/signup")).toBe(false);
      expect(path.startsWith("/forgot-password")).toBe(false);
      expect(path.startsWith("/reset-password")).toBe(false);
    }
  });

  it("produces absolute, well-formed URLs", () => {
    for (const entry of entries) {
      expect(() => new URL(entry.url)).not.toThrow();
    }
  });
});
