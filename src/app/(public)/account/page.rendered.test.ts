import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ALBANIAN-7 (SQ-7 audit N1): the Become-an-author text keeps a space
// before the reader's name (a JSX line break would drop it).

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "reader@example.com" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { display_name: "Ana", role: "reader" } }) }),
      }),
    }),
  }),
}));
vi.mock("@/app/(public)/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("./actions", () => ({ deleteAccount: vi.fn() }));
vi.mock("./become-author", () => ({ becomeAuthor: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { default: AccountPage } = await import("./page");

describe("Account page, Become an author box", () => {
  it("keeps the space before the reader's name", async () => {
    const html = renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('do të jetë fillimisht <span class="font-medium text-foreground">Ana</span>;');
    expect(html).not.toContain("fillimisht<span");
  });
});
