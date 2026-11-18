import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { readFileSync } from "fs";
import path from "path";

// Blog categories (2026-11-17): the /blog/kategoria/[slug] page. Same
// direct-invocation pattern as ../../page.test.ts: mocked Supabase
// client, React tree walked with plain-function components invoked.
function walk(node: unknown, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (typeof node !== "object") return;
  const element = node as ReactElement<Record<string, unknown>>;
  if (!("props" in element)) return;
  visit(element);
  if (typeof element.type === "function") {
    walk((element.type as (props: unknown) => unknown)(element.props), visit);
    return;
  }
  Object.values(element.props).forEach((value) => walk(value, visit));
}

function allText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(allText).join("");
  if (typeof node !== "object" || !("props" in (node as object))) return "";
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    return allText((element.type as (props: unknown) => unknown)(element.props));
  }
  return allText(element.props.children);
}

function hrefs(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (el) => {
    if (typeof el.props.href === "string") out.push(el.props.href as string);
  });
  return out;
}

const mockNotFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

const mockReturns = vi.fn();
const chain = {
  eq: vi.fn((): typeof chain => chain),
  order: vi.fn((): typeof chain => chain),
  range: vi.fn((): typeof chain => chain),
  returns: mockReturns,
};
const mockSelect = vi.fn((_columns: string, _opts?: unknown) => chain);
const mockFrom = vi.fn((_table: string) => ({ select: mockSelect }));
const mockGetPublicUrl = vi.fn((p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }));
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ from: mockFrom, storage: { from: () => ({ getPublicUrl: mockGetPublicUrl }) } }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: BlogCategoryPage, generateMetadata } = await import("./page");

function props(slug: string, faqe?: string | string[]) {
  return {
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve(faqe === undefined ? {} : { faqe }),
  };
}

function row(id: string, category = "zeja", isEditorial = false) {
  return {
    id,
    slug: id,
    title: `Post ${id}`,
    excerpt: "Excerpt",
    category,
    is_editorial: isEditorial,
    cover_image_path: null,
    published_at: "2026-11-01T00:00:00Z",
    status: "published",
    featured: false,
  };
}

beforeEach(() => {
  mockNotFound.mockClear();
  mockFrom.mockClear();
  mockSelect.mockClear();
  chain.eq.mockClear();
  chain.order.mockClear();
  chain.range.mockClear();
  mockReturns.mockReset().mockResolvedValue({ data: [], count: 0 });
});

