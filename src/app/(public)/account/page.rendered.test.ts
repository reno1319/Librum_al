import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ALBANIAN-7 (SQ-7 audit N1): the Become-an-author text keeps a space
// before the reader's name (a JSX line break would drop it).

let profileRow: Record<string, unknown> = { display_name: "Ana", role: "reader", account_kind: "person" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "reader@example.com" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: profileRow }) }),
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

// BUILD 2a-1 (pf3 a, h5 b): one card, Autor / Shtëpi botuese, the 18+
// tick for Autor only; the role line names a house.
describe("Account page, publishing house", () => {
  it("a reader gets one card with both choices, Autor first and chosen, and Vazhdoni", async () => {
    profileRow = { display_name: "Ana", role: "reader", account_kind: "person" };
    const html = renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('<input type="radio" name="become_as" checked="" value="author"/>');
    expect(html).toContain('<input type="radio" name="become_as" value="publishing_house"/>');
    expect(html).toContain("Shtëpi botuese: dua të shes librat e shtëpisë sime botuese");
    expect(html).toContain("Vazhdoni</button>");
    expect(html).not.toContain("Bëhuni autor</button>");
  });

  it("a house sees its role as Shtëpi botuese and no upgrade card", async () => {
    profileRow = { display_name: "Botime Test", role: "author", account_kind: "publishing_house" };
    const html = renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Shtëpi botuese</dd>");
    expect(html).not.toContain("become_as");
  });

  it("an ordinary author still reads Autor", async () => {
    profileRow = { display_name: "Ana", role: "author", account_kind: "person" };
    const html = renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Autor</dd>");
  });
});
