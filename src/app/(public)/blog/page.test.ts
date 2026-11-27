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

// One chain object per query, recording its own .eq() filters, so a
// test can answer the landing query and each band query separately
// (bandRows below). mockReturns answers the landing query (the one
// with no category filter); the band queries answer from bandRows.
let bandRows: Record<string, unknown[]> = {};
const mockReturns = vi.fn();
const mockLimit = vi.fn((_n: number) => undefined as unknown);
const mockOrder = vi.fn((_column: string, _opts: { ascending: boolean }) => undefined as unknown);
const mockEq = vi.fn((_column: string, _value: string | boolean) => undefined as unknown);
const mockLte = vi.fn((_column: string, _value: string) => undefined as unknown);
function makeChain() {
  const filters: Record<string, string | boolean> = {};
  const chain = {
    eq: (column: string, value: string | boolean) => {
      mockEq(column, value);
      filters[column] = value;
      return chain;
    },
    lte: (column: string, value: string) => {
      mockLte(column, value);
      return chain;
    },
    order: (column: string, opts: { ascending: boolean }) => {
      mockOrder(column, opts);
      return chain;
    },
    limit: (n: number) => {
      mockLimit(n);
      return chain;
    },
    // bs1: the Editorial band filters on is_editorial, the others on
    // category.
    returns: () =>
      filters.category === undefined && filters.is_editorial === undefined
        ? mockReturns()
        : Promise.resolve({
            data: bandRows[filters.is_editorial === true ? "editorial" : String(filters.category)] ?? [],
          }),
  };
  return chain;
}
const mockSelect = vi.fn((_columns: string) => makeChain());
const mockFrom = vi.fn((_table: string) => ({ select: mockSelect }));
const mockGetPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }));
const mockStorageFrom = vi.fn((_bucket: string) => ({ getPublicUrl: mockGetPublicUrl }));
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ from: mockFrom, storage: { from: mockStorageFrom } }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
// Patch B: the categories come from blog_categories; these tests use the
// six rows the migration inserts.
vi.mock("@/lib/blog-categories-server", async () => {
  const { SEEDED_BLOG_CATEGORIES } = await import("@/lib/blog-categories.fixture");
  return { getBlogCategories: async () => SEEDED_BLOG_CATEGORIES };
});

const { default: BlogIndexPage, generateMetadata } = await import("./page");

