import { beforeEach, describe, expect, it, vi } from "vitest";

// Dashboard batch 2: /admin/blog/open/[slug] turns an article's address
// into its editor, behind the editor's own gate.
const mockRequireStaff = vi.fn(async (permission: string) => {
  void permission;
  return { userId: "staff-1", role: "editor" };
});
vi.mock("@/lib/staff", () => ({ requireStaff: (p: string) => mockRequireStaff(p) }));

let row: { id: string } | null = null;
const calls: { table: string; select: string; filters: [string, unknown][] }[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = { table, select: "", filters: [] as [string, unknown][] };
      calls.push(q);
      const chain = {
        select: (cols: string) => {
          q.select = cols;
          return chain;
        },
        eq: (col: string, value: unknown) => {
          q.filters.push([col, value]);
          return chain;
        },
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return chain;
    },
  }),
}));

class Redirect extends Error {
  constructor(public to: string) {
    super("redirect");
  }
}
class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new NotFound();
  },
}));

const { default: OpenBlogPostBySlug } = await import("./page");

describe("open blog post by address", () => {
  beforeEach(() => {
    calls.length = 0;
    mockRequireStaff.mockClear();
  });

  it("gates on blog.manage, then sends to the post's editor", async () => {
    row = { id: "b1" };
    await expect(OpenBlogPostBySlug({ params: Promise.resolve({ slug: "si-ta" }) })).rejects.toMatchObject({
      to: "/admin/blog/b1/edit",
    });
    expect(mockRequireStaff).toHaveBeenCalledWith("blog.manage");
    expect(calls).toEqual([{ table: "blog_posts", select: "id", filters: [["slug", "si-ta"]] }]);
  });

  it("an unknown address is a 404", async () => {
    row = null;
    await expect(OpenBlogPostBySlug({ params: Promise.resolve({ slug: "nope" }) })).rejects.toBeInstanceOf(NotFound);
  });

  it("checks the gate before reading anything", async () => {
    mockRequireStaff.mockRejectedValueOnce(new Error("denied"));
    await expect(OpenBlogPostBySlug({ params: Promise.resolve({ slug: "x" }) })).rejects.toThrow("denied");
    expect(calls).toHaveLength(0);
  });
});
