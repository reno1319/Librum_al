import { describe, expect, it, vi, beforeEach } from "vitest";

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockNotFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockMaybeSingle = vi.fn();
const mockEq = vi.fn((_column: string, _value: string) => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn((_columns: string) => ({ eq: mockEq }));
const mockFrom = vi.fn((_table: string) => ({ select: mockSelect }));
const mockGetPublicUrl = vi.fn(() => ({ data: { publicUrl: "https://example.test/cover.jpg" } }));
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

const { default: PreviewBlogPostPage } = await import("./page");

describe("PreviewBlogPostPage", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset().mockResolvedValue({ userId: "staff-1", role: "editor" });
    mockNotFound.mockClear();
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEq.mockClear();
    mockMaybeSingle.mockReset();
  });

  it("gates on requireStaff('blog.view')", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "post-1",
        title: "T",
        excerpt: "E",
        content_markdown: "Body",
        cover_image_path: null,
        category: "zeja",
        status: "draft",
        published_at: null,
      },
    });

    await PreviewBlogPostPage({ params: Promise.resolve({ id: "post-1" }) });
    expect(mockRequireStaff).toHaveBeenCalledWith("blog.view");
  });

  it("an unauthorized caller's requireStaff redirect propagates before any query runs", async () => {
    mockRequireStaff.mockImplementationOnce(() => {
      throw new RedirectSignal("/");
    });

    await expect(
      PreviewBlogPostPage({ params: Promise.resolve({ id: "post-1" }) }),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a draft post IS visible to authorized staff (never gated on status)", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "post-1",
        title: "Draft Title",
        excerpt: "Draft excerpt",
        content_markdown: "Draft body content.",
        cover_image_path: null,
        category: "zeja",
        status: "draft",
        published_at: null,
      },
    });

    const page = await PreviewBlogPostPage({ params: Promise.resolve({ id: "post-1" }) });
    // A successful, non-throwing render proves the draft resolved and
    // was rendered -- this page never applies its own "published only"
    // filter (that's the RLS policy's own job, already proven at the DB
    // layer by 047_blog_posts_rls.test.sql's Part 4).
    expect(page).toBeTruthy();
  });

  it("pv1 b: the byline matches the live page (typed name, else Librum on Editorial, else none)", async () => {
    const base = {
      id: "post-1",
      title: "T",
      excerpt: "E",
      content_markdown: "Body",
      cover_image_path: null,
      category: "zeja",
      status: "draft",
      published_at: null,
    };
    const text = async (data: Record<string, unknown>) => {
      mockMaybeSingle.mockResolvedValueOnce({ data });
      // Text of the page's own elements (children strings), joined.
      const collect = (node: unknown): string => {
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(collect).join("");
        if (node && typeof node === "object" && "props" in node) {
          return collect((node as { props: { children?: unknown } }).props.children);
        }
        return "";
      };
      return collect(await PreviewBlogPostPage({ params: Promise.resolve({ id: "post-1" }) }));
    };
    const named = await text({ ...base, is_editorial: true, author_name: "Arben Hoxha" });
    expect(named).toContain("Nga Arben Hoxha · ");
    expect(named).not.toContain("By Librum Editorial");
    expect(await text({ ...base, is_editorial: true, author_name: null })).toContain("Nga Librum · ");
    const none = await text({ ...base, is_editorial: false, author_name: null });
    expect(none).not.toContain("Nga ");
    expect(none).not.toContain("By Librum Editorial");
  });

  it("a missing post results in notFound(), not a crash", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null });

    await expect(
      PreviewBlogPostPage({ params: Promise.resolve({ id: "missing-id" }) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });

  it("never selects *, only explicit columns this page renders", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "post-1",
        title: "T",
        excerpt: "E",
        content_markdown: "Body",
        cover_image_path: null,
        category: "zeja",
        status: "draft",
        published_at: null,
      },
    });

    await PreviewBlogPostPage({ params: Promise.resolve({ id: "post-1" }) });

    const selectArg = mockSelect.mock.calls[0][0] as string;
    expect(selectArg).not.toContain("*");
    expect(selectArg).toContain("content_markdown");
  });
});
