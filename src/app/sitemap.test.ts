import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 BLOG-1D: sitemap() became async once it gained its first
// dynamic, DB-backed entries (every published /blog/[slug]) -- the
// Supabase client is mocked here the same way every other public-data
// test in this codebase mocks it, rather than hitting a real database.
const mockReturns = vi.fn();
const mockEq = vi.fn(() => ({ returns: mockReturns }));
const mockSelect = vi.fn((_columns: string) => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockCreateClient = vi.fn(() => Promise.resolve({ from: mockFrom }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: sitemap } = await import("./sitemap");

describe("sitemap", () => {
  beforeEach(() => {
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEq.mockClear();
    mockReturns.mockReset().mockResolvedValue({
      data: [
        { slug: "how-to-publish", updated_at: "2026-01-15T00:00:00Z" },
        { slug: "what-is-isbn", updated_at: "2026-02-01T00:00:00Z" },
      ],
    });
  });

  it("includes every static public/marketing route", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
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

  it("includes /blog itself", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).toContain("/blog");
  });

  it("includes every published /blog/[slug] with its real updated_at as lastModified", async () => {
    const entries = await sitemap();
    const blogEntry = entries.find((e) => new URL(e.url).pathname === "/blog/how-to-publish");
    expect(blogEntry).toBeDefined();
    expect(blogEntry?.lastModified).toEqual(new Date("2026-01-15T00:00:00Z"));

    const secondEntry = entries.find((e) => new URL(e.url).pathname === "/blog/what-is-isbn");
    expect(secondEntry).toBeDefined();
  });

  it("queries only status='published' -- drafts are filtered at the query level, matching every other public Blog query", async () => {
    await sitemap();
    expect(mockEq).toHaveBeenCalledWith("status", "published");
  });

  it("selects only slug and updated_at -- never article bodies", async () => {
    await sitemap();
    const selectArg = mockSelect.mock.calls[0][0];
    expect(selectArg).not.toContain("*");
    expect(selectArg).not.toContain("content_markdown");
    expect(selectArg).toContain("slug");
    expect(selectArg).toContain("updated_at");
  });

  it("never includes the retired /products or /program placeholders", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).not.toContain("/products");
    expect(paths).not.toContain("/program");
  });

  it("never includes any authenticated/private route", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    for (const path of paths) {
      expect(path.startsWith("/dashboard")).toBe(false);
      expect(path.startsWith("/account")).toBe(false);
      expect(path.startsWith("/admin")).toBe(false);
      expect(path.startsWith("/library")).toBe(false);
      expect(path.startsWith("/wishlist")).toBe(false);
      expect(path.startsWith("/following")).toBe(false);
    }
  });

  it("never includes an auth-flow route", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    for (const path of paths) {
      expect(path.startsWith("/login")).toBe(false);
      expect(path.startsWith("/signup")).toBe(false);
      expect(path.startsWith("/forgot-password")).toBe(false);
      expect(path.startsWith("/reset-password")).toBe(false);
    }
  });

  it("produces absolute, well-formed URLs", async () => {
    const entries = await sitemap();
    for (const entry of entries) {
      expect(() => new URL(entry.url)).not.toThrow();
    }
  });

  it("with zero published posts, still includes /blog and no blog article entries", async () => {
    mockReturns.mockResolvedValueOnce({ data: [] });
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).toContain("/blog");
    expect(paths.filter((p) => p.startsWith("/blog/"))).toHaveLength(0);
  });
});
