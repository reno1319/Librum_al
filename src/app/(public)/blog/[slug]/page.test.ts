import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 BLOG-1D: mirrors this repo's established Server Component
// test pattern (see e.g. src/app/admin/(protected)/blog/[id]/preview/page.test.ts)
// -- direct invocation with a mocked Supabase client, walking the
// returned React element tree for structural assertions. React's
// cache() is confirmed (verified directly against the installed react
// package) to behave as a plain passthrough with no memoization when
// invoked outside an actual Server Component render, so calling
// generateMetadata() and the page component directly in separate test
// cases below is safe -- each simply re-invokes the loader.

// This page composes plain-function child components (BlogArticleCard,
// ArticleJsonLd) that a props-only traversal would never see the
// inside of -- an un-invoked function-component element is just
// {type: fn, props}, with the <script>/<Link> it eventually renders
// nowhere in that shape yet. walk() invokes any plain-function element
// type (BlogArticleCard, ArticleJsonLd -- both stateless, no hooks, safe
// to call directly) and recurses into its actual output; next/link's
// Link is a forwardRef *object*, not a plain function, so it is never
// invoked here -- only recursed into via its own props, which is what
// exposes its own href.
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
    const rendered = (element.type as (props: unknown) => unknown)(element.props);
    walk(rendered, visit);
    return;
  }
  Object.values(element.props).forEach((value) => walk(value, visit));
}

function findScriptHtml(node: unknown): string | null {
  let html: string | null = null;
  walk(node, (element) => {
    if (html !== null || element.type !== "script") return;
    const dangerous = element.props.dangerouslySetInnerHTML as { __html: string } | undefined;
    if (dangerous?.__html) html = dangerous.__html;
  });
  return html;
}

function collectLinkHrefs(node: unknown): string[] {
  const hrefs: string[] = [];
  walk(node, (element) => {
    if (typeof element.props.href === "string") hrefs.push(element.props.href as string);
  });
  return hrefs;
}

const mockNotFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

const mockMaybeSingle = vi.fn();
const mockReturns = vi.fn();
const chain = {
  eq: vi.fn((): typeof chain => chain),
  neq: vi.fn((): typeof chain => chain),
  order: vi.fn((): typeof chain => chain),
  limit: vi.fn((): typeof chain => chain),
  maybeSingle: mockMaybeSingle,
  returns: mockReturns,
};
const mockSelect = vi.fn((_columns: string) => chain);
const mockFrom = vi.fn((_table: string) => ({ select: mockSelect }));
const mockGetPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }));
const mockStorageFrom = vi.fn((_bucket: string) => ({ getPublicUrl: mockGetPublicUrl }));
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ from: mockFrom, storage: { from: mockStorageFrom } }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: BlogArticlePage, generateMetadata } = await import("./page");

const basePost = {
  id: "post-1",
  title: "How to Publish",
  slug: "how-to-publish",
  excerpt: "An excerpt about publishing your first ebook on Librum.",
  content_markdown: "# Heading\n\nSome reasonably long article content used for reading time.",
  cover_image_path: null as string | null,
  category: "publishing" as const,
  seo_title: null as string | null,
  seo_description: null as string | null,
  published_at: "2026-01-01T00:00:00Z" as string | null,
  updated_at: "2026-01-02T00:00:00Z",
};

beforeEach(() => {
  mockNotFound.mockClear();
  mockFrom.mockClear();
  mockSelect.mockClear();
  chain.eq.mockClear();
  chain.neq.mockClear();
  chain.order.mockClear();
  chain.limit.mockClear();
  mockMaybeSingle.mockReset();
  mockReturns.mockReset().mockResolvedValue({ data: [] });
  mockGetPublicUrl.mockClear();
});

describe("generateMetadata", () => {
  it("a missing or draft slug returns {} -- no private draft metadata is ever exposed publicly", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "missing-or-draft" }) });
    expect(metadata).toEqual({});
  });

  it("uses seo_title/seo_description when present, overriding title/excerpt", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { ...basePost, seo_title: "SEO Title", seo_description: "SEO description text." },
    });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: basePost.slug }) });
    expect(metadata.title).toBe("SEO Title");
    expect(metadata.description).toBe("SEO description text.");
  });

  it("falls back to title/excerpt when seo_title/seo_description are null", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost } });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: basePost.slug }) });
    expect(metadata.title).toBe(basePost.title);
    expect(metadata.description).toBe(basePost.excerpt);
  });

  it("sets alternates.canonical to the real article URL", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost } });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: basePost.slug }) });
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/blog/how-to-publish");
  });

  it("openGraph is type=article with publishedTime and modifiedTime from real stored timestamps", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost } });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: basePost.slug }) });
    const openGraph = metadata.openGraph as { type?: string; publishedTime?: string; modifiedTime?: string };
    expect(openGraph.type).toBe("article");
    expect(openGraph.publishedTime).toBe(basePost.published_at);
    expect(openGraph.modifiedTime).toBe(basePost.updated_at);
  });

  it("with a cover image: twitter card is summary_large_image and openGraph.images includes the resolved public URL", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost, cover_image_path: "covers/a.jpg" } });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: basePost.slug }) });
    const twitter = metadata.twitter as { card?: string };
    expect(twitter.card).toBe("summary_large_image");
    expect((metadata.openGraph as { images?: { url: string }[] }).images?.[0]?.url).toBe(
      "https://cdn.test/covers/a.jpg",
    );
  });

  it("without a cover image: twitter card falls back to summary, no images field", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost, cover_image_path: null } });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: basePost.slug }) });
    const twitter = metadata.twitter as { card?: string };
    expect(twitter.card).toBe("summary");
    expect((metadata.openGraph as { images?: unknown }).images).toBeUndefined();
  });
});

