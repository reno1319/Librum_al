import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BECOME-AUTHOR-1: the dashboard boundary sends a reader to the
// become-author section of /account, an author through, and every other
// role home -- it never lets a non-author in.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  // FIX STEP F2: the layout renders the dashboard menu, which reads the
  // current path.
  usePathname: () => "/dashboard/sales",
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

let role: unknown;
let accountKind: unknown = "person";
const selects: string[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({
      select: (columns: string) => {
        selects.push(columns);
        return {
          eq: () => ({
            single: async () => ({ data: role === undefined ? null : { role, account_kind: accountKind } }),
          }),
        };
      },
    }),
  }),
}));

const { default: DashboardLayout } = await import("./layout");

async function run(): Promise<string> {
  try {
    await DashboardLayout({ children: null });
    return "rendered";
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
}

describe("DashboardLayout role boundary", () => {
  beforeEach(() => {
    role = undefined;
    accountKind = "person";
  });

  it("lets an author through", async () => {
    role = "author";
    expect(await run()).toBe("rendered");
  });

  it("sends a reader to the become-author section of their account", async () => {
    role = "reader";
    expect(await run()).toBe("/account#become-author");
  });

  it.each(["admin", null, undefined, "Author"])("sends %s home", async (value) => {
    role = value;
    expect(await run()).toBe("/");
  });
});

// FIX STEP F2: the menu is rendered once, by this layout, above every
// dashboard page's own content.
describe("DashboardLayout menu", () => {
  it("renders the dashboard menu before the page", async () => {
    role = "author";
    const element = await DashboardLayout({ children: "PAGE-CONTENT" });
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    const menuAt = html.indexOf('<nav aria-label="Paneli"');
    expect(menuAt).toBeGreaterThanOrEqual(0);
    expect(menuAt).toBeLessThan(html.indexOf("PAGE-CONTENT"));
    expect(html.match(/<nav aria-label="Paneli"/g)).toHaveLength(1);
    expect(html).toContain('<div class="page-container pt-5 sm:pt-10"><nav');
  });
});

// BUILD 2a-2: a publishing house's menu has Profili > Autorët; a
// person author's menu does not.
describe("DashboardLayout house menu", () => {
  async function html(): Promise<string> {
    const element = await DashboardLayout({ children: null });
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  it("reads the account kind with the role", async () => {
    role = "author";
    selects.length = 0;
    await html();
    expect(selects).toEqual(["role, account_kind"]);
  });

  it("a house sees Autorët in its menu", async () => {
    role = "author";
    accountKind = "publishing_house";
    expect(await html()).toContain('href="/dashboard/authors"');
  });

  it("a person author does not", async () => {
    role = "author";
    accountKind = "person";
    expect(await html()).not.toContain("/dashboard/authors");
  });
});
