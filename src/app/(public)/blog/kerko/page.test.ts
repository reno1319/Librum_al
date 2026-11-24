import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { readFileSync } from "fs";
import path from "path";

// Blog search results (bs5/bs6): /blog/kerko?q=. Same direct-invocation
// pattern as the other blog page tests: mocked Supabase client, React
// tree walked with plain-function components invoked.
function walk(node: unknown, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    walk((element.type as (p: unknown) => unknown)(element.props), visit);
    return;
  }
  visit(element);
  walk(element.props?.children, visit);
}
function allText(node: unknown): string {
  const parts: string[] = [];
  const collect = (n: unknown): void => {
    if (typeof n === "string" || typeof n === "number") parts.push(String(n));
    else if (Array.isArray(n)) n.forEach(collect);
  };
  walk(node, (el) => collect(el.props?.children));
  return parts.join("");
}
function hrefs(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (el) => {
    if (typeof el.props.href === "string") out.push(el.props.href as string);
  });
  return out;
}

const mockRpc = vi.fn();
const mockReturns = vi.fn();
const chain = {
  eq: vi.fn((): typeof chain => chain),
  lte: vi.fn((): typeof chain => chain),
  in: vi.fn((): typeof chain => chain),
  returns: mockReturns,
};
const mockSelect = vi.fn((_columns: string) => chain);
const mockFrom = vi.fn((_table: string) => ({ select: mockSelect }));
const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    rpc: mockRpc,
    from: mockFrom,
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
// Patch B: the categories come from blog_categories; these tests use the
// six rows the migration inserts.
vi.mock("@/lib/blog-categories-server", async () => {
  const { SEEDED_BLOG_CATEGORIES } = await import("@/lib/blog-categories.fixture");
  return { getBlogCategories: async () => SEEDED_BLOG_CATEGORIES };
});

const { default: BlogSearchPage, metadata } = await import("./page");

function props(q?: string | string[]) {
  return { searchParams: Promise.resolve(q === undefined ? {} : { q }) };
}
function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    title: `Post ${id}`,
    excerpt: "Excerpt",
    category: "tregu",
    is_editorial: false,
    cover_image_path: null,
    published_at: "2026-11-01T00:00:00Z",
    status: "published",
    featured: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockRpc.mockReset().mockResolvedValue({ data: [], error: null });
  mockReturns.mockReset().mockResolvedValue({ data: [] });
  mockFrom.mockClear();
  mockSelect.mockClear();
  chain.eq.mockClear();
  chain.in.mockClear();
});

describe("BlogSearchPage", () => {
  it("is not indexed by search engines", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("no ?q=: asks for a word, no database call", async () => {
    const page = await BlogSearchPage(props());
    expect(allText(page)).toContain("Shkruani një fjalë për të kërkuar artikujt e blogut.");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls search_blog_posts with the cleaned words and a limit of 30", async () => {
    await BlogSearchPage(props("  vetë-botim  %  "));
    expect(mockRpc).toHaveBeenCalledWith("search_blog_posts", { search_term: "vetë-botim", result_limit: 30 });
  });

  it("no match: the empty line with the reader's text and a link back to /blog", async () => {
    const page = await BlogSearchPage(props("poezi dimri"));
    expect(allText(page)).toContain("Asnjë artikull nuk u gjet për «poezi dimri».");
    expect(hrefs(page)).toContain("/blog");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("matches: reads the rows back (published only) and keeps the search's own order", async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ post_id: "b" }, { post_id: "a" }], error: null });
    mockReturns.mockResolvedValueOnce({
      data: [row("a"), row("b", { is_editorial: true }), row("x-draft", { status: "draft" })],
    });
    const page = await BlogSearchPage(props("botim"));
    expect(chain.eq).toHaveBeenCalledWith("status", "published");
    // e3: never a scheduled article whose time is still ahead.
    expect(chain.lte).toHaveBeenCalledWith("published_at", expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(chain.in).toHaveBeenCalledWith("id", ["b", "a"]);
    expect(mockSelect.mock.calls[0][0]).not.toContain("content_markdown");
    expect(mockSelect.mock.calls[0][0]).not.toContain("keywords");
    const links = hrefs(page).filter((h) => h.startsWith("/blog/") && h !== "/blog/kerko");
    expect(links).toEqual(["/blog/b", "/blog/a"]);
    const text = allText(page);
    expect(text).toContain("2 artikuj për «botim»");
    expect(text).toContain("Editorial");
    expect(text).not.toContain("Nga Librum");
  });

  it("one match says '1 artikull'", async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ post_id: "a" }], error: null });
    mockReturns.mockResolvedValueOnce({ data: [row("a")] });
    expect(allText(await BlogSearchPage(props("botim")))).toContain("1 artikull për «botim»");
  });

  it("the box keeps the reader's text; it searches the blog only (GET /blog/kerko)", () => {
    const box = readFileSync(path.join(__dirname, "../../../../components/blog-search-box.tsx"), "utf8");
    expect(box).toContain('action="/blog/kerko"');
    expect(box).toContain('method="get"');
    expect(box).toContain('name="q"');
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).toContain("<BlogSearchBox defaultValue={display} />");
    expect(source).not.toContain("supabase/admin");
  });
});
