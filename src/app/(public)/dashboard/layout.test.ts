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
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: role === undefined ? null : { role } }) }) }),
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
    const menuAt = html.indexOf('<nav aria-label="Dashboard"');
    expect(menuAt).toBeGreaterThanOrEqual(0);
    expect(menuAt).toBeLessThan(html.indexOf("PAGE-CONTENT"));
    expect(html.match(/<nav aria-label="Dashboard"/g)).toHaveLength(1);
    expect(html).toContain('<div class="page-container pt-5 sm:pt-10"><nav');
  });
});