function candidate(overrides: Partial<{
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  is_editorial: boolean;
  cover_image_path: string | null;
  published_at: string;
  status: string;
  featured: boolean;
}> & { id: string }) {
  return {
    slug: overrides.id,
    title: `Post ${overrides.id}`,
    excerpt: "Excerpt",
    category: "zeja",
    is_editorial: false,
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
  bandRows = {};
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

  it("canonical points to /blog, OG type is website, large share card (S1 pb2 a)", () => {
    const metadata = generateMetadata();
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/blog");
    const openGraph = metadata.openGraph as { type?: string; images?: unknown };
    const twitter = metadata.twitter as { card?: string };
    expect(openGraph.type).toBe("website");
    expect(openGraph.images).toEqual([
      { url: "http://localhost:3000/opengraph-image.png", width: 1200, height: 630, alt: "librum. Vetëbotim për autorët që shkruajnë shqip" },
    ]);
    expect(twitter.card).toBe("summary_large_image");
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
    // e3: only articles whose go-live time has passed (also for staff).
    expect(mockLte).toHaveBeenCalledWith("published_at", expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
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
        candidate({ id: "featured-post", featured: true, category: "tregu", published_at: "2026-01-10T00:00:00Z" }),
        candidate({ id: "latest-post", category: "zeja", published_at: "2026-01-09T00:00:00Z" }),
      ],
    });

    const page = await BlogIndexPage();
    const hrefs = collectLinkHrefs(page);
    const text = collectText(page);

    expect(hrefs).toContain("/blog/featured-post");
    expect(hrefs).toContain("/blog/latest-post");
    expect(text).toContain("Tregu i Librit & Botimet");
    expect(hrefs).toContain("/signup?role=author");
    expect(hrefs).not.toContain("/librari");
  });

  it("shows the new intro and the category buttons: Të gjitha plus six short names, each linking to its category page", async () => {
    mockReturns.mockResolvedValueOnce({ data: [candidate({ id: "one" })] });
    const page = await BlogIndexPage();
    const text = collectText(page);
    const hrefs = collectLinkHrefs(page);
    expect(text).toContain("Shkrim, botim, kulturë dhe lexim");
    expect(text).not.toContain("vetëbotimit shqip");
    for (const label of ["Të gjitha", "Editorial", "Zeja e Shkrimit", "Botimet", "Kulturë", "Reflektime", "Vlerësime"]) {
      expect(text).toContain(label);
    }
    for (const slug of [
      "editorial",
      "zeja-e-shkrimit",
      "tregu-i-librit-dhe-botimet",
      "kulture-dhe-njohuri",
      "reflektime-dhe-frymezim",
      "vleresimet-dhe-rekomandimet",
    ]) {
      expect(hrefs).toContain(`/blog/kategoria/${slug}`);
    }
  });

  it("shows all six category bands from day one, Editorial first, with the coming-soon line in each empty one", async () => {
    mockReturns.mockResolvedValueOnce({ data: [candidate({ id: "only-zeja", category: "zeja" })] });
    bandRows = { zeja: [candidate({ id: "only-zeja", category: "zeja" })] };
    const page = await BlogIndexPage();
    const headings: string[] = [];
    walk(page, (el) => {
      if (el.type === "h2" && typeof el.props.id === "string") headings.push(el.props.children as string);
    });
    expect(headings).toEqual([
      "Editorial",
      "Zeja e Shkrimit",
      "Tregu i Librit & Botimet",
      "Kulturë & Njohuri",
      "Reflektime & Frymëzim",
      "Vlerësimet & Rekomandimet",
    ]);
    let emptyLines = 0;
    walk(page, (el) => {
      if (el.type === "p" && el.props.children === "Artikujt e parë po vijnë së shpejti.") emptyLines += 1;
    });
    expect(emptyLines).toBe(5);
  });

  it("each band has its own query: published, that category (Editorial: the tick), newest first, 3 rows", async () => {
    mockReturns.mockResolvedValueOnce({ data: [candidate({ id: "one" })] });
    await BlogIndexPage();
    for (const value of ["zeja", "tregu", "kultura", "reflektime", "vleresime"]) {
      expect(mockEq).toHaveBeenCalledWith("category", value);
    }
    expect(mockEq).not.toHaveBeenCalledWith("category", "editorial");
    expect(mockEq).toHaveBeenCalledWith("is_editorial", true);
    expect(mockLimit).toHaveBeenCalledWith(3);
    expect(mockLimit.mock.calls.filter((c) => c[0] === 3)).toHaveLength(6);
  });

  it("audit F1: a quiet category whose posts are older than the 50 newest still shows them, not the coming-soon line", async () => {
    mockReturns.mockResolvedValueOnce({
      data: Array.from({ length: 50 }, (_, i) =>
        candidate({ id: `new-${i}`, category: "zeja", published_at: "2026-11-01T00:00:00Z" }),
      ),
    });
    bandRows = {
      zeja: [candidate({ id: "new-0", category: "zeja" })],
      reflektime: [candidate({ id: "old-reflektime", category: "reflektime", published_at: "2025-01-01T00:00:00Z" })],
    };
    const page = await BlogIndexPage();
    expect(collectLinkHrefs(page)).toContain("/blog/old-reflektime");
    let emptyLines = 0;
    walk(page, (el) => {
      if (el.type === "p" && el.props.children === "Artikujt e parë po vijnë së shpejti.") emptyLines += 1;
    });
    expect(emptyLines).toBe(4);
  });

  it("a band row of another category or a draft is never shown in that band", async () => {
    mockReturns.mockResolvedValueOnce({ data: [candidate({ id: "one" })] });
    bandRows = {
      kultura: [
        candidate({ id: "wrong-cat", category: "zeja" }),
        candidate({ id: "draft-kultura", category: "kultura", status: "draft" }),
      ],
    };
    const hrefs = collectLinkHrefs(await BlogIndexPage());
    expect(hrefs).not.toContain("/blog/wrong-cat");
    expect(hrefs).not.toContain("/blog/draft-kultura");
  });

  it("an Editorial post's card carries the yellow Editorial tag AND its category name (bs1)", async () => {
    mockReturns.mockResolvedValueOnce({ data: [candidate({ id: "ed", category: "tregu", is_editorial: true })] });
    const text = collectText(await BlogIndexPage());
    expect(text).toContain("Editorial");
    expect(text).not.toContain("Nga Librum");
    expect(text).toContain("Tregu i Librit & Botimet");
  });

  it("bs1 a: an Editorial post shows in the Editorial band and in its own category's band", async () => {
    mockReturns.mockResolvedValueOnce({ data: [candidate({ id: "one" })] });
    const ed = candidate({ id: "ed-tregu", category: "tregu", is_editorial: true });
    bandRows = { editorial: [ed], tregu: [ed] };
    const hrefs = collectLinkHrefs(await BlogIndexPage());
    expect(hrefs.filter((h) => h === "/blog/ed-tregu")).toHaveLength(2);
  });

  it("an unticked post sent back for the Editorial band is never shown there", async () => {
    mockReturns.mockResolvedValueOnce({ data: [candidate({ id: "one" })] });
    bandRows = { editorial: [candidate({ id: "not-ticked", category: "tregu", is_editorial: false })] };
    expect(collectLinkHrefs(await BlogIndexPage())).not.toContain("/blog/not-ticked");
  });

  it("bs6: the blog search box (GET /blog/kerko, field q) sits above the category buttons", () => {
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source.indexOf("<BlogSearchBox />")).toBeGreaterThan(-1);
    expect(source.indexOf("<BlogSearchBox />")).toBeLessThan(source.indexOf("<BlogCategoryButtons"));
  });

  it("only ever uses the public/request-scoped Supabase client -- no admin/service-role client is imported", () => {
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toContain("supabase/admin");
    expect(source).not.toContain("createAdminClient");
    expect(source).toContain('from "@/lib/supabase/server"');
  });
});
