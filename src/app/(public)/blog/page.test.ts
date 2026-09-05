import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 BLOG-1D: same walk()-based traversal as
// src/app/(public)/blog/[slug]/page.test.ts's own header comment
// explains -- this page also composes plain-function child components
// (BlogArticleCard) that must be invoked, not merely inspected, to
// reach the <Link>/text they eventually render.
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

function collectLinkHrefs(node: unknown): string[] {
  const hrefs: string[] = [];
  walk(node, (element) => {
    if (typeof element.props.href === "string") hrefs.push(element.props.href as string);
  });
  return hrefs;
}

function collectText(node: unknown): string {
  let text = "";
  walk(node, (element) => {
    const children = element.props.children;
    if (typeof children === "string") text += children;
    if (typeof children === "number") text += String(children);
  });
  return text;
}

const mockReturns = vi.fn();
const mockLimit = vi.fn((_n: number) => ({ returns: mockReturns }));
const mockOrder = vi.fn((_column: string, _opts: { ascending: boolean }) => ({ limit: mockLimit }));
const mockEq = vi.fn((_column: string, _value: string) => ({ order: mockOrder }));
const mockSelect = vi.fn((_columns: string) => ({ eq: mockEq }));
const mockFrom = vi.fn((_table: string) => ({ select: mockSelect }));
const mockGetPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }));
const mockStorageFrom = vi.fn((_bucket: string) => ({ getPublicUrl: mockGetPublicUrl }));
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ from: mockFrom, storage: { from: mockStorageFrom } }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: BlogIndexPage, generateMetadata } = await import("./page");

function candidate(overrides: Partial<{
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  cover_image_path: string | null;
  published_at: string;
  status: string;
  featured: boolean;
}> & { id: string }) {
  return {
    slug: overrides.id,
    title: `Post ${overrides.id}`,
    excerpt: "Excerpt",
    category: "writing",
    cover_image_path: null,
    published_at: "2026-01-01T00:00:00Z",
    status: "published",
    featured: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockFrom.mockClear();
  mockSelect.mockClear();
  mockEq.mockClear();
  mockOrder.mockClear();
  mockLimit.mockClear();
  mockReturns.mockReset().mockResolvedValue({ data: [] });
  mockGetPublicUrl.mockClear();
});

describe("generateMetadata", () => {
  it("title is 'Blog', description is non-empty, no DB call is made", () => {
    const metadata = generateMetadata();
    expect(metadata.title).toBe("Blog");
    expect(typeof metadata.description).toBe("string");
    expect((metadata.description as string).length).toBeGreaterThan(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("canonical points to /blog, OG type is website, twitter card is summary", () => {
    const metadata = generateMetadata();
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/blog");
    const openGraph = metadata.openGraph as { type?: string };
    const twitter = metadata.twitter as { card?: string };
    expect(openGraph.type).toBe("website");
    expect(twitter.card).toBe("summary");
  });
});

describe("BlogIndexPage", () => {
  it("with zero published posts, shows an intentional empty state and no CTA -- launch-safe before any content exists", async () => {
    mockReturns.mockResolvedValueOnce({ data: [] });
    const page = await BlogIndexPage();
    const text = collectText(page);
    expect(text).toContain("Artikujt e parë po vijnë së shpejti.");
    expect(collectLinkHrefs(page)).not.toContain("/signup?role=author");
  });

  it("queries only status=published, ordered by published_at descending, bounded by the landing candidate limit", async () => {
    await BlogIndexPage();
    expect(mockEq).toHaveBeenCalledWith("status", "published");
    expect(mockOrder).toHaveBeenCalledWith("published_at", { ascending: false });
    expect(mockLimit).toHaveBeenCalledWith(50);
  });

  it("never selects * -- explicit columns only, never content_markdown", async () => {
    await BlogIndexPage();
    const selectArg = mockSelect.mock.calls[0][0] as string;
    expect(selectArg).not.toContain("*");
    expect(selectArg).not.toContain("content_markdown");
  });

  it("a draft-status row is never rendered even if it were present in the query result -- defense in depth beyond the status='published' query filter", async () => {
    mockReturns.mockResolvedValueOnce({
      data: [
        candidate({ id: "draft-post", status: "draft", featured: true }),
        candidate({ id: "published-post", published_at: "2026-01-05T00:00:00Z" }),
      ],
    });

    const page = await BlogIndexPage();
    const hrefs = collectLinkHrefs(page);
    expect(hrefs).not.toContain("/blog/draft-post");
    expect(hrefs).toContain("/blog/published-post");
  });

  it("renders a featured section, a Latest section, and category sections with Albanian public labels, plus a final CTA, when posts exist", async () => {
    mockReturns.mockResolvedValueOnce({
      data: [
        candidate({ id: "featured-post", featured: true, category: "publishing", published_at: "2026-01-10T00:00:00Z" }),
        candidate({ id: "latest-post", category: "writing", published_at: "2026-01-09T00:00:00Z" }),
      ],
    });

    const page = await BlogIndexPage();
    const hrefs = collectLinkHrefs(page);
    const text = collectText(page);

    expect(hrefs).toContain("/blog/featured-post");
    expect(hrefs).toContain("/blog/latest-post");
    expect(text).toContain("Botimi");
    expect(hrefs).toContain("/signup?role=author");
  });

  it("only ever uses the public/request-scoped Supabase client -- no admin/service-role client is imported", () => {
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toContain("supabase/admin");
    expect(source).not.toContain("createAdminClient");
    expect(source).toContain('from "@/lib/supabase/server"');
  });
});
