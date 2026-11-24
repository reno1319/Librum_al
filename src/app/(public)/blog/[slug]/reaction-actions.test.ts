import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`REDIRECT ${to}`);
  }
}
const mockRedirect = vi.fn((to: string) => {
  throw new RedirectSignal(to);
});
const mockRevalidatePath = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (to: string) => mockRedirect(to) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => mockRevalidatePath(p) }));

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, rpc: mockRpc }),
}));

const { toggleBlogReaction } = await import("./reaction-actions");

const POST = "0a6b1e9c-5d1f-4c2a-9b7e-3f4d5c6b7a80";

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  mockRedirect.mockClear();
  mockRevalidatePath.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "reader-1" } } });
  mockRpc.mockReset().mockResolvedValue({ data: true, error: null });
});

describe("toggleBlogReaction (BR1)", () => {
  it("calls the toggle function and returns to the reactions on the article", async () => {
    expect(await redirectOf(toggleBlogReaction(POST, "si-ta-shkruash", "helpful"))).toBe("/blog/si-ta-shkruash#reagime");
    expect(mockRpc).toHaveBeenCalledWith("toggle_blog_post_reaction", { p_post_id: POST, p_reaction: "helpful" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/blog/si-ta-shkruash");
  });

  it("signed out: to sign in, then back to the article; nothing saved", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await redirectOf(toggleBlogReaction(POST, "si-ta-shkruash", "like"))).toBe(
      "/login?next=%2Fblog%2Fsi-ta-shkruash",
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("a refused call shows the generic error on the article", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "toggle_blog_post_reaction: article not live" } });
    expect(await redirectOf(toggleBlogReaction(POST, "si-ta-shkruash", "like"))).toBe(
      `/blog/si-ta-shkruash?error=${encodeURIComponent("Diçka shkoi keq. Provoni përsëri.")}#reagime`,
    );
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["not-a-uuid", "si-ta-shkruash", "like"],
    [POST, "../admin", "like"],
    [POST, "Si-Ta", "like"],
    [POST, "si-ta-shkruash", "love"],
  ])("a bad value (%s, %s, %s) goes to /blog and never calls the database", async (postId, slug, reaction) => {
    expect(await redirectOf(toggleBlogReaction(postId, slug, reaction))).toBe("/blog");
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