describe("BlogArticlePage", () => {
  it("a missing or draft slug results in notFound(), never a rendered page", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null });
    await expect(
      BlogArticlePage({ params: Promise.resolve({ slug: "missing-or-draft" }) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });

  it("a published slug renders successfully with correct JSON-LD: Article shape, Librum Editorial, correct URL", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost } });
    mockReturns.mockResolvedValueOnce({ data: [] });

    const page = await BlogArticlePage({ params: Promise.resolve({ slug: basePost.slug }) });
    const html = findScriptHtml(page);
    expect(html).not.toBeNull();
    const jsonLd = JSON.parse(html!.replace(/\\u003c/g, "<"));

    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@type"]).toBe("Article");
    expect(jsonLd.headline).toBe(basePost.title);
    expect(jsonLd.description).toBe(basePost.excerpt);
    expect(jsonLd.datePublished).toBe(basePost.published_at);
    expect(jsonLd.dateModified).toBe(basePost.updated_at);
    expect(jsonLd.author).toEqual({ "@type": "Organization", name: "Librum Editorial" });
    expect(jsonLd.publisher).toEqual({ "@type": "Organization", name: "Librum" });
    expect(jsonLd.mainEntityOfPage).toEqual({
      "@type": "WebPage",
      "@id": "http://localhost:3000/blog/how-to-publish",
    });
  });

  it("safely escapes a literal '<' in article text so the JSON-LD script tag can never be prematurely closed", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { ...basePost, excerpt: "Careful with </script><script>alert(1)</script> tags." },
    });
    mockReturns.mockResolvedValueOnce({ data: [] });

    const page = await BlogArticlePage({ params: Promise.resolve({ slug: basePost.slug }) });
    const html = findScriptHtml(page);
    expect(html).not.toBeNull();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).toContain("\\u003cscript>");
    expect(html).toContain("\\u003c/script>");

    const jsonLd = JSON.parse(html!.replace(/\\u003c/g, "<"));
    expect(jsonLd.description).toBe("Careful with </script><script>alert(1)</script> tags.");
  });

  it("related reading queries status=published, the same category, excludes the current post id, ordered newest first, limited to 3", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost } });
    mockReturns.mockResolvedValueOnce({ data: [] });

    await BlogArticlePage({ params: Promise.resolve({ slug: basePost.slug }) });

    expect(chain.eq).toHaveBeenCalledWith("status", "published");
    expect(chain.eq).toHaveBeenCalledWith("category", basePost.category);
    expect(chain.neq).toHaveBeenCalledWith("id", basePost.id);
    expect(chain.order).toHaveBeenCalledWith("published_at", { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(3);
  });

  it("renders related-post links only for published, same-category, non-current posts returned", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost } });
    mockReturns.mockResolvedValueOnce({
      data: [
        {
          id: "post-2",
          slug: "related-one",
          title: "Related One",
          excerpt: "E",
          category: "publishing",
          cover_image_path: null,
          published_at: "2026-01-03T00:00:00Z",
          status: "published",
          featured: false,
        },
      ],
    });

    const page = await BlogArticlePage({ params: Promise.resolve({ slug: basePost.slug }) });
    const hrefs = collectLinkHrefs(page);
    expect(hrefs).toContain("/blog/related-one");
  });

  it("never selects * anywhere -- only explicit columns, and content_markdown is only requested by the single detail query", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...basePost } });
    mockReturns.mockResolvedValueOnce({ data: [] });

    await BlogArticlePage({ params: Promise.resolve({ slug: basePost.slug }) });

    for (const call of mockSelect.mock.calls) {
      const selectArg = call[0] as string;
      expect(selectArg).not.toContain("*");
    }
    const contentSelects = mockSelect.mock.calls.filter((call) => (call[0] as string).includes("content_markdown"));
    expect(contentSelects).toHaveLength(1);
  });

  it("only ever uses the public/request-scoped Supabase client -- no admin/service-role client is imported", () => {
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toContain("supabase/admin");
    expect(source).not.toContain("createAdminClient");
    expect(source).toContain('from "@/lib/supabase/server"');
  });
});
