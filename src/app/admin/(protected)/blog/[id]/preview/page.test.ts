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
        category: "writing",
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
        category: "writing",
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
        category: "writing",
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