describe("BlogCategoryPage", () => {
  it("an unknown category slug is a 404 with no DB call", async () => {
    await expect(BlogCategoryPage(props("writing"))).rejects.toThrow("NOT_FOUND");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "2.5", "abc", "01", ["2", "3"]])("a bad ?faqe=%s is a 404 with no DB call", async (faqe) => {
    await expect(BlogCategoryPage(props("zeja-e-shkrimit", faqe))).rejects.toThrow("NOT_FOUND");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("page 1 queries published posts of this category only, newest first, rows 0-11 with an exact count", async () => {
    mockReturns.mockResolvedValueOnce({ data: [row("a")], count: 1 });
    await BlogCategoryPage(props("zeja-e-shkrimit"));
    expect(mockFrom).toHaveBeenCalledWith("blog_posts");
    expect(mockSelect.mock.calls[0][1]).toEqual({ count: "exact" });
    expect(mockSelect.mock.calls[0][0]).not.toContain("content_markdown");
    expect(chain.eq).toHaveBeenCalledWith("status", "published");
    expect(chain.eq).toHaveBeenCalledWith("category", "zeja");
    expect(chain.order).toHaveBeenCalledWith("published_at", { ascending: false });
    expect(chain.range).toHaveBeenCalledWith(0, 11);
  });

  it("bs1 a: the Editorial page lists ticked posts (never category=editorial), each card naming its own category", async () => {
    mockReturns.mockResolvedValueOnce({ data: [row("ed", "tregu", true), row("plain", "tregu", false)], count: 2 });
    const page = await BlogCategoryPage(props("editorial"));
    expect(chain.eq).toHaveBeenCalledWith("is_editorial", true);
    expect(chain.eq).not.toHaveBeenCalledWith("category", "editorial");
    const links = hrefs(page);
    expect(links).toContain("/blog/ed");
    expect(links).not.toContain("/blog/plain");
    const text = allText(page);
    expect(text).toContain("Nga Librum");
    expect(text).toContain("Tregu i Librit & Botimet");
  });

  it("bs1 a: a category page also lists that category's Editorial posts", async () => {
    mockReturns.mockResolvedValueOnce({ data: [row("ed", "tregu", true)], count: 1 });
    const page = await BlogCategoryPage(props("tregu-i-librit-dhe-botimet"));
    expect(chain.eq).toHaveBeenCalledWith("category", "tregu");
    expect(hrefs(page)).toContain("/blog/ed");
  });

  it("bs6: the blog search box sits above the category buttons", () => {
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source.indexOf("<BlogSearchBox />")).toBeGreaterThan(-1);
    expect(source.indexOf("<BlogSearchBox />")).toBeLessThan(source.indexOf("<BlogCategoryButtons"));
  });

  it("page 2 asks for rows 12-23 and shows the page numbers with Më parë", async () => {
    mockReturns.mockResolvedValueOnce({ data: [row("m")], count: 13 });
    const page = await BlogCategoryPage(props("zeja-e-shkrimit", "2"));
    expect(chain.range).toHaveBeenCalledWith(12, 23);
    const links = hrefs(page);
    expect(links).toContain("/blog/kategoria/zeja-e-shkrimit");
    expect(links).toContain("/blog/kategoria/zeja-e-shkrimit?faqe=2");
    const text = allText(page);
    expect(text).toContain("Më parë");
    expect(text).not.toContain("Më pas");
  });

  it("a page past the last one is a 404", async () => {
    mockReturns.mockResolvedValueOnce({ data: null, count: null, error: { code: "PGRST103" } });
    await expect(BlogCategoryPage(props("zeja-e-shkrimit", "3"))).rejects.toThrow("NOT_FOUND");
  });

  it("an empty category keeps its page: heading, buttons and the coming-soon line, no page numbers", async () => {
    const page = await BlogCategoryPage(props("vleresimet-dhe-rekomandimet"));
    const text = allText(page);
    expect(text).toContain("Vlerësimet & Rekomandimet");
    expect(text).toContain("Artikujt e parë po vijnë së shpejti.");
    expect(text).not.toContain("Më pas");
    expect(hrefs(page)).toContain("/blog");
  });

  it("12 posts on a page, with Më pas when there are more", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`p${i}`));
    mockReturns.mockResolvedValueOnce({ data: rows, count: 30 });
    const page = await BlogCategoryPage(props("zeja-e-shkrimit"));
    const links = hrefs(page);
    expect(links.filter((h) => /^\/blog\/p\d+$/.test(h))).toHaveLength(12);
    expect(links).toContain("/blog/kategoria/zeja-e-shkrimit?faqe=3");
    expect(allText(page)).toContain("Më pas");
  });

  it("Zeja and Tregu end with the publish button; reader categories and Editorial with Shfletoni librarinë", async () => {
    for (const [slug, href] of [
      ["zeja-e-shkrimit", "/signup?role=author"],
      ["tregu-i-librit-dhe-botimet", "/signup?role=author"],
      ["kulture-dhe-njohuri", "/librari"],
      ["reflektime-dhe-frymezim", "/librari"],
      ["vleresimet-dhe-rekomandimet", "/librari"],
      ["editorial", "/librari"],
    ] as const) {
      const page = await BlogCategoryPage(props(slug));
      expect(hrefs(page)).toContain(href);
    }
  });

  it("the active category button is marked aria-current=page", async () => {
    const page = await BlogCategoryPage(props("kulture-dhe-njohuri"));
    const current: string[] = [];
    walk(page, (el) => {
      if (el.props["aria-current"] === "page" && typeof el.props.href === "string") current.push(el.props.href as string);
    });
    expect(current).toContain("/blog/kategoria/kulture-dhe-njohuri");
    expect(current).not.toContain("/blog");
  });

  it("only uses the public request-scoped Supabase client", () => {
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toContain("supabase/admin");
    expect(source).toContain('from "@/lib/supabase/server"');
  });
});

describe("generateMetadata", () => {
  it("unknown slug or bad page: {}", async () => {
    expect(await generateMetadata(props("nope"))).toEqual({});
    expect(await generateMetadata(props("editorial", "x"))).toEqual({});
  });

  it("title, description and canonical per page", async () => {
    const one = await generateMetadata(props("zeja-e-shkrimit"));
    expect(one.title).toBe("Zeja e Shkrimit · Blog");
    expect(one.alternates?.canonical).toBe("http://localhost:3000/blog/kategoria/zeja-e-shkrimit");
    const two = await generateMetadata(props("zeja-e-shkrimit", "2"));
    expect(two.alternates?.canonical).toBe("http://localhost:3000/blog/kategoria/zeja-e-shkrimit?faqe=2");
  });
});
